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

The build script adds two new features:
- **Patch #4**: Installs Claude Code CLI (`@anthropic-ai/claude-code`) globally via `npm install -g`
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
1. Apply patches 1-4 (each auto-skips if already fixed upstream)
2. Pass `--build-arg OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential imagemagick"` to Docker
3. Install Claude Code CLI globally in the image
4. Restore patched files to keep git tree clean

Expect the build to take 5-10 minutes (apt packages and npm install add time).

---

## E.3 Deploy Updated Entrypoint Script

The entrypoint now handles:
1. Lock file cleanup (existing)
2. **NEW**: `openclaw.json` permissions fix (`chmod 600` if drifted)
3. Default sandbox image bootstrap (existing)
4. **NEW**: Common sandbox image bootstrap (`openclaw-sandbox-common:bookworm-slim`)
5. **NEW**: Browser sandbox image bootstrap (`openclaw-sandbox-browser:bookworm-slim`)

```bash
#!/bin/bash
# Deploy updated entrypoint from local repo
# SCP to VPS-1:
# Note: The entrypoint content is embedded in playbook 04-vps1-openclaw.md section 4.8c
# Deploy it directly:

sudo -u openclaw tee /home/openclaw/openclaw/scripts/entrypoint-gateway.sh << 'SCRIPTEOF'
#!/bin/bash
set -euo pipefail

# ── 1a. Clean stale lock files ────────────────────────────────────────
# Unclean shutdowns can leave lock files that prevent the gateway from starting
lock_dir="/home/node/.openclaw"
if compgen -G "${lock_dir}/gateway.*.lock" > /dev/null 2>&1; then
  echo "[entrypoint] Removing stale lock files:"
  ls -la "${lock_dir}"/gateway.*.lock
  rm -f "${lock_dir}"/gateway.*.lock
  echo "[entrypoint] Lock files cleaned"
else
  echo "[entrypoint] No stale lock files found"
fi

# ── 1b. Fix openclaw.json permissions (security audit CRITICAL) ───────
# The gateway may rewrite this file with looser permissions on config changes
config_file="/home/node/.openclaw/openclaw.json"
if [ -f "$config_file" ]; then
  current_perms=$(stat -c '%a' "$config_file" 2>/dev/null || stat -f '%Lp' "$config_file" 2>/dev/null)
  if [ "$current_perms" != "600" ]; then
    chmod 600 "$config_file"
    echo "[entrypoint] Fixed openclaw.json permissions: ${current_perms} -> 600"
  fi
fi

# ── 2. Wait for nested Docker daemon and bootstrap sandbox images ─────
# Sysbox starts a nested Docker daemon inside the container. We need to
# wait for it before checking/building sandbox images.
echo "[entrypoint] Waiting for nested Docker daemon..."
timeout=30
elapsed=0
while ! docker info > /dev/null 2>&1; do
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "[entrypoint] WARNING: Nested Docker daemon not available after ${timeout}s, skipping sandbox bootstrap"
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if docker info > /dev/null 2>&1; then
  echo "[entrypoint] Nested Docker daemon ready (took ${elapsed}s)"

  # Build default sandbox image if missing
  if ! docker image inspect openclaw-sandbox > /dev/null 2>&1; then
    echo "[entrypoint] Sandbox image not found, building..."
    if [ -f /app/sandbox/Dockerfile ]; then
      docker build -t openclaw-sandbox /app/sandbox/
      echo "[entrypoint] Sandbox image built successfully"
    else
      echo "[entrypoint] WARNING: /app/sandbox/Dockerfile not found, skipping sandbox image build"
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
      echo "[entrypoint] WARNING: sandbox-common-setup.sh not found, skipping"
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
      echo "[entrypoint] WARNING: sandbox-browser-setup.sh not found, skipping"
    fi
  else
    echo "[entrypoint] Browser sandbox image already exists"
  fi
fi

# ── 3. Exec the command from docker-compose ──────────────────────────
# exec replaces this shell with the specified process, so tini (PID 1
# from Docker's init: true) becomes the direct parent — proper signal handling
echo "[entrypoint] Executing: $*"
exec "$@"
SCRIPTEOF

sudo chmod +x /home/openclaw/openclaw/scripts/entrypoint-gateway.sh
```

---

## E.4 Update openclaw.json with Sandbox and Browser Config

Add `agents` and `tools` blocks to enable rich sandboxes and browser support. The config uses `openclaw-sandbox-common:bookworm-slim` as the default sandbox image (includes Node.js, git, dev tools) and enables the browser tool with Chromium + noVNC.

> **Important:** This replaces the existing `openclaw.json`. Make sure to use the correct variant for your networking option (Cloudflare Tunnel or Caddy).

Follow section 4.8 in `playbooks/04-vps1-openclaw.md` — it now includes the `agents` and `tools` blocks. The key additions are:

```json
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox-common:bookworm-slim",
          "network": "none",
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
        "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status"],
        "deny": ["canvas", "nodes", "cron", "discord", "gateway"]
      }
    }
  }
```

Key decisions:
- `mode: "non-main"` — only sub-agents run in sandboxes, main agent stays unsandboxed (required until Docker is available inside the container)
- `network: "none"` — strict isolation, no outbound internet from sandboxes
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
print('browser enabled:', cfg.get('agents', {}).get('defaults', {}).get('sandbox', {}).get('browser', {}).get('enabled', False))
"
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
