# Plan: Secure Secrets via Entrypoint Wrapper + Secret Files

## Context

Sensitive keys (ANTHROPIC_API_KEY, OPENCLAW_GATEWAY_TOKEN, bot tokens) are passed as Docker `environment:` variables, which means they are stored in plaintext in Docker's container metadata and visible via `docker inspect`, the Docker API, and any monitoring tool with socket access (cAdvisor, Portainer, etc.).

The goal is to remove secrets from `docker inspect` output while keeping them available to the running process — defense-in-depth for Docker socket compromise.

## Approach: Entrypoint Wrapper + Secret Files

**How it works:**

1. Split secrets out of `.env` into individual files under `secrets/` directory (chmod 600)
2. Set upstream-referenced env vars to empty strings in `.env` (neutralizes `docker inspect` exposure)
3. An entrypoint wrapper script reads secret files from bind mounts, exports them as env vars, then `exec`s the gateway
4. The real secret values only exist in the `exec`'d process's memory — never in Docker metadata

**Why not other approaches:**

- `env_file:` — values still appear in `docker inspect`
- Docker Swarm secrets — not available (we use sysbox, not Swarm mode)
- Docker Compose `secrets:` top-level — potential mount-ordering conflicts with read-only rootfs + tmpfs at `/run`; plain bind mounts are simpler and equivalent

## Changes

### 1. Playbook `04-vps1-openclaw.md` — Section 4.5 (update .env)

Remove secret values from `.env`, keep only non-secret config. Set upstream-referenced vars to empty:

```bash
# Neutralized — real values loaded by entrypoint from secret files
OPENCLAW_GATEWAY_TOKEN=
CLAUDE_AI_SESSION_KEY=
CLAUDE_WEB_SESSION_KEY=
CLAUDE_WEB_COOKIE=

# Non-secret config (unchanged)
OPENCLAW_CONFIG_DIR=/home/openclaw/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/openclaw/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=0.0.0.0:18789
OPENCLAW_BRIDGE_PORT=0.0.0.0:18790
OPENCLAW_GATEWAY_BIND=lan
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://10.0.0.2:4318/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://10.0.0.2:9090/api/v1/otlp/v1/metrics
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://10.0.0.2:3100/otlp/v1/logs
```

### 2. Playbook `04-vps1-openclaw.md` — New section 4.5a (create secret files)

Create `secrets/` directory with individual secret files:

```bash
sudo -u openclaw mkdir -p /home/openclaw/openclaw/secrets
sudo chmod 700 /home/openclaw/openclaw/secrets

GATEWAY_TOKEN=$(openssl rand -hex 32)

printf '%s' "${ANTHROPIC_API_KEY}" | sudo -u openclaw tee /home/openclaw/openclaw/secrets/anthropic_api_key > /dev/null
printf '%s' "${GATEWAY_TOKEN}"     | sudo -u openclaw tee /home/openclaw/openclaw/secrets/openclaw_gateway_token > /dev/null
printf '%s' "${TELEGRAM_BOT_TOKEN:-}" | sudo -u openclaw tee /home/openclaw/openclaw/secrets/telegram_bot_token > /dev/null
# ... same for discord, claude session keys, etc.

sudo chmod 600 /home/openclaw/openclaw/secrets/*
```

### 3. Playbook `04-vps1-openclaw.md` — New section 4.5b (entrypoint wrapper)

Create `scripts/secrets-entrypoint.sh`:

```bash
#!/bin/bash
set -e

load_secret() {
  local file="/run/secrets/$1"
  local var="$2"
  if [ -f "$file" ] && [ -s "$file" ]; then
    export "$var"="$(cat "$file")"
  fi
}

load_secret anthropic_api_key      ANTHROPIC_API_KEY
load_secret openclaw_gateway_token OPENCLAW_GATEWAY_TOKEN
load_secret telegram_bot_token     TELEGRAM_BOT_TOKEN
load_secret discord_bot_token      DISCORD_BOT_TOKEN

exec "$@"
```

### 4. Playbook `04-vps1-openclaw.md` — Section 4.6 (docker-compose.override.yml)

Update the override to:

- **Remove** `ANTHROPIC_API_KEY` and `TELEGRAM_BOT_TOKEN` from `environment:`
- **Add** bind mounts for secret files → `/run/secrets/<name>:ro`
- **Add** bind mount for entrypoint script
- **Set** `entrypoint:` to the wrapper, keep `command:` as the gateway args

```yaml
services:
  openclaw-gateway:
    # ... existing build, runtime, security settings unchanged ...

    environment:
      - NODE_ENV=production
      - TZ=UTC
      # Non-secret OTEL endpoints only
      - OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}
      - OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=${OTEL_EXPORTER_OTLP_METRICS_ENDPOINT}
      - OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT}

    volumes:
      # ... existing mounts ...
      - ./scripts/secrets-entrypoint.sh:/app/scripts/secrets-entrypoint.sh:ro
      - ./secrets/anthropic_api_key:/run/secrets/anthropic_api_key:ro
      - ./secrets/openclaw_gateway_token:/run/secrets/openclaw_gateway_token:ro
      - ./secrets/telegram_bot_token:/run/secrets/telegram_bot_token:ro
      - ./secrets/discord_bot_token:/run/secrets/discord_bot_token:ro

    entrypoint: ["/app/scripts/secrets-entrypoint.sh"]
    command: ["node", "dist/index.js", "gateway", "--allow-unconfigured", "--bind", "lan", "--port", "18789"]
```

### 5. Playbook `06-backup.md` — Add secrets to backup tar

Add `openclaw/secrets \` to the tar command (line 52).

### 6. Playbook `07-verification.md` — Add secret leak check

```bash
# Verify secrets NOT in docker inspect
docker inspect openclaw-gateway --format '{{json .Config.Env}}' | grep -qv "sk-ant" && echo "PASS" || echo "FAIL"
```

### 7. `CLAUDE.md` — Add deployment note

Add note: "Secrets use entrypoint wrapper pattern — individual files in `secrets/`, loaded at runtime, never in `docker inspect`"

## What This Fixes vs. What It Doesn't

| Vector | Before | After |
|--------|--------|-------|
| `docker inspect` | All secrets visible | Empty strings |
| Docker API / cAdvisor | All secrets visible | Empty strings |
| `docker exec ... env` | Secrets visible | Still visible (unavoidable) |
| `/proc/<pid>/environ` inside container | Secrets visible | Still visible (unavoidable) |
| Host file access | Single `.env` with everything | Split files, same permissions |

The primary win is eliminating secrets from Docker's stored metadata — meaningful for any scenario where Docker API access is broader than container exec access.

## Verification

1. `docker compose up -d` — gateway starts successfully
2. `docker inspect openclaw-gateway --format '{{json .Config.Env}}'` — no `sk-ant`, no real token values
3. `sudo docker exec openclaw-gateway printenv ANTHROPIC_API_KEY` — shows real key (loaded by entrypoint)
4. `openclaw security audit --deep` — no new findings
5. Health check passes: `curl http://localhost:18789/health`

## Files Modified

- `playbooks/04-vps1-openclaw.md` — Sections 4.5, new 4.5a, new 4.5b, 4.6
- `playbooks/06-backup.md` — Backup tar command
- `playbooks/07-verification.md` — Secret leak verification
- `CLAUDE.md` — Deployment notes
