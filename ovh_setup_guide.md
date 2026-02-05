# OVHCloud Setup Guide for OpenClaw Deployment

This guide covers the manual steps you need to complete before handing off to Claude Code.

---

## Overview

You'll be setting up **two VPS-2 instances** on OVHCloud:

| VPS | Purpose | Hostname | IP (example) |
|-----|---------|----------|--------------|
| VPS-1 | OpenClaw (gateway + sandboxes) | `openclaw` | `51.x.x.1` |
| VPS-2 | Observability (monitoring + logging) | `observe` | `51.x.x.2` |

---

## Step 1: Create OVHCloud Account

1. Go to [us.ovhcloud.com](https://us.ovhcloud.com) (or your regional OVHCloud site)
2. Create an account or log in
3. Add a payment method
4. Verify your email and identity if prompted

---

## Step 2: Order Two VPS-2 Instances

### For each VPS

1. Navigate to **Bare Metal & VPS → VPS**
2. Click **Configure your VPS** or select **VPS-2** ($6.75/mo)
3. Configure:

   | Setting | Value |
   |---------|-------|
   | **Model** | VPS-2 (6 vCores, 12GB RAM, 100GB NVMe) |
   | **Location** | Choose a **standard datacenter** (not Local Zone) — e.g., Vint Hill VA, Hillsboro OR, or EU |
   | **Operating System** | **Ubuntu 24.04 LTS** |
   | **SSH Key** | Add your public SSH key (see below) |
   | **Hostname** | `openclaw` for VPS-1, `observe` for VPS-2 |

4. Complete checkout for both VPSs

### Generate SSH Key (if you don't have one)

```bash
# On your local machine
ssh-keygen -t ed25519 -C "ovh-openclaw-vps" -f ~/.ssh/ovh_openclaw_ed25519
# Enter a secure password when prompted, used to decrypt the local private key

# Update permissions for all local keys
chmod -R 600 ~/.ssh/*

# View public key to paste into OVHCloud
cat ~/.ssh/ovh_openclaw_ed25519.pub

# Optionally add ssh key for local sessions - needed for claude to do it's work
ssh-add ~/.ssh/ovh_openclaw_ed25519
```

---

## Step 3: Wait for Provisioning

OVHCloud typically provisions VPSs within 5-15 minutes. You'll receive:

- Email confirmation with IP addresses
- Access credentials in OVHCloud Control Panel

### Find Your IPs

1. Log into [OVHCloud Control Panel](https://manager.us.ovhcloud.com)
2. Go to **Bare Metal Cloud → VPS**
3. Note the **IPv4 addresses** for both VPSs

Record them here:

```
VPS-1 (openclaw):  <VPS1_IP>
VPS-2 (observe):  <VPS2_IP>
```

---

## Step 4: Verify SSH Access

Test SSH access to both VPSs from your local machine:

```bash
# Test VPS-1 (OpenClaw)
ssh -i ~/.ssh/ovh_openclaw_ed25519 ubuntu@<VPS-1-IP>

# Test VPS-2 (Observability)
ssh -i ~/.ssh/ovh_openclaw_ed25519 ubuntu@<VPS-2-IP>
```

On first connection, accept the host key fingerprint.

### Troubleshooting SSH

If you can't connect:

1. **Check firewall**: OVHCloud VPSs should have port 22 open by default
2. **Check username**: Ubuntu 24.04 uses `ubuntu` as the default user
3. **Use KVM console**: In OVHCloud Control Panel, click your VPS → **KVM** to access directly

---

## Step 5: Verify System Requirements

SSH into each VPS and run these checks:

```bash
# Check Ubuntu version (should be 24.04)
lsb_release -a

# Check kernel version (should be 6.x)
uname -r

# Check available RAM
free -h

# Check disk space
df -h

# Check CPU info
nproc
```

Expected output:

- Ubuntu 24.04 LTS
- Kernel 6.x (e.g., 6.8.0-xx)
- ~12GB RAM
- ~100GB disk
- 6 vCores

---

## Step 6: Create DNS Records (Optional but Recommended)

If you have a domain, create A records pointing to your VPSs:

| Record | Type | Value |
|--------|------|-------|
| `openclaw.yourdomain.com` | A | `<VPS-1-IP>` |
| `grafana.yourdomain.com` | A | `<VPS-2-IP>` |

This enables:

- TLS certificates via Let's Encrypt
- Clean URLs instead of IP addresses

If you don't have a domain, you can still proceed — just use IP addresses directly.

---

## Step 7: Gather Required Credentials

Before running Claude Code, have these ready:

### Required

- [ ] **VPS-1 IP address**: `_______________`
- [ ] **VPS-2 IP address**: `_______________`
- [ ] **SSH private key path**: `~/.ssh/ovh_openclaw_ed25519`
- [ ] **Anthropic API key**: `sk-ant-...` (from [console.anthropic.com](https://console.anthropic.com))

### Optional (for messaging channels)

- [ ] **Telegram Bot Token**: Create via [@BotFather](https://t.me/BotFather)
- [ ] **Discord Bot Token**: From [Discord Developer Portal](https://discord.com/developers/applications)
- [ ] **Slack Bot Token**: From [Slack API](https://api.slack.com/apps)

### Optional (for DNS/TLS)

- [ ] **Domain name**: `_______________`
- [ ] **Email for Let's Encrypt**: `_______________`

---

## Step 8: Create Configuration File for Claude Code

Create a file with your configuration that Claude Code will use:

```bash
# On your local machine, create this file
cat > ~/openclaw-config.env << 'EOF'
# VPS Configuration
VPS1_IP=<your-vps-1-ip>
VPS1_HOSTNAME=openclaw
VPS2_IP=<your-vps-2-ip>
VPS2_HOSTNAME=observe

# SSH Configuration
SSH_KEY_PATH=~/.ssh/ovh_openclaw_ed25519
SSH_USER=ubuntu

# Domain Configuration (leave empty if not using)
DOMAIN=
LETSENCRYPT_EMAIL=

# API Keys
ANTHROPIC_API_KEY=

# Messaging Channels (leave empty if not using)
TELEGRAM_BOT_TOKEN=
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
EOF
```

Fill in your actual values, then verify:

```bash
cat ~/openclaw-config.env
```

---

## Step 9: Hand Off to Claude Code

You're now ready for Claude Code to automate the rest. Provide Claude Code with:

1. **This configuration file**: `~/openclaw-config.env`
2. **The CLAUDE.md file**: Contains all instructions for automated setup
3. **SSH access**: Claude Code will need to run commands on both VPSs

### What Claude Code Will Do

1. **On both VPSs:**
   - System updates and hardening
   - Create dedicated `openclaw` user
   - Configure UFW firewall
   - Set up Fail2ban
   - Install Docker
   - Set up WireGuard tunnel between VPSs

2. **On VPS-1 (OpenClaw):**
   - Install Sysbox runtime
   - Deploy OpenClaw gateway
   - Configure Caddy reverse proxy
   - Set up Node Exporter + Promtail (ships metrics/logs to VPS-2)

3. **On VPS-2 (Observability):**
   - Deploy Prometheus, Grafana, Loki, Alertmanager
   - Configure dashboards and alerting
   - Set up log aggregation

---

## Quick Reference

### SSH Commands

**Note**: After deployment, SSH uses port 222 (not 22). During initial setup, use the default port 22.

```bash
# SSH to OpenClaw VPS (before deployment - default port 22)
ssh -i ~/.ssh/ovh_openclaw_ed25519 ubuntu@<VPS-1-IP>

# SSH to Observability VPS (before deployment - default port 22)
ssh -i ~/.ssh/ovh_openclaw_ed25519 ubuntu@<VPS-2-IP>

# After deployment - use port 222 and openclaw user
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 openclaw@<VPS-1-IP>
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 openclaw@<VPS-2-IP>
```

### OVHCloud Control Panel Links

- VPS Management: <https://manager.us.ovhcloud.com> → Bare Metal Cloud → VPS
- KVM Console: Click your VPS → More options → KVM
- Reboot/Rescue: Click your VPS → Actions

### Support

- OVHCloud Support: <https://help.ovhcloud.com>
- OpenClaw Docs: <https://docs.openclaw.ai>
- OpenClaw GitHub: <https://github.com/openclaw/openclaw>

---

## Checklist Before Claude Code

- [ ] Both VPSs provisioned and running
- [ ] SSH access verified to both VPSs
- [ ] Ubuntu 24.04 LTS installed on both
- [ ] Kernel version is 6.x on both
- [ ] Configuration file created (`~/openclaw-config.env`)
- [ ] Anthropic API key ready
- [ ] (Optional) Domain DNS records created
- [ ] (Optional) Messaging bot tokens ready

Once complete, proceed with CLAUDE.md!
