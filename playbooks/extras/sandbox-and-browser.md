# Sandbox & Browser Extras

Add rich sandbox (Node.js, git, dev tools), browser support (Chromium + noVNC), gateway apt packages (ffmpeg, imagemagick, build-essential), and Claude Code CLI to the OpenClaw gateway.

## Overview

This playbook configures:
- **Common sandbox image** — Pre-built `openclaw-sandbox-common:bookworm-slim` with Node.js, git, and dev tools (replaces minimal default for agent tasks)
- **Browser sandbox image** — `openclaw-sandbox-browser:bookworm-slim` with Chromium and noVNC for web browsing tasks, viewable through the Control UI
- **Gateway apt packages** — `ffmpeg`, `build-essential`, and `imagemagick` baked into the gateway Docker image at build time
- **Claude Code CLI** — `@anthropic-ai/claude-code` installed globally in the gateway image so agents can use it as a coding tool
- **Config permissions fix** — Ensures `chmod 600` on `openclaw.json` every startup via entrypoint

## Prerequisites

- Base deployment complete (`01-07` playbooks)
- OpenClaw gateway running on VPS-1
- At least **2GB free disk space** on VPS-1 (sandbox images ~1.3GB + gateway extras ~450MB)

## Disk Space Check

```bash
#!/bin/bash
# Check available disk space on VPS-1 before proceeding
df -h /home/openclaw
# Expect at least 2GB free
# Common sandbox: ~500MB (inside nested Docker)
# Browser sandbox: ~800MB (inside nested Docker)
# Gateway apt packages: ~350MB (in gateway image layer)
# Claude Code CLI: ~100MB (npm global install)
```

---

## E.1 Update Environment File

Add the `OPENCLAW_DOCKER_APT_PACKAGES` variable to the gateway `.env` file. The upstream Dockerfile has a conditional `ARG` that installs these packages when provided.

```bash
#!/bin/bash
# Append to existing .env (idempotent — skips if already present)
ENV_FILE="/home/openclaw/openclaw/.env"
if ! sudo -u openclaw grep -q "OPENCLAW_DOCKER_APT_PACKAGES" "$ENV_FILE"; then
  sudo -u openclaw tee -a "$ENV_FILE" << 'EOF'

# Extra apt packages baked into gateway image at build time (space-separated)
OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential imagemagick"
EOF
  echo "Added OPENCLAW_DOCKER_APT_PACKAGES to .env"
else
  echo "OPENCLAW_DOCKER_APT_PACKAGES already in .env"
fi
```

---

## E.2 Deploy Updated Build Script and Rebuild Gateway Image

The build script adds three new features:
- **Patch #4**: Installs Claude Code CLI (`@anthropic-ai/claude-code`) globally via `npm install -g`
- **Patch #5**: Installs `docker.io` + `gosu` for nested Docker daemon (sandbox isolation via Sysbox). Adds node user to docker group for socket access after privilege drop.
- **`--build-arg`**: Passes `OPENCLAW_DOCKER_APT_PACKAGES` to Docker build (upstream Dockerfile conditionally installs them)

```bash
#!/bin/bash
# Deploy updated build script from local repo
# The script is maintained in scripts/build-openclaw.sh in this repo
# SCP it to VPS-1:
scp -P ${SSH_PORT} scripts/build-openclaw.sh ${SSH_USER}@${VPS1_IP}:/tmp/build-openclaw.sh

# On VPS-1: install and set permissions
sudo cp /tmp/build-openclaw.sh /home/openclaw/scripts/build-openclaw.sh
sudo chown openclaw:openclaw /home/openclaw/scripts/build-openclaw.sh
sudo chmod +x /home/openclaw/scripts/build-openclaw.sh

# Source .env so OPENCLAW_DOCKER_APT_PACKAGES is available during build
sudo -u openclaw bash -c 'source /home/openclaw/openclaw/.env && /home/openclaw/scripts/build-openclaw.sh'
```

The build will:
1. Apply patches 1-5 (each auto-skips if already fixed upstream)
2. Pass `--build-arg OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential imagemagick"` to Docker
3. Install Claude Code CLI globally in the image
4. Install Docker + gosu for nested Docker (sandbox isolation)
5. Restore patched files to keep git tree clean

Expect the build to take 5-10 minutes (apt packages, Docker, and npm install add time). The `docker.io` package adds ~150MB to the image.

---

## E.3 Deploy Updated Entrypoint Script

The entrypoint now runs as root (`user: "0:0"` in compose) and handles:
1. Lock file cleanup (existing)
2. `openclaw.json` permissions fix (`chmod 600` if drifted)
3. **NEW**: Start nested Docker daemon (`dockerd`) — Sysbox auto-provisions `/var/lib/docker`
4. Default sandbox image bootstrap
5. Common sandbox image bootstrap (`openclaw-sandbox-common:bookworm-slim`)
6. Browser sandbox image bootstrap (`openclaw-sandbox-browser:bookworm-slim`)
7. **NEW**: Privilege drop via `exec gosu node "$@"` — gateway runs as node (uid 1000)

> **Important:** The compose override must also be updated to use `user: "0:0"` and add `/var/log` tmpfs. See section E.3a below.

```bash
#!/bin/bash
# Deploy updated entrypoint from local repo
# SCP to VPS-1:
# Note: The entrypoint content is embedded in playbook 04-vps1-openclaw.md section 4.8c
# Deploy it directly:

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

sudo chmod +x /home/openclaw/openclaw/scripts/entrypoint-gateway.sh
```

---

## E.3a Update Docker Compose Override

The container must run as root so the entrypoint can start `dockerd`. Sysbox maps uid 0 inside the container to an unprivileged user on the host. The entrypoint drops to node (uid 1000) via `gosu` before starting the gateway.

```bash
#!/bin/bash
# Update docker-compose.override.yml on VPS-1
COMPOSE_FILE="/home/openclaw/openclaw/docker-compose.override.yml"

# Change user from 1000:1000 to 0:0
sudo -u openclaw sed -i 's/user: "1000:1000"/user: "0:0"/' "$COMPOSE_FILE"

# Change read_only to false (Sysbox auto-mounts inherit the flag)
sudo -u openclaw sed -i 's/read_only: true/read_only: false/' "$COMPOSE_FILE"

# Add /var/log tmpfs (dockerd writes logs there) and increase /tmp to 1G
sudo -u openclaw sed -i 's|/tmp:size=500M,mode=1777|/tmp:size=1G,mode=1777|' "$COMPOSE_FILE"
# Add /var/log tmpfs after /run tmpfs line
sudo -u openclaw sed -i '/\/run:size=100M,mode=755/a\      - /var/log:size=100M,mode=755' "$COMPOSE_FILE"

echo "Updated compose: user=0:0, read_only=false, added /var/log tmpfs"
```

Key changes:
- `user: "0:0"` — root inside container (Sysbox maps to unprivileged on host)
- `read_only: false` — required because Sysbox auto-mounts inherit the read_only flag; dockerd can't write to `/var/lib/docker` with `read_only: true`
- `/var/log` tmpfs — dockerd writes logs to `/var/log/dockerd.log`
- `/tmp` increased to 1G — sandbox builds use temp space
- `no-new-privileges:true` kept — gosu drops privileges, doesn't gain

---

## E.4 Update openclaw.json with Sandbox and Browser Config

Add `agents` and `tools` blocks to enable rich sandboxes and browser support. The config uses `openclaw-sandbox-common:bookworm-slim` as the default sandbox image (includes Node.js, git, dev tools) and enables the browser tool with Chromium + noVNC.

> **Important:** This replaces the existing `openclaw.json`. Make sure to use the correct variant for your networking option (Cloudflare Tunnel or Caddy).

Follow section 4.8 in `playbooks/04-vps1-openclaw.md` — it now includes the `agents` and `tools` blocks. The key additions are:

```json
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox-common:bookworm-slim",
          "network": "bridge",
          "memory": "1g",
          "cpus": 1
        },
        "browser": {
          "enabled": true,
          "image": "openclaw-sandbox-browser:bookworm-slim",
          "headless": false,
          "enableNoVnc": true
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
```

Key decisions:
- `mode: "all"` — all agents (including main) run in sandboxes. Requires Docker installed inside the container (patch #5 in build script).
- `network: "bridge"` — required for browser CDP connectivity. `"none"` breaks browser tool (gateway can't resolve CDP port). Sandbox containers are already double-isolated inside Sysbox nested Docker.
- `"browser"` is NOT in the deny list so sandbox agents can use browser tools
- noVNC is enabled for visual browser access through the Control UI

```bash
#!/bin/bash
# Re-run section 4.8 from the main playbook to regenerate openclaw.json
# with the new agents/tools blocks included.
# See playbooks/04-vps1-openclaw.md section 4.8 for the full script.

# After writing, fix permissions:
sudo chown 1000:1000 /home/openclaw/.openclaw/openclaw.json
sudo chmod 600 /home/openclaw/.openclaw/openclaw.json
```

---

## E.5 Update Docker Compose Start Period

The first boot now builds 3 sandbox images inside the nested Docker daemon, which takes significantly longer. Increase `start_period` from 120s to 300s.

```bash
#!/bin/bash
# Update start_period in docker-compose.override.yml
COMPOSE_FILE="/home/openclaw/openclaw/docker-compose.override.yml"
sudo -u openclaw sed -i 's/start_period: 120s.*/start_period: 300s  # Extended: first boot builds 3 sandbox images inside nested Docker/' "$COMPOSE_FILE"
echo "Updated start_period to 300s"
```

---

## E.6 Restart Gateway and Monitor First Boot

```bash
#!/bin/bash
# Restart the gateway to pick up all changes
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d openclaw-gateway'

# Monitor the first boot — expect 3-5 minutes for all sandbox images to build
echo "Monitoring gateway startup (Ctrl+C to stop)..."
echo "First boot builds 3 images: openclaw-sandbox, openclaw-sandbox-common, openclaw-sandbox-browser"
sudo docker logs -f openclaw-gateway 2>&1 | grep -E '\[entrypoint\]|\[sandbox\]|error|ERROR'
```

Wait for all three `"built successfully"` messages before proceeding to verification.

---

## Verification

```bash
#!/bin/bash
# 1. Check all 3 sandbox images exist inside the nested Docker
echo "=== Sandbox Images ==="
sudo docker exec openclaw-gateway docker images | grep -E 'openclaw-sandbox|REPOSITORY'

# 2. Check entrypoint bootstrap logs
echo ""
echo "=== Bootstrap Logs ==="
sudo docker logs openclaw-gateway 2>&1 | grep -i '\[entrypoint\]'

# 3. Verify gateway apt packages
echo ""
echo "=== Gateway Packages ==="
sudo docker exec openclaw-gateway which ffmpeg && echo "ffmpeg: OK" || echo "ffmpeg: MISSING"
sudo docker exec openclaw-gateway which convert && echo "imagemagick: OK" || echo "imagemagick: MISSING"
sudo docker exec openclaw-gateway which gcc && echo "build-essential: OK" || echo "build-essential: MISSING"

# 4. Verify Claude Code CLI
echo ""
echo "=== Claude Code CLI ==="
sudo docker exec openclaw-gateway claude --version && echo "claude: OK" || echo "claude: MISSING"

# 5. Check openclaw.json permissions
echo ""
echo "=== Config Permissions ==="
sudo docker exec openclaw-gateway stat -c '%a' /home/node/.openclaw/openclaw.json
# Should return: 600

# 6. Check openclaw.json has agents config
echo ""
echo "=== Agents Config ==="
sudo docker exec openclaw-gateway cat /home/node/.openclaw/openclaw.json | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
print('agents:', 'OK' if 'agents' in cfg else 'MISSING')
print('tools:', 'OK' if 'tools' in cfg else 'MISSING')
mode = cfg.get('agents', {}).get('defaults', {}).get('sandbox', {}).get('mode')
print('sandbox.mode:', mode)
print('browser enabled:', cfg.get('agents', {}).get('defaults', {}).get('sandbox', {}).get('browser', {}).get('enabled', False))
"

# 7. Verify gateway process runs as node (not root)
echo ""
echo "=== Process User ==="
sudo docker exec openclaw-gateway ps aux | grep "node dist/index.js"
# Should show: node (uid 1000), NOT root

# 8. Verify dockerd runs as root
echo ""
echo "=== Docker Daemon ==="
sudo docker exec openclaw-gateway ps aux | grep dockerd
# Should show: root

# 9. Docker socket accessible by gateway
echo ""
echo "=== Docker Socket ==="
sudo docker exec openclaw-gateway su -s /bin/sh node -c "docker info > /dev/null && echo 'socket OK'"
```

### Expected Output

```
=== Sandbox Images ===
REPOSITORY                    TAG              SIZE
openclaw-sandbox              bookworm-slim    ~150MB
openclaw-sandbox-common       bookworm-slim    ~500MB
openclaw-sandbox-browser      bookworm-slim    ~800MB

=== Gateway Packages ===
ffmpeg: OK
imagemagick: OK
build-essential: OK

=== Claude Code CLI ===
claude: OK

=== Config Permissions ===
600

=== Agents Config ===
agents: OK
tools: OK
browser enabled: True
```

---

## Troubleshooting

### Sandbox Images Not Building

```bash
# Check if nested Docker daemon is running
sudo docker exec openclaw-gateway docker info

# Check if setup scripts exist
sudo docker exec openclaw-gateway ls -la /app/scripts/sandbox-*.sh

# Manually trigger a build
sudo docker exec openclaw-gateway /app/scripts/sandbox-common-setup.sh
sudo docker exec openclaw-gateway /app/scripts/sandbox-browser-setup.sh
```

### Gateway Image Too Large

```bash
# Check image size
sudo -u openclaw docker images openclaw:local

# If disk is tight, remove old images
sudo -u openclaw docker image prune -f
```

### Claude Code CLI Not Found

```bash
# Check if npm global bin is on PATH
sudo docker exec openclaw-gateway npm list -g @anthropic-ai/claude-code

# Check PATH
sudo docker exec openclaw-gateway bash -c 'echo $PATH'
```

### Browser Not Working

```bash
# Check browser sandbox image exists
sudo docker exec openclaw-gateway docker images | grep browser

# Check gateway logs for browser-related errors
sudo docker logs openclaw-gateway 2>&1 | grep -i browser

# Verify noVNC port is accessible (proxied through gateway on port 18789)
# The Control UI should show a browser viewer tab when a browser task is active
```

### Config Permissions Keep Drifting

The entrypoint fixes permissions on every startup. If you notice `600` drifting to `644` between restarts, the gateway is rewriting the file. The entrypoint fix handles this automatically — just restart the container.

```bash
# Manual fix if needed
sudo docker exec openclaw-gateway chmod 600 /home/node/.openclaw/openclaw.json
```
