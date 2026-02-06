# OpenClaw on VPS

This repository contains everything needed to securely deploy OpenClaw on two VPS instances with full observability.

The quick start guides recommend OVHCloud but any host provider that supports Ubuntu 24.04 or later should work.

This project is an experiment for using `claude code` for devops. A significant effort was made to ensure OpenClaw
is running as securely as possible. However, there's no guarantee claude will always follow the playbooks as designed.

It's strongly recommended to use the Cloudflare Tunnel networking option in openclaw-config.env.
Caddy support (no Cloudflare Tunnel) is provided as an example. You will need to work with claude
to make sure it's secure and requires device pairing. Device pairing is disabled with Cloudflare Tunnel
since Cloudflare is already securing access.

## Requirements

- **Claude Code** - used to deploy and manage the VPS's
- **(2x) VPS**
  - Minimum: 4GB RAM & 2 vCPUS
  - Recommended: 8GB+ RAM & 4+ vCPUS
  - Linux distro with kernel that supports sysbox (for OpenClaw VPS)
    - Minimum: 5.12+ kernel
    - Recommended: Ubuntu 24.04+
  - Root SSH support - claude needs to be able to SSH into the servers
- **Anthropic API Key** - needed by OpenClaw to run onboarding process
- **Domain or Subdomains** - needed if using Cloudflare Tunnel

---

## Architecture

```test
                    Cloudflare Tunnel
                    (public HTTPS access)
                            │
            ┌───────────────┼───────────────┐
            ▼                               ▼
  ┌──────────────────┐            ┌─────────────-─────┐
  │  VPS-1: OpenClaw │            │ VPS-2: Monitoring │
  │                  │  WireGuard │                   │
  │  Gateway         │───────────>│  Grafana          │
  │  Promtail        │  telemetry │  Prometheus       │
  │  Node Exporter   │            │  Loki             │
  │                  │            │  Tempo            │
  └──────────────────┘            └─────────────-─────┘
```

| VPS | Role | Services |
|-----|------|----------|
| **VPS-1** | OpenClaw | Gateway, Sysbox runtime, Node Exporter, Promtail |
| **VPS-2** | Observability | Prometheus, Grafana, Tempo, Loki, Alertmanager, cAdvisor |

The two VPSs communicate over a secure WireGuard tunnel. No ports are exposed to the public net
when using the Cloudflare Tunnel networking option.

---

## Quick Start

1. Clone this repo
2. Create two new VPS's - see **[ovh_setup_guide.md](./ovh_setup_guide.md)** for recommendations
3. Set values in openclaw-config.env
4. Start claude code and just say `start`
5. Start using OpenClaw: `https://openclaw.YOURDOMAIN.com/chat?token=OPENCLAW_TOKEN`

Claude will interview you for any missing config values and then start the deploy process.
After deployment, claude can be used to make any changes or manage your VPS's with the same prompt.

---

## Configuration

### Step 1: Set Up OVHCloud Account and VPSs

Any VPS provider can be used as long as they meet the minimum requirements.

Follow the detailed instructions in **[ovh_setup_guide.md](./ovh_setup_guide.md)** to:

1. Create an OVHCloud account
2. Generate a new SSH key
3. Order two VPS-2 instances - add your public SSH key during checkout
4. Verify SSH access to both VPSs

### Step 2: Create Config Env File

Clone this repo first if you haven't already.

```bash
git clone git@github.com>:simple10/claudiusmaximus.git openclaw-vps
cd openclaw-vps
```

Create your openclaw-config.env

```bash
cp openclaw-config.env.example openclaw-config.env
```

Then, add your VPS IPs to the config file.

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
DOMAIN_OPENCLAW=openclaw.example.com
DOMAIN_GRAFANA=observe.example.com
```

**If using Caddy:** Follow [docs/CLOUDFLARE-SSL.md](docs/CLOUDFLARE-SSL.md) to generate Origin CA certificates first.

**If using Cloudflare Tunnel:** No certificates needed - skip to Step 3.
Claude will implement the tunnel and prompt for user confirmation.
Post-deploy steps will be needed to configure Cloudflare Access (see below).

### Step 3: Deploy with Claude Code

You're now ready for Claude Code to automate the rest.

1. Ensure your SSH key is loaded:

   ```bash
   ssh-add ~/.ssh/ovh_openclaw_ed25519
   ```

2. Open Claude Code in this directory

   ```bash
   claude
   ```

3. Start chatting with Claude

   > start

[CLAUDE.md](CLAUDE.md) is configured to start an interview process at the start of a conversation.
For future conversations, you can skip the interview by just asking it to perform a specific task.

e.g.
> Restart the openclaw gateway container

### What Claude Code Will Do During Deploy

Claude runs the various [playbooks](/playbooks/) using values from openclaw-config.env

1. **On both VPSs:**
   - System updates and hardening
   - Create dedicated `adminclaw` user
   - Configure UFW firewall
   - Set up Fail2ban
   - Install Docker
   - Set up WireGuard tunnel between VPSs
   - Harden the VPS: change SSH port, disable password SSH, limit sudo, etc.

2. **On VPS-1 (OpenClaw):**
   - Install Sysbox runtime
   - Deploy OpenClaw gateway to a container
   - Set up Node Exporter + Promtail (ships metrics/logs to VPS-2)
   - Configure Cloudflare Tunnel (recommended) or Caddy reverse proxy
   - Configure automated backups of openclaw data

3. **On VPS-2 (Observability):**
   - Deploy Prometheus, Grafana, Tempo, Loki, Alertmanager (LGTM stack)
   - Configure dashboards and alerting
   - Set up log aggregation
   - Configure Cloudflare Tunnel or Caddy

---

## Post-Deployment: Configuration

**If using Cloudflare Tunnel:** see [docs/CLOUDFLARE-TUNNEL.md](docs/CLOUDFLARE-TUNNEL.md) to finish setting up Cloudflare Access.

Cloudflare Access is the gateway that authorizes users to access OpenClaw through the tunnel.

## Post-Deployment: Testing

Optionally ask Claude to run end-to-end tests:

> Run the tests in docts/TESTING.md using devtools mcp

**DevTools MCP** must already be installed and enabled in Claude Code to allow browser automation tests.

Claude will run a series of checks via ssh on the two VPS, then use a browser to check the UIs.

## Post-Deployment: Getting Started with OpenClaw

### Access Your OpenClaw Dashboard

Ask claude to give you the OpenClaw admin URL to start chatting with OpenClaw.

> Please give me the OpenClaw url with the token

The URL should look something like: `https://openclaw.YOURDOMAIN.com/chat?token=OPENCLAW_TOKEN`

This will take you to the OpenClaw web UI where you can start the onboarding process.
If you're using Cloudflare Tunnel option, you'll need to [configure the tunnel](docs/CLOUDFLARE-TUNNEL.md)
before the URL will work.

If claude is unable to get the token, you can get it directly from the openclaw CLI.

```bash
# SSH into the openclaw-gateway container
./scripts/openclaw_remote.sh

# Then run the CLI to get the dashboard link with token
# openclaw.mjs is in the /app dir which is the default login home
node openclaw.mjs dashboard --no-open

# Outputs url with token
# Copy the token and use with your public URL
```

### Access Grafana

1. Navigate to your Grafana URL:
   - With domain: `https://observe.yourdomain.com<SUBPATH_GRAFANA>/`
   - Without domain: `https://<VPS-2-IP><SUBPATH_GRAFANA>/`

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

TODO: This section is out of date and needs to be updated.

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
