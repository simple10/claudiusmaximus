# 04 - VPS-1 OpenClaw Setup

Install and configure OpenClaw gateway on VPS-1.

## Overview

This playbook configures:
- Sysbox runtime for secure container-in-container
- Docker networks for OpenClaw
- Directory structure and permissions
- OpenClaw repository and configuration
- Docker Compose with security hardening
- Promtail for log shipping

## Prerequisites

- [01-base-setup.md](01-base-setup.md) completed on VPS-1
- [02-wireguard.md](02-wireguard.md) completed (tunnel active)
- [03-docker.md](03-docker.md) completed on VPS-1
- SSH access as `adminclaw` on port 222

## Variables

From `../openclaw-config.env`:
- `ANTHROPIC_API_KEY` - Required for OpenClaw
- `TELEGRAM_BOT_TOKEN` - Optional
- `DISCORD_BOT_TOKEN` - Optional
- `SUBPATH_OPENCLAW` - URL subpath for the gateway UI (default: `/_openclaw`)

---

## 4.1 Install Sysbox Runtime

Sysbox enables running Docker-in-Docker securely for OpenClaw sandboxes.

```bash
#!/bin/bash
# Download Sysbox (check https://github.com/nestybox/sysbox/releases for latest version)
wget https://downloads.nestybox.com/sysbox/releases/v0.6.4/sysbox-ce_0.6.4-0.linux_amd64.deb

# Install dependencies
sudo apt install -y jq fuse

# Install Sysbox
sudo dpkg -i sysbox-ce_0.6.4-0.linux_amd64.deb

# Verify installation
sudo systemctl status sysbox

# Verify runtime is available
sudo docker info | grep -i "sysbox"

# Cleanup
rm sysbox-ce_0.6.4-0.linux_amd64.deb
```

---

## 4.2 Create Docker Networks

```bash
#!/bin/bash
# IMPORTANT: Use 172.30.x.x subnets to avoid conflicts with Docker's default bridge (172.20.0.0/16)

# Gateway network (for OpenClaw)
docker network create \
    --driver bridge \
    --subnet 172.30.0.0/24 \
    openclaw-gateway-net

# Sandbox network (internal only, for sandboxes)
docker network create \
    --driver bridge \
    --internal \
    --subnet 172.31.0.0/24 \
    openclaw-sandbox-net
```

---

## 4.3 Create Directory Structure

```bash
#!/bin/bash
# Create directories as openclaw user
sudo -u openclaw bash << 'EOF'
OPENCLAW_HOME="/home/openclaw"

mkdir -p "${OPENCLAW_HOME}/openclaw"
mkdir -p "${OPENCLAW_HOME}/.openclaw/workspace"
mkdir -p "${OPENCLAW_HOME}/.openclaw/credentials"
mkdir -p "${OPENCLAW_HOME}/.openclaw/logs"
mkdir -p "${OPENCLAW_HOME}/.openclaw/backups"
mkdir -p "${OPENCLAW_HOME}/scripts"

chmod 700 "${OPENCLAW_HOME}/.openclaw"
chmod 700 "${OPENCLAW_HOME}/.openclaw/credentials"
EOF

# IMPORTANT: Container runs as uid 1000 (node user), which is typically 'ubuntu' on the host
# Change ownership of .openclaw to uid 1000 for container write access
sudo chown -R 1000:1000 /home/openclaw/.openclaw
```

---

## 4.4 Clone OpenClaw Repository

```bash
#!/bin/bash
sudo -u openclaw bash << 'EOF'
cd /home/openclaw
git clone https://github.com/openclaw/openclaw.git openclaw
EOF
```

---

## 4.5 Create Environment File

```bash
#!/bin/bash
# Generate gateway token
GATEWAY_TOKEN=$(openssl rand -hex 32)
GRAFANA_PASSWORD=$(openssl rand -base64 16)

# Get API keys from config (set these variables before running)
# ANTHROPIC_API_KEY=sk-ant-...
# TELEGRAM_BOT_TOKEN=...
# DISCORD_BOT_TOKEN=...

sudo -u openclaw tee /home/openclaw/openclaw/.env << EOF
# Gateway authentication
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}

# Model provider
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

# Channels (add as needed)
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}

# Grafana password for monitoring
GRAFANA_PASSWORD=${GRAFANA_PASSWORD}

# Docker compose variables (required by repo's docker-compose.yml)
OPENCLAW_CONFIG_DIR=/home/openclaw/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/openclaw/.openclaw/workspace
# Bind to 0.0.0.0 so cloudflared can reach the gateway on localhost
# Also allows direct access via WireGuard for debugging
OPENCLAW_GATEWAY_PORT=0.0.0.0:18789
OPENCLAW_BRIDGE_PORT=0.0.0.0:18790
OPENCLAW_GATEWAY_BIND=lan

# OTEL per-signal routing (each signal goes to its backend on VPS-2)
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://10.0.0.2:4318/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://10.0.0.2:9090/api/v1/otlp/v1/metrics
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://10.0.0.2:3100/otlp/v1/logs

# Extra apt packages baked into gateway image at build time (space-separated)
OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential imagemagick"
EOF

sudo chmod 600 /home/openclaw/openclaw/.env
sudo chown openclaw:openclaw /home/openclaw/openclaw/.env

echo ""
echo "========================================="
echo "Generated Credentials (save these):"
echo "  Gateway Token: ${GATEWAY_TOKEN}"
echo "  Grafana Password: ${GRAFANA_PASSWORD}"
echo "========================================="
```

---

## 4.6 Create Docker Compose Override

The OpenClaw repo includes a docker-compose.yml. Create an override file to add security hardening and monitoring services. Building happens separately via the build script (section 4.8a), not via `docker compose build`.

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/openclaw/docker-compose.override.yml << 'EOF'
services:
  openclaw-gateway:
    # Image built by scripts/build-openclaw.sh (not by docker compose build)
    image: openclaw:local
    container_name: openclaw-gateway
    runtime: sysbox-runc

    # read_only: false required for Docker-in-Docker — Sysbox auto-provisions
    # /var/lib/docker and /var/lib/containerd as writable mounts, but they inherit
    # the read_only flag. Sysbox user namespace isolation provides equivalent security.
    read_only: false
    tmpfs:
      - /tmp:size=1G,mode=1777
      - /var/tmp:size=200M,mode=1777
      - /run:size=100M,mode=755
      - /var/log:size=100M,mode=755

    # Run as root inside container so entrypoint can start dockerd
    # Sysbox maps root (uid 0) to unprivileged user on host via user namespace
    # Entrypoint drops to node user via gosu before starting gateway
    user: "0:0"

    deploy:
      resources:
        limits:
          cpus: "4"
          memory: 8G
        reservations:
          cpus: "1"
          memory: 2G
    volumes:
      # Entrypoint script: lock cleanup, start dockerd, sandbox bootstrap, gosu drop to node (from 4.8c)
      - ./scripts/entrypoint-gateway.sh:/app/scripts/entrypoint-gateway.sh:ro
      # Claude Code sandbox credentials (isolated from gateway creds, shared with sandboxes via openclaw.json binds)
      - /home/openclaw/.claude-sandbox:/home/node/.claude-sandbox
    # Entrypoint handles pre-start tasks before exec-ing the command
    entrypoint: ["/app/scripts/entrypoint-gateway.sh"]
    # Full gateway command (entrypoint passes it through via exec "$@")
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "lan",
        "--port",
        "18789",
      ]
    security_opt:
      - no-new-privileges:true
    environment:
      - NODE_ENV=production
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - TZ=UTC
      # OTEL per-signal routing: each signal goes to its own backend
      # Do NOT set endpoint in openclaw.json — these env vars are only picked up when no explicit url is passed
      - OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://10.0.0.2:4318/v1/traces
      - OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://10.0.0.2:9090/api/v1/otlp/v1/metrics
      - OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://10.0.0.2:3100/otlp/v1/logs
    networks:
      - openclaw-gateway-net
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18789/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 300s  # Extended: first boot builds 3 sandbox images inside nested Docker
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"

  openclaw-cli:
    # Same image as gateway, built by scripts/build-openclaw.sh
    image: openclaw:local
    runtime: sysbox-runc
    networks:
      - openclaw-gateway-net

  # Node Exporter - ships metrics to VPS-2 Prometheus
  node-exporter:
    image: prom/node-exporter:latest
    container_name: node-exporter
    restart: unless-stopped
    command:
      - "--path.procfs=/host/proc"
      - "--path.sysfs=/host/sys"
      - "--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    network_mode: host

  promtail:
    image: grafana/promtail:latest
    container_name: promtail
    restart: unless-stopped
    volumes:
      - ./promtail-config.yml:/etc/promtail/config.yml:ro
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      # Persist positions.yaml so Promtail doesn't re-ship logs after restart
      - ./promtail-positions:/tmp
    command: -config.file=/etc/promtail/config.yml
    network_mode: host

networks:
  openclaw-gateway-net:
    external: true
EOF
```

---

## 4.7 Create Promtail Config

Ships logs to VPS-2 Loki via WireGuard.

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/openclaw/promtail-config.yml << 'EOF'
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://10.0.0.2:3100/loki/api/v1/push

scrape_configs:
  - job_name: system
    static_configs:
      - targets:
          - localhost
        labels:
          job: varlogs
          host: openclaw
          __path__: /var/log/*log

  - job_name: docker
    static_configs:
      - targets:
          - localhost
        labels:
          job: docker
          host: openclaw
          __path__: /var/lib/docker/containers/*/*-json.log
EOF
```

---

## 4.8 Create OpenClaw Configuration

```bash
#!/bin/bash
# IMPORTANT: OpenClaw rejects unknown config keys - only use documented keys
# diagnostics-otel plugin exports all three signals to VPS-2 via WireGuard:
#   traces → Tempo (4318), metrics → Prometheus (9090), logs → Loki (3100)
# No endpoint field: per-signal routing via OTEL SDK env vars in docker-compose.override.yml

# Validate commands.restart is accepted before applying:
# sudo docker exec openclaw-gateway node dist/index.js gateway --help 2>&1 | grep -i restart
# If OpenClaw rejects the key, remove the "commands" block below.

# trustedProxies (Cloudflare Tunnel only):
#   cloudflared connects via Docker bridge (172.30.0.1). Without this, gateway
#   rejects X-Forwarded-* headers from the tunnel.
#   Not needed for Caddy (host network, connects from localhost).
#   NOTE: Only exact IPs work — CIDR ranges are NOT supported.
#
# Device pairing:
#   New devices must be approved before they can connect. The gateway's auto-approve
#   only works for localhost connections, so tunnel/Caddy users need CLI approval:
#
#   1. User opens https://<DOMAIN>/chat?token=<TOKEN> → gets "pairing required"
#   2. Admin approves via SSH:
#        sudo docker exec openclaw-gateway node dist/index.js devices list
#        sudo docker exec openclaw-gateway node dist/index.js devices approve <requestId>
#   3. User's browser auto-retries → connected
#
#   Once one device is paired, subsequent devices can be approved from the Control UI.
#   Pending requests expire after 5 minutes — the browser retries and creates new ones.

# Choose config based on networking option:
# - Cloudflare Tunnel: trustedProxies needed
# - Caddy: no trustedProxies needed

if [ "${NETWORKING_OPTION}" = "cloudflare-tunnel" ]; then
sudo tee /home/openclaw/.openclaw/openclaw.json << 'JSONEOF'
{
  "commands": {
    "restart": true
  },
  "gateway": {
    "bind": "lan",
    "mode": "local",
    "trustedProxies": ["172.30.0.1"],
    "controlUi": {
      "basePath": "${SUBPATH_OPENCLAW:-/_openclaw}"
    }
  },
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": { "enabled": true }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": ${OPENCLAW_OTEL_TRACES:-true},
      "metrics": ${OPENCLAW_OTEL_METRICS:-true},
      "logs": ${OPENCLAW_OTEL_LOGS:-true},
      "sampleRate": ${OPENCLAW_OTEL_SAMPLERATE:-0.2},
      "flushIntervalMs": ${OPENCLAW_OTEL_FLUSHINTERVAL:-20000}
    }
  },
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox-claude:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          "workdir": "/workspace",
          "readOnlyRoot": true,
          "tmpfs": ["/tmp", "/var/tmp", "/run", "/home/linuxbrew:uid=1000,gid=1000"],
          "network": "bridge",
          "user": "1000:1000",
          "capDrop": ["ALL"],
          "env": { "LANG": "C.UTF-8" },
          "pidsLimit": 256,
          "memory": "1g",
          "memorySwap": "2g",
          "cpus": 1,
          "binds": [
            "/home/node/.claude-sandbox:/home/linuxbrew/.claude"
          ]
        },
        "browser": {
          "enabled": true,
          "image": "openclaw-sandbox-browser:bookworm-slim",
          "containerPrefix": "openclaw-sbx-browser-",
          "cdpPort": 9222,
          "vncPort": 5900,
          "noVncPort": 6080,
          "headless": false,
          "enableNoVnc": true,
          "autoStart": true,
          "autoStartTimeoutMs": 12000
        },
        "prune": {
          "idleHours": 168,
          "maxAgeDays": 60
        }
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "browser", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status"],
        "deny": ["canvas", "nodes", "cron", "discord", "gateway"]
      }
    }
  }
}
JSONEOF
else
# Caddy: no trustedProxies needed (Caddy on host network connects from localhost).
# Device pairing: approve via CLI (see comment above).
sudo tee /home/openclaw/.openclaw/openclaw.json << 'JSONEOF'
{
  "commands": {
    "restart": true
  },
  "gateway": {
    "bind": "lan",
    "mode": "local",
    "controlUi": {
      "basePath": "${SUBPATH_OPENCLAW:-/_openclaw}"
    }
  },
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": { "enabled": true }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": ${OPENCLAW_OTEL_TRACES:-true},
      "metrics": ${OPENCLAW_OTEL_METRICS:-true},
      "logs": ${OPENCLAW_OTEL_LOGS:-true},
      "sampleRate": ${OPENCLAW_OTEL_SAMPLERATE:-0.2},
      "flushIntervalMs": ${OPENCLAW_OTEL_FLUSHINTERVAL:-20000}
    }
  },
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox-claude:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          "workdir": "/workspace",
          "readOnlyRoot": true,
          "tmpfs": ["/tmp", "/var/tmp", "/run", "/home/linuxbrew:uid=1000,gid=1000"],
          "network": "bridge",
          "user": "1000:1000",
          "capDrop": ["ALL"],
          "env": { "LANG": "C.UTF-8" },
          "pidsLimit": 256,
          "memory": "1g",
          "memorySwap": "2g",
          "cpus": 1,
          "binds": [
            "/home/node/.claude-sandbox:/home/linuxbrew/.claude"
          ]
        },
        "browser": {
          "enabled": true,
          "image": "openclaw-sandbox-browser:bookworm-slim",
          "containerPrefix": "openclaw-sbx-browser-",
          "cdpPort": 9222,
          "vncPort": 5900,
          "noVncPort": 6080,
          "headless": false,
          "enableNoVnc": true,
          "autoStart": true,
          "autoStartTimeoutMs": 12000
        },
        "prune": {
          "idleHours": 168,
          "maxAgeDays": 60
        }
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "browser", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status"],
        "deny": ["canvas", "nodes", "cron", "discord", "gateway"]
      }
    }
  }
}
JSONEOF
fi

# Ensure container (uid 1000) can read/write, and not world-readable
sudo chown 1000:1000 /home/openclaw/.openclaw/openclaw.json
sudo chmod 600 /home/openclaw/.openclaw/openclaw.json
```

---

## 4.8a Install Build Script and Patches

Instead of maintaining a forked Dockerfile, we patch the upstream Dockerfile and source in-place before building. Each patch auto-skips when the corresponding upstream issue is fixed.

Three upstream issues require patching, plus two additions:
- [#7201](https://github.com/openclaw/openclaw/issues/7201): Dockerfile doesn't copy extension `package.json` before `pnpm install`
- [#3201](https://github.com/openclaw/openclaw/issues/3201): `diagnostics-otel` uses deprecated `@opentelemetry` v2.x APIs
- Dual-bundle diagnostic events: `diagnostic-events.ts` is bundled into both the loader chunk and plugin-sdk, creating two separate listener Sets — events emitted by the gateway never reach plugin listeners
- Claude Code CLI: installs `@anthropic-ai/claude-code` globally so agents can use it as a coding tool
- Docker + gosu: installs `docker.io` and `gosu` for nested Docker (sandbox isolation via Sysbox)

```bash
#!/bin/bash
# Create directory
sudo -u openclaw mkdir -p /home/openclaw/scripts

# Install build script
sudo -u openclaw tee /home/openclaw/scripts/build-openclaw.sh << 'SCRIPTEOF'
#!/bin/bash
# Build OpenClaw with auto-patching for upstream issues.
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: copy extension package.json before pnpm install (upstream #7201)
#   2. OTEL extension: fix @opentelemetry v2.x API changes (upstream #3201)
#      a. Resource -> resourceFromAttributes (@opentelemetry/resources v2.x)
#      b. LoggerProvider constructor-based processors (@opentelemetry/sdk-logs v0.211+)
#   3. Diagnostic events: use globalThis for shared listener set (dual-bundle fix)
#      The diagnostic-events.ts module is bundled into both loader chunk and plugin-sdk,
#      creating two separate listener Sets. Using globalThis ensures they share one Set.
#   4. Dockerfile: install Claude Code CLI globally (@anthropic-ai/claude-code)
#   5. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#
# Usage: sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh
set -euo pipefail

cd /home/openclaw/openclaw

OTEL_SERVICE="extensions/diagnostics-otel/src/service.ts"

# ── 1. Patch Dockerfile for extension deps (upstream #7201) ──────────
if ! grep -q "extensions/diagnostics-otel/package.json" Dockerfile; then
  echo "[build] Patching Dockerfile for extension deps (upstream #7201)..."
  sed -i '/COPY scripts \.\/scripts/a COPY extensions/diagnostics-otel/package.json ./extensions/diagnostics-otel/package.json' Dockerfile
else
  echo "[build] Dockerfile already includes extension deps (upstream #7201 fixed or already patched)"
fi

# ── 2. Patch OTEL v2.x API compat (upstream #3201) ──────────────────
if grep -q "new Resource(" "$OTEL_SERVICE" 2>/dev/null; then
  echo "[build] Patching OTEL v2.x API: Resource -> resourceFromAttributes..."
  # 2a. Import: Resource -> resourceFromAttributes
  sed -i 's/import { Resource } from "@opentelemetry\/resources";/import { resourceFromAttributes } from "@opentelemetry\/resources";/' "$OTEL_SERVICE"
  # 2b. Usage: new Resource( -> resourceFromAttributes(
  sed -i 's/const resource = new Resource(/const resource = resourceFromAttributes(/' "$OTEL_SERVICE"
else
  echo "[build] OTEL Resource patch not needed (upstream fixed or already patched)"
fi

if grep -q "addLogRecordProcessor" "$OTEL_SERVICE" 2>/dev/null; then
  echo "[build] Patching OTEL v2.x API: LoggerProvider constructor-based processors..."
  # 2c. LoggerProvider: move processor from addLogRecordProcessor() to constructor
  python3 -c "
import sys
with open('$OTEL_SERVICE', 'r') as f:
    content = f.read()
old = '''        logProvider = new LoggerProvider({ resource });
        logProvider.addLogRecordProcessor(
          new BatchLogRecordProcessor(
            logExporter,
            typeof otel.flushIntervalMs === \"number\"
              ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
              : {},
          ),
        );'''
new = '''        logProvider = new LoggerProvider({
          resource,
          logRecordProcessors: [
            new BatchLogRecordProcessor(
              logExporter,
              typeof otel.flushIntervalMs === \"number\"
                ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
                : {},
            ),
          ],
        });'''
if old in content:
    content = content.replace(old, new)
    with open('$OTEL_SERVICE', 'w') as f:
        f.write(content)
    print('[build] LoggerProvider patch applied')
else:
    print('[build] WARNING: LoggerProvider pattern not found (upstream may have changed)')
    sys.exit(1)
"
else
  echo "[build] OTEL LoggerProvider patch not needed (upstream fixed or already patched)"
fi

# ── 3. Patch diagnostic events for shared listener Set (dual-bundle fix) ──
DIAG_EVENTS="src/infra/diagnostic-events.ts"
if grep -q "^const listeners = new Set" "$DIAG_EVENTS" 2>/dev/null; then
  echo "[build] Patching diagnostic-events.ts for shared globalThis listener Set..."
  sed -i 's/^const listeners = new Set<(evt: DiagnosticEventPayload) => void>();/const listeners = ((globalThis as any).__OPENCLAW_DIAG_LISTENERS__ ??= new Set<(evt: DiagnosticEventPayload) => void>()) as Set<(evt: DiagnosticEventPayload) => void>;/' "$DIAG_EVENTS"
else
  echo "[build] Diagnostic events patch not needed (upstream fixed or already patched)"
fi

# ── 4. Patch Dockerfile to install Claude Code CLI ────────────────────
if ! grep -q "@anthropic-ai/claude-code" Dockerfile; then
  echo "[build] Patching Dockerfile to install Claude Code CLI..."
  # Insert before USER (not CMD) so npm install runs as root
  sed -i '/^USER /i RUN npm install -g @anthropic-ai/claude-code' Dockerfile
else
  echo "[build] Claude Code CLI already in Dockerfile (already patched)"
fi

# ── 5. Patch Dockerfile to install Docker + gosu (nested Docker for sandboxes) ──
# docker.io includes: docker CLI, dockerd, containerd, runc
# gosu: drop-in replacement for su/sudo that doesn't spawn subshell (proper PID 1 signal handling)
# usermod: add node user to docker group for socket access after privilege drop
if ! grep -q "docker.io" Dockerfile; then
  echo "[build] Patching Dockerfile to install Docker + gosu..."
  # Insert before USER node so it runs as root
  # Single line to avoid sed multiline continuation issues in Dockerfile
  sed -i '/^USER /i RUN apt-get update && apt-get install -y --no-install-recommends docker.io gosu && usermod -aG docker node && rm -rf /var/lib/apt/lists/*' Dockerfile
else
  echo "[build] Docker already in Dockerfile (already patched)"
fi

# ── 6. Build image ───────────────────────────────────────────────────
echo "[build] Building openclaw:local..."
docker build \
  ${OPENCLAW_DOCKER_APT_PACKAGES:+--build-arg OPENCLAW_DOCKER_APT_PACKAGES="$OPENCLAW_DOCKER_APT_PACKAGES"} \
  -t openclaw:local .

# ── 7. Restore patched files (keep git working tree clean) ───────────
git checkout -- Dockerfile extensions/ src/infra/diagnostic-events.ts 2>/dev/null || true

echo "[build] Done. Run: docker compose up -d openclaw-gateway"
SCRIPTEOF

sudo chmod +x /home/openclaw/scripts/build-openclaw.sh
```

---

## 4.8b Build-Time Patches (Reference)

The build script (4.8a) applies five patches inline using `sed` and `python3`. Each auto-skips when upstream fixes the issue:

1. **Dockerfile extension deps** (upstream #7201): Copies `extensions/diagnostics-otel/package.json` before `pnpm install`
2. **OTEL v2.x API compat** (upstream #3201):
   - `@opentelemetry/resources` v2.x: `new Resource()` → `resourceFromAttributes()`
   - `@opentelemetry/sdk-logs` v0.211+: `addLogRecordProcessor()` removed → pass `logRecordProcessors` in constructor
3. **Diagnostic events dual-bundle fix**: `src/infra/diagnostic-events.ts` is bundled into both the gateway loader chunk and the plugin-sdk, creating two separate `listeners` Sets. Gateway events never reach plugin listeners. Fix: use `globalThis.__OPENCLAW_DIAG_LISTENERS__` so both bundles share one Set. Without this patch, OTEL traces and metrics don't work (logs work because they use a different code path).
4. **Claude Code CLI**: Installs `@anthropic-ai/claude-code` globally via `npm install -g` so agents can invoke `claude` as a coding tool.
5. **Docker + gosu**: Installs `docker.io` and `gosu` for nested Docker daemon (sandbox isolation via Sysbox). Adds node user to docker group for socket access after privilege drop.

The build step also passes `OPENCLAW_DOCKER_APT_PACKAGES` as a `--build-arg` when set (upstream Dockerfile has an `ARG` that conditionally installs them).

No separate patch files needed — the build script contains the patches directly.

---

## 4.8c Create Gateway Entrypoint Script

The entrypoint script runs as root (container uses `user: "0:0"`) and handles several setup tasks before dropping privileges and starting the gateway:
1. **Lock file cleanup** — removes stale `gateway.*.lock` files left by unclean shutdowns
2. **Config permissions fix** — ensures `openclaw.json` is `chmod 600` (gateway may rewrite with looser permissions)
3. **Sandbox credentials ownership fix** — chowns `.claude-sandbox` to node (1000) to undo Sysbox uid remapping
4. **Start nested Docker daemon** — launches `dockerd` for sandbox isolation (Sysbox auto-provisions `/var/lib/docker`)
5. **Sandbox image bootstrap** — builds default, common, browser, and claude sandbox images if missing
6. **Claude sandbox build** — layers `openclaw-sandbox-claude` on top of common with Claude Code CLI via `docker build`
7. **Privilege drop** — `exec gosu node "$@"` drops from root to node user (uid 1000) for the gateway process

The full gateway command (`node dist/index.js gateway ...`) is specified in `docker-compose.override.yml`, not hardcoded here. This makes the entrypoint agnostic to the gateway command format.

> **Note:** Do NOT use `exec tini --` in the script. Docker's `init: true` already provides tini as PID 1. Double-wrapping would break signal forwarding.

```bash
#!/bin/bash
# Create scripts directory
sudo -u openclaw mkdir -p /home/openclaw/openclaw/scripts

# Create entrypoint script
sudo -u openclaw tee /home/openclaw/openclaw/scripts/entrypoint-gateway.sh << 'SCRIPTEOF'
#!/bin/bash
set -euo pipefail

# ── 1a. Clean stale lock files ──────────────────────────────────────
lock_dir="/home/node/.openclaw"
if compgen -G "${lock_dir}/gateway.*.lock" > /dev/null 2>&1; then
  echo "[entrypoint] Removing stale lock files:"
  ls -la "${lock_dir}"/gateway.*.lock
  rm -f "${lock_dir}"/gateway.*.lock
  echo "[entrypoint] Lock files cleaned"
else
  echo "[entrypoint] No stale lock files found"
fi

# ── 1b. Fix openclaw.json permissions (security audit CRITICAL) ─────
config_file="/home/node/.openclaw/openclaw.json"
if [ -f "$config_file" ]; then
  current_perms=$(stat -c '%a' "$config_file" 2>/dev/null || stat -f '%Lp' "$config_file" 2>/dev/null)
  if [ "$current_perms" != "600" ]; then
    chmod 600 "$config_file"
    echo "[entrypoint] Fixed openclaw.json permissions: ${current_perms} -> 600"
  fi
fi

# ── 1c. Fix .claude-sandbox dir ownership (Sysbox uid remapping) ────
# Sandbox credentials dir: host bind mount arrives with host uid which Sysbox remaps.
# Chown to node (1000) so sandbox containers (via binds) can access it.
claude_dir="/home/node/.claude-sandbox"
if [ -d "$claude_dir" ]; then
  dir_owner=$(stat -c '%u' "$claude_dir" 2>/dev/null)
  if [ "$dir_owner" != "1000" ]; then
    chown -R 1000:1000 "$claude_dir"
    echo "[entrypoint] Fixed .claude-sandbox ownership: ${dir_owner} -> 1000"
  fi
fi

# ── 2. Start nested Docker daemon (Sysbox provides isolation) ───────
# Sysbox auto-provisions /var/lib/docker and /var/lib/containerd as
# writable mounts. We just need to start dockerd.
if command -v dockerd > /dev/null 2>&1; then
  if ! docker info > /dev/null 2>&1; then
    echo "[entrypoint] Starting nested Docker daemon..."
    dockerd --host=unix:///var/run/docker.sock \
            --storage-driver=overlay2 \
            --log-level=warn \
            --group="$(getent group docker | cut -d: -f3)" \
            > /var/log/dockerd.log 2>&1 &

    # Wait for Docker daemon to be ready
    echo "[entrypoint] Waiting for nested Docker daemon..."
    timeout=30
    elapsed=0
    while ! docker info > /dev/null 2>&1; do
      if [ "$elapsed" -ge "$timeout" ]; then
        echo "[entrypoint] WARNING: Docker daemon not ready after ${timeout}s"
        echo "[entrypoint] dockerd log:"
        tail -20 /var/log/dockerd.log 2>/dev/null || true
        break
      fi
      sleep 1
      elapsed=$((elapsed + 1))
    done
  fi

  if docker info > /dev/null 2>&1; then
    echo "[entrypoint] Nested Docker daemon ready (took ${elapsed:-0}s)"

    # Build default sandbox image if missing
    if ! docker image inspect openclaw-sandbox > /dev/null 2>&1; then
      echo "[entrypoint] Sandbox image not found, building..."
      if [ -f /app/sandbox/Dockerfile ]; then
        docker build -t openclaw-sandbox /app/sandbox/
        echo "[entrypoint] Sandbox image built successfully"
      else
        echo "[entrypoint] WARNING: /app/sandbox/Dockerfile not found"
      fi
    else
      echo "[entrypoint] Sandbox image already exists"
    fi

    # Build common sandbox image if missing (includes Node.js, git, common tools)
    if ! docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
      echo "[entrypoint] Common sandbox image not found, building..."
      if [ -f /app/scripts/sandbox-common-setup.sh ]; then
        /app/scripts/sandbox-common-setup.sh
        echo "[entrypoint] Common sandbox image built successfully"
      else
        echo "[entrypoint] WARNING: sandbox-common-setup.sh not found"
      fi
    else
      echo "[entrypoint] Common sandbox image already exists"
    fi

    # Build browser sandbox image if missing (includes Chromium, noVNC)
    if ! docker image inspect openclaw-sandbox-browser:bookworm-slim > /dev/null 2>&1; then
      echo "[entrypoint] Browser sandbox image not found, building..."
      if [ -f /app/scripts/sandbox-browser-setup.sh ]; then
        /app/scripts/sandbox-browser-setup.sh
        echo "[entrypoint] Browser sandbox image built successfully"
      else
        echo "[entrypoint] WARNING: sandbox-browser-setup.sh not found"
      fi
    else
      echo "[entrypoint] Browser sandbox image already exists"
    fi

    # Build claude sandbox image if missing (layered on common with Claude Code CLI)
    # This is a separate image so common stays clean — only claude sandbox has the CLI
    if ! docker image inspect openclaw-sandbox-claude:bookworm-slim > /dev/null 2>&1; then
      if docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
        echo "[entrypoint] Claude sandbox image not found, building..."
        printf 'FROM openclaw-sandbox-common:bookworm-slim\nUSER root\nRUN npm install -g @anthropic-ai/claude-code\nUSER 1000\n' | docker build -t openclaw-sandbox-claude:bookworm-slim -
        echo "[entrypoint] Claude sandbox image built successfully"
      fi
    else
      echo "[entrypoint] Claude sandbox image already exists"
    fi
  fi
else
  echo "[entrypoint] Docker not installed, skipping sandbox bootstrap"
fi

# ── 3. Drop privileges and exec gateway ─────────────────────────────
# gosu drops from root to node user without spawning a subshell,
# preserving PID structure for proper signal handling via tini
echo "[entrypoint] Executing as node: $*"
exec gosu node "$@"
SCRIPTEOF

# Make executable
sudo chmod +x /home/openclaw/openclaw/scripts/entrypoint-gateway.sh
```

---

## 4.9 Build and Start OpenClaw

```bash
#!/bin/bash
# Build image with auto-patching
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# Start services
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# Check status
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'
sudo docker logs --tail 20 openclaw-gateway
```

---

## Verification

```bash
# Check containers are running
sudo -u openclaw docker compose ps

# Check gateway logs
sudo docker logs --tail 50 openclaw-gateway

# Test internal endpoint
curl -s http://localhost:18789/ | head -5

# Test health endpoint
curl -s http://localhost:18789/health

# Check Node Exporter
curl -s http://localhost:9100/metrics | head -5
```

---

## Troubleshooting

### Sysbox Not Found

```bash
# Check Sysbox service
sudo systemctl status sysbox

# Reinstall if needed
sudo dpkg -i sysbox-ce_*.deb
```

### Container Won't Start

```bash
# Check logs for config errors
sudo docker logs openclaw-gateway

# Common issue: Invalid config keys in openclaw.json
# Solution: Keep config minimal, only use documented keys

# Check resources
docker system df
free -h
df -h
```

### Permission Denied on .openclaw

```bash
# Fix ownership - container runs as uid 1000
sudo chown -R 1000:1000 /home/openclaw/.openclaw
```

### Network Issues

```bash
# Verify network exists
docker network ls | grep openclaw

# Recreate if needed
docker network rm openclaw-gateway-net
docker network create --driver bridge --subnet 172.30.0.0/24 openclaw-gateway-net
```

---

## Updating OpenClaw

The `openclaw update` CLI command does **not** work inside Docker — the `.git` directory is excluded by `.dockerignore`, so the update tool reports `not-git-install`. Instead, update by rebuilding from the host git repo using the build script.

The build script auto-patches upstream issues and restores the git working tree after building, so `git pull` always works cleanly.

```bash
#!/bin/bash
# 1. Pull latest source
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git pull origin main'

# 2. Rebuild with auto-patching
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# 3. Recreate containers with the new image
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# 4. Verify new version
sudo docker exec openclaw-gateway node dist/index.js --version
```

> **Note:** Step 3 automatically stops the old container and starts a new one from the rebuilt image. Expect a brief gateway downtime during the restart.
>
> When upstream fixes either patched issue (#7201 or #3201), the build script auto-detects and skips the corresponding patch. No manual intervention needed.

---

## Security Notes

- `read_only: false` — required for Docker-in-Docker (Sysbox auto-mounts inherit the flag). Sysbox user namespace isolation provides equivalent protection.
- tmpfs mounts for `/tmp`, `/var/tmp`, `/run`, `/var/log` limit persistent writable paths
- Container starts as root (`user: "0:0"`) but Sysbox maps uid 0 → unprivileged uid on host
- Entrypoint drops to node (uid 1000) via `gosu` before starting gateway process
- `no-new-privileges` prevents privilege escalation (gosu drops, doesn't gain)
- Resource limits prevent runaway containers
- Sysbox provides secure container-in-container isolation (user namespace, /proc, /sys virtualization)
- Inner Docker socket group set to `docker`, node user is a member
- Sandbox containers run with `network: "none"` — no outbound internet
