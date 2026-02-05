# OpenClaw Two-VPS Deployment

This repository contains everything needed to deploy OpenClaw across two OVHCloud VPS instances with full observability.

## Architecture

| VPS | Role | Services |
|-----|------|----------|
| **VPS-1** | OpenClaw | Gateway, Sysbox runtime, Node Exporter, Promtail |
| **VPS-2** | Observability | Prometheus, Grafana, Loki, Alertmanager, cAdvisor |

The two VPSs communicate over a secure WireGuard tunnel (`10.0.0.1` ↔ `10.0.0.2`).

---

## Prerequisites

- Two VPS instances (Ubuntu 24.04 LTS)
- SSH key pair for authentication
- Anthropic API key for OpenClaw (placeholder can be used)
- (Optional) Domain with Cloudflare DNS for SSL

Anthropic API key is needed for OpenClaw to run.
However, it can be added after setup is complete.

---

## Quick Start

### Step 1: Set Up OVHCloud Account and VPSs

Follow the detailed instructions in **[ovh_setup_guide.md](./ovh_setup_guide.md)** to:

1. Create an OVHCloud account
2. Order two VPS-2 instances
3. Generate and configure SSH keys
4. Verify SSH access to both VPSs
5. Create the `openclaw-config.env` configuration file
6. Create or add Anthropic Key, Telegram Bot, etc. to env file

### Step 2: Create Config Env File

```bash
cp openclaw-config.env.example openclaw-config.env
```

### Step 2.1: Add Keys for OpenClaw (for messaging channels)

These can be optionally added after deploy. Anthropic Key is required for OpenClaw to initialize.
Messaging channel keys are not needed if using the OpenClaw UI for chat.

- [ ] **Anthropic API key**: `sk-ant-...` (from [console.anthropic.com](https://console.anthropic.com))
- [ ] **Telegram Bot Token**: Create via [@BotFather](https://t.me/BotFather)
- [ ] **Discord Bot Token**: From [Discord Developer Portal](https://discord.com/developers/applications)
- [ ] **Slack Bot Token**: From [Slack API](https://api.slack.com/apps)

Fill in your actual values in openclaw-config.env.

### Step 2.2: Choose Networking Option

| Option | What You Need | Best For |
|--------|---------------|----------|
| **Cloudflare Tunnel** (Recommended) | Cloudflare account with domain | Maximum security, zero exposed ports |
| **Caddy** | Cloudflare Origin CA certificate | Simpler setup, direct origin access |

Update `openclaw-config.env` with your choice:

```bash
NETWORKING_OPTION=cloudflare-tunnel  # or "caddy"
DOMAIN_OPENCLAW=claw.example.com
DOMAIN_GRAFANA=observe.example.com
```

**If using Caddy:** Follow [docs/CLOUDFLARE-SSL.md](docs/CLOUDFLARE-SSL.md) to generate Origin CA certificates first.

**If using Cloudflare Tunnel:** No certificates needed - skip to Step 3.

### Step 3: Deploy with Claude Code

You're now ready for Claude Code to automate the rest. Provide Claude Code with:

1. **The configuration file**: `~/openclaw-config.env`
2. **The CLAUDE.md file**: Contains all instructions for automated setup
3. **SSH access**: Claude Code will need to run commands on both VPSs

4. Ensure your SSH key is loaded:

   ```bash
   ssh-add ~/.ssh/ovh_openclaw_ed25519
   ```

5. Open Claude Code in this directory

   ```bash
   claude
   ```

6. Ask Claude to deploy OpenClaw

   **Example Prompt:**
   > Deploy the VPS servers following CLAUDE.md and using settings in openclaw-config.env

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
   - Configure Cloudflare Tunnel or Caddy

3. **On VPS-2 (Observability):**
   - Deploy Prometheus, Grafana, Loki, Alertmanager
   - Configure dashboards and alerting
   - Set up log aggregation
   - Configure Cloudflare Tunnel or Caddy

---

## Post-Deployment: Testing

Optionally ask Claude to run end-to-end tests:

> Run the tests in docts/TESTING.md using devtools mcp

**DevTools MCP** must already be installed and enabled in Claude Code to allow browser automation tests.

Claude will run a series of checks via ssh on the two VPS, then use a browser to check the UIs.

## Post-Deployment: Getting Started

### Access Your OpenClaw Dashboard

1. Navigate to your OpenClaw URL:
   - With domain: `https://claw.yourdomain.com/_openclaw/_admin`
   - Without domain: `https://<VPS-1-IP>/_openclaw/_admin`

2. **Important**: You need the gateway token to access the admin interface:

   ```bash
   # SSH to VPS-1 and get the token (note: SSH uses port 222, user is adminclaw)
   ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 adminclaw@<VPS-1-IP>
   cat /home/openclaw/openclaw/.env | grep OPENCLAW_GATEWAY_TOKEN
   ```

3. Enter the token when prompted at the `_admin` page

### Access Grafana

1. Navigate to your Grafana URL:
   - With domain: `https://observe.yourdomain.com/_observe/grafana/`
   - Without domain: `https://<VPS-2-IP>/_observe/grafana/`

2. Get the Grafana password:

   ```bash
   # SSH to VPS-2 and get the password (note: SSH uses port 222, user is adminclaw)
   ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 adminclaw@<VPS-2-IP>
   cat /home/openclaw/monitoring/.env | grep GRAFANA_PASSWORD
   ```

3. Login with:
   - **Username**: `admin`
   - **Password**: (from command above)

### View Logs in Grafana

1. Click the hamburger menu (☰) → **Explore**
2. Select **Loki** as the data source
3. Use Label filters to find logs:
   - `job = docker` - Container logs from VPS-1
   - `job = varlogs` - System logs
   - `host = openclaw` - All logs from VPS-1

---

## Verification

After deployment, verify everything is working:

### Quick Health Checks

```bash
# Check OpenClaw health endpoint (via obscured path)
curl -k https://<VPS-1-IP>/_openclaw/health

# Check Grafana is responding (via obscured path)
curl -k https://<VPS-2-IP>/_observe/grafana/api/health
```

### Service Status

```bash
# On VPS-1 (SSH port 222, user adminclaw)
ssh -p 222 adminclaw@<VPS-1-IP> "cd /home/openclaw/openclaw && sudo -u openclaw docker compose ps"

# On VPS-2 (SSH port 222, user adminclaw)
ssh -p 222 adminclaw@<VPS-2-IP> "cd /home/openclaw/monitoring && sudo -u openclaw docker compose ps"
```

### WireGuard Tunnel

```bash
# On VPS-1 (SSH port 222, user adminclaw)
ssh -p 222 adminclaw@<VPS-1-IP> "sudo wg show"
ssh -p 222 adminclaw@<VPS-1-IP> "ping -c 3 10.0.0.2"
```

For comprehensive testing, see **[docs/TESTING.md](./docs/TESTING.md)**.

---

## File Structure

```
openclaw-vps/
├── README.md                 # This file (for users)
├── CLAUDE.md                 # Deployment orchestration (for Claude)
├── ovh_setup_guide.md        # OVHCloud account setup instructions
├── openclaw-config.env       # Configuration (contains secrets)
├── docs/
│   ├── CLOUDFLARE-SSL.md     # SSL certificate setup (Caddy only)
│   ├── CLOUDFLARE-TUNNEL.md  # Cloudflare Tunnel reference
│   └── TESTING.md            # Testing instructions
└── playbooks/                # Deployment playbooks (for Claude)
    ├── 01-base-setup.md
    ├── 02-wireguard.md
    ├── 03-docker.md
    ├── 04-vps1-openclaw.md
    ├── 05-vps2-observability.md
    ├── 06-backup.md
    ├── 07-verification.md
    └── networking/
        ├── cloudflare-tunnel.md
        └── caddy.md
```

---

## Troubleshooting

### Can't Access OpenClaw Admin

- Ensure you're using the correct URL: `/_openclaw/_admin` (not just `/_admin`)
- Verify the gateway token is correct
- Verify SSL networking is correct:
  - Check Cloudflare Access if using Cloudflare Tunnel
  - Check that Caddy is running if not using Cloudflare Tunnel: `docker ps | grep caddy`

### Can't Access Grafana

- Check UFW allows port 443: `sudo ufw status`
- Verify Caddy and Grafana containers are running
- Check Caddy logs: `docker logs caddy`

### Logs Not Appearing in Grafana

1. Check Promtail is running on VPS-1:

   ```bash
   docker compose logs promtail
   ```

2. Check Loki is receiving data on VPS-2:

   ```bash
   curl http://localhost:3100/ready
   ```

3. Verify WireGuard tunnel is up (Promtail sends to `10.0.0.2:3100`)

### WireGuard Not Connecting

```bash
# Check interface status
sudo wg show

# Check service
sudo systemctl status wg-quick@wg0

# Check firewall
sudo ufw status | grep 51820
```

---

## Security Notes

- **Two-user model**: `adminclaw` for SSH/admin, `openclaw` for app runtime (no SSH access)
- **SSH uses port 222** (not 22) to avoid bot scanners - always use `-p 222`
- **SSH key-only** - password authentication is disabled
- **Adminclaw user** has passwordless sudo for automation
- **Obscured URL paths**: Services use non-standard paths to avoid bot scanners:
  - OpenClaw: `/_openclaw/` (admin at `/_openclaw/_admin`)
  - Grafana: `/_observe/grafana/`
- Gateway token should be kept secret - it provides admin access
- SSL certificates and private keys are sensitive - never commit to git
- The `.gitignore` excludes `*.env` and `certs/` by default
- WireGuard tunnel encrypts all inter-VPS traffic

---

## Support

- OpenClaw Documentation: <https://docs.openclaw.ai>
- OpenClaw GitHub: <https://github.com/openclaw/openclaw>
- OVHCloud Support: <https://help.ovhcloud.com>
