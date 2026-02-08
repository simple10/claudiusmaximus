# CLAUDE.md — OpenClaw Single-VPS Deployment

## Overview

This document orchestrates the automated deployment of OpenClaw on a single OVHCloud VPS instance, with Cloudflare Workers handling observability and LLM proxying.

| Component | Role | Services |
|-----------|------|----------|
| **VPS-1** | OpenClaw | Gateway, Sysbox, Vector (log shipper) |
| **AI Gateway Worker** | LLM Proxy | Cloudflare AI Gateway analytics, API key isolation |
| **Log Receiver Worker** | Log Ingestion | Accepts container logs from Vector, Cloudflare real-time logs |

## Playbook Structure

All deployment steps are in modular playbooks under `playbooks/`:

| Playbook | Description |
|----------|-------------|
| `00-analysis-mode.md` | Analyze existing deployment |
| `01-base-setup.md` | Users, SSH, UFW, fail2ban, kernel |
| `03-docker.md` | Docker installation and hardening |
| `04-vps1-openclaw.md` | Sysbox, networks, gateway, Vector |
| `networking/cloudflare-tunnel.md` | Cloudflare Tunnel (VPS-1 only) |
| `networking/caddy.md` | Caddy reverse proxy with Origin CA (VPS-1 only) |
| `06-backup.md` | Backup scripts and cron jobs |
| `07-verification.md` | Testing and verification |
| `08-workers.md` | Cloudflare Workers deployment (AI Gateway + Log Receiver) |
| `09-decommission-vps2.md` | VPS-2 decommission steps |
| `98-post-deploy.md` | First access & device pairing |
| `99-new-feature-planning.md` | Process for planning new features |
| `99-new-feature-implementation.md` | Process for implementing planned features |

Optional features are in `playbooks/extras/`:

| Playbook | Description |
|----------|-------------|
| `extras/sandbox-and-browser.md` | Rich sandbox, browser, gateway packages, Claude Code CLI |

See `extras/README.md` for details.

See [playbooks/README.md](playbooks/README.md) for detailed playbook documentation.

---

## General Rules

- **Preserve comments in config files.** Comments document intent and aid future maintenance.
- **Update stale comments.** If code changes make a comment inaccurate, fix the comment.
- **Add comments for non-obvious settings.** Explain *why*, not *what*.
- **Always use bind mounts, never named volumes.** All Docker container data must use bind mounts to directories under the service's working directory (e.g., `./data/<service>:/path`). Named volumes hide data inside `/var/lib/docker/volumes/` where it cannot be easily backed up with `rsync`. Bind mounts keep everything on the host filesystem under known paths.

---

## Configuration

IMPORTANT: Read configuration from `openclaw-config.env`:

```bash
# Example config - use the actual values from openclaw-config.env

# Required
VPS1_IP=X.X.X.X                             # VPS-1 public IP
SSH_KEY_PATH=~/.ssh/ovh_openclaw_ed25519    # SSH private key path
SSH_USER=adminclaw                          # SSH user (initially ubuntu then changed to adminclaw during hardening)
SSH_PORT=222                                # SSH port (initially 22 then changed to 222 during hardening)
NETWORKING_OPTION=cloudflare-tunnel         # or "caddy"
DOMAIN_OPENCLAW=openclaw.example.com
ANTHROPIC_API_KEY=sk-ant-...

# URL subpaths (no trailing slash; empty string "" to serve at root)
SUBPATH_OPENCLAW=/_openclaw

# Workers
LOG_WORKER_URL=https://log-receiver.<account>.workers.dev/logs
LOG_WORKER_TOKEN=<generated-token>
AI_GATEWAY_WORKER_URL=https://ai-gateway-proxy.<account>.workers.dev
AI_GATEWAY_AUTH_TOKEN=<worker-auth-token>

# Alerting
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Optional
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=
```

SSH_USER and SSH_PORT are changed in the hardening steps during deployment.

---

## Setup Question Flow

**ALWAYS start this flow when the user's intent is ambiguous or general** (e.g., "hi", "start", "let's go", "help me", or any message that doesn't clearly ask for something else like editing a specific file). Also start this flow when the user explicitly requests deployment or mentions VPS work. The Setup Question Flow is the default entry point for this project.

### Step 0: Check Configuration File

Before presenting any options, check if `openclaw-config.env` exists:

```bash
ls openclaw-config.env 2>/dev/null
```

**If missing:** Stop and prompt the user:

> "No `openclaw-config.env` found. Please create this file with your configuration:
>
> ```bash
> cp openclaw-config.example.env openclaw-config.env
> # Then fill in the required values
> ```
>
> Once created, let me know and we'll continue."

**If exists:** Validate required fields:

Required fields to check in openclaw-config.env:

- `VPS1_IP` - Must be a valid IP
- `SSH_KEY_PATH` - Must exist on local system
- `SSH_USER` - Must be set (typically `ubuntu` for fresh OVH VPS)
- `DOMAIN_OPENCLAW` - Must be set
- `ANTHROPIC_API_KEY` - Must be set, can be a placeholder

If any required field is missing, report all missing fields and ask user to update the file.

If all required fields are present, test SSH access to VPS-1:

```bash
ssh -i <SSH_KEY_PATH> -o ConnectTimeout=10 -o BatchMode=yes -p <SSH_PORT> <SSH_USER>@<VPS1_IP> echo "VPS1 OK"
```

**If SSH fails:** Stop and help troubleshoot:

> "Cannot connect to VPS. Please add your ssh key and make sure you can SSH in:
>
> "Add your ssh key:"
> ssh-add <SSH_KEY_PATH>
>
> "Test SSH:"
> ssh -p <SSH_PORT> <SSH_USER>@<VPS1_IP> echo "VPS1 OK"
>
> "Once SSH works, return here and say 'continue'

**If SSH succeeds:** Proceed to Step 1.

### Step 1: Deployment Type Selection

Present the main options:

> "What would you like to do?"
>
> 1. **New deployment** - Fresh VPS, run full setup
> 2. **Existing deployment** - VPS already has some configuration

---

### Path A: New Deployment

#### A1. Networking Option

If `NETWORKING_OPTION` is not set in config:

> "Which networking solution do you want to use?"
>
> - **cloudflare-tunnel** (Recommended) - Zero exposed ports, origin IP hidden
> - **caddy** - Port 443 exposed, uses Cloudflare Origin CA

Save the selection to `openclaw-config.env`.

#### A2. Playbook Selection

Present playbook selection:

> "Select playbooks to run:"
>
> **Core deployment** (selected by default):
>
> - [x] Base deployment (01, 03, 04, networking, 06-08)
>   - Includes: base-setup, docker, openclaw, networking, backup, workers, verification
>
> **Optional features** (from `playbooks/extras/`):
>
> - [ ] Sandbox & Browser (`extras/sandbox-and-browser.md`) — Rich sandbox, browser, gateway packages, Claude Code CLI

#### A3. Confirmation

Show summary and confirm:

> "Ready to deploy:
>
> - VPS-1: `<VPS1_IP>` (OpenClaw)
> - Networking: `<NETWORKING_OPTION>`
> - Domain: `<DOMAIN_OPENCLAW>`
> - Playbooks: Base deployment
>
> Proceed?"

---

### Path B: Existing Deployment

#### B1. Check for State Files

```bash
ls .state/*.md 2>/dev/null
```

**If no state files exist:**

> "No state files found. I recommend analyzing your current setup first to understand what's already configured.
>
> Run analysis mode now?"
>
> - **Yes** - Execute `00-analysis-mode.md`
> - **No** - Skip analysis and proceed to options

#### B2. Existing Deployment Options

Present options for existing deployments:

> "What would you like to do?"
>
> 1. **Re-analyze** - Verify current state matches state files
> 2. **Test** - Run verification checks (`07-verification.md`)
> 3. **Modify** - Add features or make changes

#### B3. Modify Sub-flow

When user selects "Modify":

> "What modifications do you want to make?"
>
> **Available extras** (from `playbooks/extras/`):
>
> - [ ] Sandbox & Browser (`extras/sandbox-and-browser.md`) — Rich sandbox, browser, gateway packages, Claude Code CLI
>
> **Other options:**
>
> - **Something else** - Describe what you need

If user selects "Something else," trigger `99-new-feature-planning.md` workflow.

#### B4. Confirmation

After action selection, show summary:

> "Ready to execute:
>
> - VPS-1: `<VPS1_IP>`
> - Action: [selected action]
>
> Proceed?"

---

## Execution Order

### Full Deployment

```
1. Validate openclaw-config.env
2. Execute 01-base-setup.md on VPS-1
3. Execute 03-docker.md on VPS-1
4. Execute 04-vps1-openclaw.md on VPS-1
5. Execute networking/<NETWORKING_OPTION>.md on VPS-1
6. Execute 06-backup.md on VPS-1
7. Execute 08-workers.md (deploy Cloudflare Workers)
8. Reboot VPS-1
9. Execute 07-verification.md
10. Execute 98-post-deploy.md
```

All steps are sequential on a single VPS. Workers deployment (step 7) runs from the local machine using `wrangler`.

---

## Networking Options

### Cloudflare Tunnel (Recommended)

Use when:

- Maximum security is priority
- Origin IP must be hidden
- No ports should be exposed

**Prerequisites:** Cloudflare account, domain DNS managed by Cloudflare
**Certificates needed:** None - tunnel handles TLS automatically

Benefits:

- Zero exposed ports (443 closed)
- Origin IP hidden from attackers
- Built-in DDoS protection
- Cloudflare Access for authentication

Execute: `playbooks/networking/cloudflare-tunnel.md` (VPS-1 only)

### Caddy Reverse Proxy

Use when:

- Simpler setup preferred
- No Cloudflare account available
- Direct origin access needed

**Prerequisites:** Cloudflare account, Origin CA certificate generated
**Certificates needed:** Yes - must generate in Cloudflare Dashboard first

Trade-offs:

- Port 443 exposed
- Origin IP discoverable

Execute: `playbooks/networking/caddy.md` (VPS-1 only)

---

## Quick Reference

### SSH Access

```bash
# After base setup, SSH as adminclaw (not ubuntu)
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p <SSH_PORT:222> <SSH_USER:adminclaw>@<VPS1-IP>

# Run commands as openclaw
sudo -u openclaw <command>

# Interactive shell as openclaw
sudo su - openclaw
```

### Service Management

```bash
# OpenClaw Gateway
cd /home/openclaw/openclaw
sudo -u openclaw docker compose up -d      # Start
sudo -u openclaw docker compose down       # Stop
sudo -u openclaw docker compose logs -f    # Logs
sudo -u openclaw docker compose ps         # Status

# Vector logs (log shipper)
sudo -u openclaw docker compose logs vector        # View Vector logs
sudo -u openclaw docker compose logs -f vector     # Follow Vector logs
sudo -u openclaw docker compose restart vector     # Restart Vector
```

### Firewall

```bash
sudo ufw status    # View rules
sudo ufw allow <port>  # Add rule
sudo ufw reload    # Reload
```

### Workers (from local machine)

```bash
# Log Receiver Worker
cd workers/log-receiver
npm run deploy                    # Deploy
curl https://<log-worker>/health  # Health check

# AI Gateway Worker
cd workers/ai-gateway
npm run deploy                    # Deploy
curl https://<ai-gateway>/health  # Health check
```

---

## Security Model

Two-user security model on VPS-1:

| User | SSH Access | Sudo | Purpose |
|------|------------|------|---------|
| `adminclaw` | Key only (port 222) | Passwordless | System administration |
| `openclaw` | None | None | Application runtime |

Security benefits:

- If `openclaw` is compromised, attacker cannot escalate to root
- `adminclaw` is not a well-known username
- Clear separation: admin tasks vs application runtime

---

## Troubleshooting Index

Each playbook contains detailed troubleshooting sections. Common issues:

| Issue | Playbook Section |
|-------|------------------|
| SSH lockout | `01-base-setup.md` -> Troubleshooting |
| Container won't start | `04-vps1-openclaw.md` -> Troubleshooting |
| Tunnel not starting | `networking/cloudflare-tunnel.md` -> Troubleshooting |
| Backup permission denied | `06-backup.md` -> Troubleshooting |
| Worker deployment fails | `08-workers.md` -> Troubleshooting |
| Vector not shipping logs | `04-vps1-openclaw.md` -> Troubleshooting |

---

## Key Deployment Notes

1. **Two-user security model**: `adminclaw` for admin, `openclaw` for app
2. **SSH port change**: Configure UFW BEFORE changing SSH to port 222
3. **SSH on Ubuntu**: Keep `UsePAM yes`, use service name `ssh` not `sshd`
4. **File ownership**: Container runs as uid 1000, `.openclaw` must be owned by uid 1000
5. **OpenClaw config**: Keep `openclaw.json` minimal - rejects unknown keys
6. **Gateway startup**: Use `--allow-unconfigured` flag for initial startup
7. **Backup permissions**: Run as root via `/etc/cron.d/`
8. **Bind mounts only:** Never use Docker named volumes -- use bind mounts (`./data/<service>:/path`) so `rsync` can back up everything from the host
9. **Entrypoint script:** Gateway uses bind-mounted entrypoint that cleans lock files, bootstraps sandbox images, then runs `exec "$@"` (full command comes from compose override)
10. **Self-restart:** `commands.restart: true` enables agents to modify config and trigger in-process restart via SIGUSR1
11. **UI subpaths:** Configure `SUBPATH_OPENCLAW` in openclaw-config.env; gateway uses `controlUi.basePath`; Caddy must use `handle` (not `handle_path`) to preserve the prefix
12. **Trusted proxies:** `gateway.trustedProxies: ["172.30.0.1"]` for Cloudflare Tunnel (cloudflared connects via Docker bridge). Not needed for Caddy (host network). Only exact IPs work (no CIDR).
13. **Device pairing:** New devices get "pairing required" on first connect. Approve via CLI: `sudo docker exec openclaw-gateway node dist/index.js devices approve <requestId>`. Once one device is paired, approve others from the Control UI.
14. **Build script:** `scripts/build-openclaw.sh` auto-patches upstream Dockerfile before `docker build`, then restores git tree. Patches auto-skip when upstream fixes land
15. **Rich sandbox:** `openclaw-sandbox-common:bookworm-slim` includes Node.js, git, and dev tools -- used as default sandbox image for agent tasks
16. **Browser sandbox:** `openclaw-sandbox-browser:bookworm-slim` includes Chromium + noVNC -- browser tasks viewable through Control UI, no extra ports needed (proxied through gateway)
17. **Gateway extras:** `OPENCLAW_DOCKER_APT_PACKAGES` in `.env` passes apt packages as `--build-arg` to Docker build. Claude Code CLI installed globally via Dockerfile patch
18. **Config permissions:** Entrypoint enforces `chmod 600` on `openclaw.json` every startup -- gateway may rewrite with looser permissions on config changes
19. **Docker-in-Docker:** Requires `user: "0:0"` and `read_only: false` in compose -- Sysbox maps uid 0 to unprivileged user on host, and auto-provisions `/var/lib/docker` and `/var/lib/containerd` (but they inherit `read_only`, so must be `false`). Entrypoint starts `dockerd`, then uses `gosu node` to drop privileges before gateway start.
20. **Sandbox mode:** `sandbox.mode: "all"` requires Docker installed inside the container (build patch #5). Without Docker, `spawn docker` crashes the gateway with EACCES. Use `"non-main"` as fallback.
21. **Vector log shipper:** Collects Docker container logs and ships to Log Receiver Worker. Config in `vector.toml`. Checkpoints in `./data/vector/` survive restarts.
22. **AI Gateway Worker:** Routes LLM requests through Cloudflare AI Gateway for analytics. Real API keys live on the Worker, not on the VPS. Set `ANTHROPIC_BASE_URL` to the Worker URL.
23. **Host alerter:** `scripts/host-alert.sh` runs via cron every 15 minutes. Checks disk, memory, CPU, Docker health. Sends Telegram alerts on threshold breach. Only alerts on state change (avoids spam).
24. **Cloudflare Health Check:** Configure in Cloudflare dashboard on `https://<DOMAIN_OPENCLAW>/health` for uptime monitoring with email/webhook alerts.

---

## Security Checklist

### VPS-1 (OpenClaw)

- [ ] SSH hardened (port 222, key-only, AllowUsers adminclaw)
- [ ] UFW enabled with minimal rules (SSH only)
- [ ] Fail2ban running
- [ ] Automatic security updates enabled
- [ ] Kernel hardening applied
- [ ] Sysbox runtime installed
- [ ] OpenClaw gateway running
- [ ] Vector shipping logs to Worker
- [ ] Backup cron job configured
- [ ] Host alerter cron job configured

### Networking (Cloudflare Tunnel)

- [ ] Port 443 closed
- [ ] Tunnel running on VPS-1
- [ ] DNS routes through tunnel
- [ ] Cloudflare Access configured

### Networking (Caddy)

- [ ] Port 443 open
- [ ] Origin CA certificates installed
- [ ] Cloudflare SSL mode "Full (strict)"
- [ ] Port 80 blocked

### Workers

- [ ] Log Receiver Worker deployed and healthy
- [ ] AI Gateway Worker deployed and healthy
- [ ] Worker auth tokens set as secrets
- [ ] Cloudflare Health Check configured
