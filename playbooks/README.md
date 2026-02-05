# OpenClaw VPS Playbooks

This directory contains modular playbooks for deploying OpenClaw across two VPS instances.

## Playbook Index

| Playbook | Description | VPS-1 | VPS-2 |
|----------|-------------|:-----:|:-----:|
| [01-base-setup.md](01-base-setup.md) | Users, SSH, UFW, fail2ban, kernel hardening | ✓ | ✓ |
| [02-wireguard.md](02-wireguard.md) | WireGuard tunnel between VPSs | ✓ | ✓ |
| [03-docker.md](03-docker.md) | Docker installation and hardening | ✓ | ✓ |
| [04-vps1-openclaw.md](04-vps1-openclaw.md) | Sysbox, networks, gateway, promtail | ✓ | - |
| [05-vps2-observability.md](05-vps2-observability.md) | Prometheus, Grafana, Loki, Alertmanager | - | ✓ |
| [06-backup.md](06-backup.md) | Backup scripts and cron jobs | ✓ | - |
| [07-verification.md](07-verification.md) | Testing and verification procedures | ✓ | ✓ |

### Networking Options (Choose One)

| Playbook | Description | Pros | Cons |
|----------|-------------|------|------|
| [networking/cloudflare-tunnel.md](networking/cloudflare-tunnel.md) | Cloudflare Tunnel (Recommended) | Zero exposed ports, origin IP hidden, built-in DDoS protection | Requires Cloudflare account |
| [networking/caddy.md](networking/caddy.md) | Caddy reverse proxy with Origin CA | Simpler setup, no Cloudflare dependency | Port 443 exposed, origin IP discoverable |

## Execution Order

### Full Deployment

```
1. Read ../openclaw-config.env and validate settings
2. Execute 01-base-setup.md on VPS-1
3. Execute 01-base-setup.md on VPS-2
4. Execute 02-wireguard.md on both VPSs
5. Execute 03-docker.md on both VPSs
6. Execute 04-vps1-openclaw.md on VPS-1
7. Execute 05-vps2-observability.md on VPS-2
8. Execute networking/<chosen-option>.md on both VPSs
9. Execute 06-backup.md on VPS-1
10. Reboot both VPSs
11. Execute 07-verification.md on both VPSs
```

### Parallel Execution

Where possible, steps can be parallelized:

- Steps 2-3: Base setup on both VPSs (parallel)
- Steps 4-5: WireGuard on both VPSs (must complete both before testing)
- Steps 6-7: Docker on both VPSs (parallel)
- Steps 8-9: OpenClaw and Observability (parallel, different VPSs)

## Prerequisites

Before running any playbook:

1. **VPS Access**: SSH access to both VPSs as `ubuntu` user (initial OVH setup)
2. **SSH Key**: SSH key configured in `openclaw-config.env`
3. **Config File**: `../openclaw-config.env` populated with required values

## Configuration Variables

All playbooks read from `../openclaw-config.env`. Required variables:

```bash
# VPS Configuration (required)
VPS1_IP=X.X.X.X
VPS2_IP=Y.Y.Y.Y
VPS1_HOSTNAME=openclaw
VPS2_HOSTNAME=observe

# SSH Configuration (required)
SSH_KEY_PATH=~/.ssh/ovh_openclaw_ed25519
SSH_USER=ubuntu

# Networking (required)
NETWORKING_OPTION=cloudflare-tunnel  # or "caddy"
DOMAIN_OPENCLAW=claw.example.com
DOMAIN_GRAFANA=observe.example.com

# API Keys (required)
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Messaging Channels
TELEGRAM_BOT_TOKEN=
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=
```

## Playbook Format

Each playbook follows this structure:

1. **Overview** - What the playbook does
2. **Prerequisites** - What must be complete before running
3. **Variables** - Configuration needed (from openclaw-config.env)
4. **Steps** - Numbered execution steps with shell commands
5. **Verification** - How to confirm success
6. **Troubleshooting** - Common issues and fixes

## Security Model

This deployment uses a two-user security model:

| User | SSH Access | Sudo | Purpose |
|------|------------|------|---------|
| `adminclaw` | Key only | Passwordless | System administration, automation |
| `openclaw` | None | None | Application runtime, owns app files |

After initial setup, always SSH as `adminclaw` and use `sudo -u openclaw` for app operations.
