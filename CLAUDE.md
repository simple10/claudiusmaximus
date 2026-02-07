# CLAUDE.md — OpenClaw Two-VPS Deployment

## Overview

This document orchestrates the automated deployment of OpenClaw across two OVHCloud VPS instances.

| VPS | Role | WireGuard IP | Services |
|-----|------|--------------|----------|
| **VPS-1** | OpenClaw | `10.0.0.1` | Gateway, Sysbox, Node Exporter, Promtail |
| **VPS-2** | Observability | `10.0.0.2` | Prometheus, Grafana, Loki, Tempo, Alertmanager, cAdvisor |

## Playbook Structure

All deployment steps are in modular playbooks under `playbooks/`:

| Playbook | Description | VPS-1 | VPS-2 |
|----------|-------------|:-----:|:-----:|
| `00-analysis-mode.md` | Analyze existing deployments | ✓ | ✓ |
| `01-base-setup.md` | Users, SSH, UFW, fail2ban, kernel | ✓ | ✓ |
| `02-wireguard.md` | WireGuard tunnel between VPSs | ✓ | ✓ |
| `03-docker.md` | Docker installation and hardening | ✓ | ✓ |
| `04-vps1-openclaw.md` | Sysbox, networks, gateway, promtail | ✓ | - |
| `05-vps2-observability.md` | Prometheus, Grafana, Loki, Tempo, Alertmanager | - | ✓ |
| `networking/cloudflare-tunnel.md` | Cloudflare Tunnel (Recommended) | ✓ | ✓ |
| `networking/caddy.md` | Caddy reverse proxy with Origin CA | ✓ | ✓ |
| `06-backup.md` | Backup scripts and cron jobs | ✓ | - |
| `07-verification.md` | Testing and verification | ✓ | ✓ |
| `98-post-deploy.md` | First access & device pairing | ✓ | - |
| `99-new-feature-planning.md` | Process for planning new features | - | - |
| `99-new-feature-implementation.md` | Process for implementing planned features | - | - |

Optional features are in `playbooks/extras/`. See `extras/README.md` for details.

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
VPS2_IP=Y.Y.Y.Y                             # VPS-2 public IP
SSH_KEY_PATH=~/.ssh/ovh_openclaw_ed25519    # SSH private key path
SSH_USER=adminclaw                          # SSH user (initially ubuntu then changed to adminclaw during hardening)
SSH_PORT=222                                # SSH port (initially 22 then changed to 222 during hardening)
NETWORKING_OPTION=cloudflare-tunnel         # or "caddy"
DOMAIN_OPENCLAW=openclaw.example.com
DOMAIN_GRAFANA=observe.example.com
ANTHROPIC_API_KEY=sk-ant-...

# URL subpaths (no trailing slash; empty string "" to serve at root)
SUBPATH_OPENCLAW=/_openclaw
SUBPATH_GRAFANA=/_observe/grafana

# Optional
TELEGRAM_BOT_TOKEN=
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

- `VPS1_IP`, `VPS2_IP` - Must be valid IPs
- `SSH_KEY_PATH` - Must exist on local system
- `SSH_USER` - Must be set (typically `ubuntu` for fresh OVH VPS)
- `DOMAIN_OPENCLAW`, `DOMAIN_GRAFANA` - Must be set
- `ANTHROPIC_API_KEY` - Must be set, can be a placeholder

If any required field is missing, report all missing fields and ask user to update the file.

If all required fields are present, test SSH access to both VPSs:

```bash
ssh -i <SSH_KEY_PATH> -o ConnectTimeout=10 -o BatchMode=yes -p <SSH_PORT> <SSH_USER>@<VPS1_IP> echo "VPS1 OK"
ssh -i <SSH_KEY_PATH> -o ConnectTimeout=10 -o BatchMode=yes -p <SSH_PORT> <SSH_USER>@<VPS2_IP> echo "VPS2 OK"
```

**If SSH fails:** Stop and help troubleshoot:

> "Cannot connect to VPS. Please add your ssh and make sure you can SSH into each VPS:
>
> "Add your ssh key:"
> ssh-add <SSH_KEY_PATH>
>
> "Test SSH:"
> ssh -p <SSH_PORT> <SSH_USER>@<VPS1_IP> echo "VPS1 OK"
> ssh -p <SSH_PORT> <SSH_USER>@<VPS2_IP> echo "VPS2 OK"
>
> "Once SSH works, return here and say 'continue'

**If SSH succeeds:** Proceed to Step 1.

### Step 1: Deployment Type Selection

Present the main options:

> "What would you like to do?"
>
> 1. **New deployment** - Fresh VPSs, run full setup
> 2. **Existing deployment** - VPSs already have some configuration

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
> - [x] Base deployment (01-07 + networking)
>   - Includes: base-setup, wireguard, docker, openclaw, observability, networking, backup, verification
>
> **Optional features** (from `playbooks/extras/`):
>
> - [ ] *(None currently available)*

#### A3. Confirmation

Show summary and confirm:

> "Ready to deploy:
>
> - VPS-1: `<VPS1_IP>` (OpenClaw)
> - VPS-2: `<VPS2_IP>` (Observability)
> - Networking: `<NETWORKING_OPTION>`
> - Domains: `<DOMAIN_OPENCLAW>`, `<DOMAIN_GRAFANA>`
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
> - *(None currently available)*
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
> - VPS-2: `<VPS2_IP>`
> - Action: [selected action]
>
> Proceed?"

---

## Execution Order

### Full Deployment

```
1. Validate openclaw-config.env
2. Execute 01-base-setup.md on VPS-1
3. Execute 01-base-setup.md on VPS-2
4. Execute 02-wireguard.md on VPS-1
5. Execute 02-wireguard.md on VPS-2
6. Execute 03-docker.md on VPS-1
7. Execute 03-docker.md on VPS-2
8. Execute 04-vps1-openclaw.md on VPS-1
9. Execute 05-vps2-observability.md on VPS-2
10. Execute networking/<NETWORKING_OPTION>.md on VPS-1
11. Execute networking/<NETWORKING_OPTION>.md on VPS-2
12. Execute 06-backup.md on VPS-1
13. Reboot both VPSs
14. Execute 07-verification.md
15. Execute 98-post-deploy.md
```

### Parallel Execution

Steps that can run in parallel:

- Steps 2-3: Base setup (both VPSs)
- Steps 4-5: WireGuard (both VPSs)
- Steps 6-7: Docker (both VPSs)
- Steps 8-9: OpenClaw and Observability (different VPSs)
- Steps 10-11: Networking (both VPSs)

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

Execute: `playbooks/networking/cloudflare-tunnel.md`

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

Execute: `playbooks/networking/caddy.md`

---

## Quick Reference

### SSH Access

```bash
# After base setup, SSH as adminclaw (not ubuntu)
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p <SSH_PORT:222> <SSH_USER:adminclaw>@<VPS1-IP>
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p <SSH_PORT:222> <SSH_USER:adminclaw>@<VPS2-IP>

# Run commands as openclaw
sudo -u openclaw <command>

# Interactive shell as openclaw
sudo su - openclaw
```

### Service Management

```bash
# VPS-1: OpenClaw
cd /home/openclaw/openclaw
sudo -u openclaw docker compose up -d      # Start
sudo -u openclaw docker compose down       # Stop
sudo -u openclaw docker compose logs -f    # Logs
sudo -u openclaw docker compose ps         # Status

# VPS-2: Monitoring
cd /home/openclaw/monitoring
sudo -u openclaw docker compose up -d
sudo -u openclaw docker compose down
sudo -u openclaw docker compose logs -f
sudo -u openclaw docker compose ps
```

### WireGuard

```bash
sudo wg show                        # Status
sudo systemctl restart wg-quick@wg0 # Restart
```

### Firewall

```bash
sudo ufw status    # View rules
sudo ufw allow <port>  # Add rule
sudo ufw reload    # Reload
```

---

## Security Model

Two-user security model on both VPSs:

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
| SSH lockout | `01-base-setup.md` → Troubleshooting |
| WireGuard not connecting | `02-wireguard.md` → Troubleshooting |
| Container won't start | `04-vps1-openclaw.md` → Troubleshooting |
| Prometheus not scraping | `05-vps2-observability.md` → Troubleshooting |
| Tunnel not starting | `networking/cloudflare-tunnel.md` → Troubleshooting |
| Grafana redirect loop | `networking/caddy.md` → Troubleshooting |
| Backup permission denied | `06-backup.md` → Troubleshooting |

---

## Key Deployment Notes

1. **Two-user security model**: `adminclaw` for admin, `openclaw` for app
2. **SSH port change**: Configure UFW BEFORE changing SSH to port 222
3. **SSH on Ubuntu**: Keep `UsePAM yes`, use service name `ssh` not `sshd`
4. **Docker networks**: Use 172.30.x.x to avoid conflicts
5. **File ownership**: Container runs as uid 1000, `.openclaw` must be owned by uid 1000
6. **OpenClaw config**: Keep `openclaw.json` minimal - rejects unknown keys
7. **Gateway startup**: Use `--allow-unconfigured` flag for initial startup
8. **UFW on VPS-1**: Allow port 9100 (metrics) and 18789 (gateway debug) from WireGuard (10.0.0.0/24)
9. **Loki schema**: Use v13 with tsdb store
10. **Grafana subpath**: Use `handle` not `handle_path` in Caddy
11. **Backup permissions**: Run as root via `/etc/cron.d/`
12. **Tempo OTLP:** Binds to WireGuard IP (10.0.0.2:4318) for trace ingestion
13. **OpenClaw OTEL:** All signals enabled — traces→Tempo, metrics→Prometheus, logs→Loki
14. **Bind mounts only:** Never use Docker named volumes — use bind mounts (`./data/<service>:/path`) so `rsync` can back up everything from the host
15. **Entrypoint script:** Gateway uses bind-mounted entrypoint that cleans lock files, bootstraps sandbox images, then runs `exec "$@"` (full command comes from compose override)
16. **Self-restart:** `commands.restart: true` enables agents to modify config and trigger in-process restart via SIGUSR1
17. **UI subpaths:** Configure `SUBPATH_OPENCLAW` and `SUBPATH_GRAFANA` in openclaw-config.env; gateway uses `controlUi.basePath`, Grafana uses `GF_SERVER_SERVE_FROM_SUB_PATH`; Caddy must use `handle` (not `handle_path`) to preserve the prefix
18. **Trusted proxies:** `gateway.trustedProxies: ["172.30.0.1"]` for Cloudflare Tunnel (cloudflared connects via Docker bridge). Not needed for Caddy (host network). Only exact IPs work (no CIDR).
19. **Device pairing:** New devices get "pairing required" on first connect. Approve via CLI: `sudo docker exec openclaw-gateway node dist/index.js devices approve <requestId>`. Once one device is paired, approve others from the Control UI.
20. **Build script:** `scripts/build-openclaw.sh` auto-patches upstream Dockerfile and OTEL source before `docker build`, then restores git tree. Patches auto-skip when upstream fixes land

---

## Security Checklist

### Both VPSs

- [ ] SSH hardened (port 222, key-only, AllowUsers adminclaw)
- [ ] UFW enabled with minimal rules
- [ ] Fail2ban running
- [ ] Automatic security updates enabled
- [ ] Kernel hardening applied
- [ ] WireGuard tunnel active

### VPS-1 (OpenClaw)

- [ ] Sysbox runtime installed
- [ ] OpenClaw gateway running
- [ ] Node Exporter accessible via WireGuard
- [ ] Promtail shipping logs
- [ ] Backup cron job configured

### VPS-2 (Observability)

- [ ] All monitoring containers running
- [ ] Prometheus scraping all targets
- [ ] Loki receiving logs
- [ ] Tempo OTLP receiver on WireGuard only
- [ ] Grafana accessible

### Networking (Cloudflare Tunnel)

- [ ] Port 443 closed
- [ ] Tunnel running on both VPSs
- [ ] DNS routes through tunnel
- [ ] Cloudflare Access configured

### Networking (Caddy)

- [ ] Port 443 open
- [ ] Origin CA certificates installed
- [ ] Cloudflare SSL mode "Full (strict)"
- [ ] Port 80 blocked
