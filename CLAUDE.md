# CLAUDE.md — OpenClaw Two-VPS Deployment

## Overview

This document orchestrates the automated deployment of OpenClaw across two OVHCloud VPS instances.

| VPS | Role | WireGuard IP | Services |
|-----|------|--------------|----------|
| **VPS-1** | OpenClaw | `10.0.0.1` | Gateway, Sysbox, Node Exporter, Promtail |
| **VPS-2** | Observability | `10.0.0.2` | Prometheus, Grafana, Loki, Alertmanager, cAdvisor |

## Playbook Structure

All deployment steps are in modular playbooks under `playbooks/`:

| Playbook | Description | VPS-1 | VPS-2 |
|----------|-------------|:-----:|:-----:|
| `00-analysis-mode.md` | Analyze existing deployments | ✓ | ✓ |
| `01-base-setup.md` | Users, SSH, UFW, fail2ban, kernel | ✓ | ✓ |
| `02-wireguard.md` | WireGuard tunnel between VPSs | ✓ | ✓ |
| `03-docker.md` | Docker installation and hardening | ✓ | ✓ |
| `04-vps1-openclaw.md` | Sysbox, networks, gateway, promtail | ✓ | - |
| `05-vps2-observability.md` | Prometheus, Grafana, Loki, Alertmanager | - | ✓ |
| `networking/cloudflare-tunnel.md` | Cloudflare Tunnel (Recommended) | ✓ | ✓ |
| `networking/caddy.md` | Caddy reverse proxy with Origin CA | ✓ | ✓ |
| `06-backup.md` | Backup scripts and cron jobs | ✓ | - |
| `07-verification.md` | Testing and verification | ✓ | ✓ |
| `99-new-feature-planning.md` | Process for planning new features | - | - |
| `99-new-feature-implementation.md` | Process for implementing planned features | - | - |

Optional features are in `playbooks/extras/`. See `extras/README.md` for details.

See [playbooks/README.md](playbooks/README.md) for detailed playbook documentation.

---

## General Rules

- **Preserve comments in config files.** Comments document intent and aid future maintenance.
- **Update stale comments.** If code changes make a comment inaccurate, fix the comment.
- **Add comments for non-obvious settings.** Explain *why*, not *what*.

---

## Configuration

Read configuration from `openclaw-config.env`:

```bash
# Required
VPS1_IP=X.X.X.X              # VPS-1 public IP
VPS2_IP=Y.Y.Y.Y              # VPS-2 public IP
SSH_KEY_PATH=~/.ssh/key      # SSH private key path
SSH_USER=ubuntu              # Initial SSH user (OVH default)
NETWORKING_OPTION=cloudflare-tunnel  # or "caddy"
DOMAIN_OPENCLAW=claw.example.com
DOMAIN_GRAFANA=observe.example.com
ANTHROPIC_API_KEY=sk-ant-...

# Optional
TELEGRAM_BOT_TOKEN=
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=
```

---

## Setup Question Flow

When user requests deployment or mentions VPS work, determine the deployment state first.

### 0. Check for Existing State

First, check if state files exist:

```bash
ls .state/*.md 2>/dev/null
```

If state files exist, inform the user:

> "I found existing state files for this deployment. Would you like me to:"
>
> - **Use existing state** - Trust the recorded state and proceed
> - **Re-analyze** - Run analysis mode to verify current state
> - **Start fresh** - Ignore state files (for redeployment)

### 1. New vs Existing Deployment

If no state files exist, ask:

> "Is this a **new deployment** or an **existing deployment**?"
>
> - **New deployment** - Fresh VPSs, run full playbook sequence
> - **Existing deployment** - VPSs already configured, run analysis mode first

If existing deployment, execute `00-analysis-mode.md` before proceeding.

### 2. Read Configuration

```bash
# Source the config file
source ~/openclaw-config.env
```

### 3. Validate Required Settings

Check for required values:

- `VPS1_IP`, `VPS2_IP` - Required
- `SSH_KEY_PATH`, `SSH_USER` - Required
- `NETWORKING_OPTION` - Prompt if missing
- `DOMAIN_OPENCLAW`, `DOMAIN_GRAFANA` - Required for networking
- `ANTHROPIC_API_KEY` - Required

### 4. Prompt for Missing Settings

If `NETWORKING_OPTION` is not set:

> "NETWORKING_OPTION is not set. Which networking solution?"
>
> - **cloudflare-tunnel** (Recommended) - Zero exposed ports, origin IP hidden
> - **caddy** - Port 443 exposed, uses Cloudflare Origin CA

### 5. Confirm Before Proceeding

> "Ready to deploy with:
>
> - VPS-1: X.X.X.X (OpenClaw)
> - VPS-2: Y.Y.Y.Y (Observability)
> - Networking: Cloudflare Tunnel
> - Domain: claw.example.com, observe.example.com
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
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 adminclaw@<VPS1-IP>
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 adminclaw@<VPS2-IP>

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
8. **UFW on VPS-1**: Allow ports 9100 and 18789 from WireGuard (10.0.0.0/24)
9. **Loki schema**: Use v13 with tsdb store
10. **Grafana subpath**: Use `handle` not `handle_path` in Caddy
11. **Backup permissions**: Run as root via `/etc/cron.d/`

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
