# OpenClaw Two-VPS Deployment

This repository contains everything needed to deploy OpenClaw across two OVHCloud VPS instances with full observability.

## Architecture

| VPS | Role | Services |
|-----|------|----------|
| **VPS-1** | OpenClaw | Gateway, Sysbox runtime, Caddy, Node Exporter, Promtail |
| **VPS-2** | Observability | Prometheus, Grafana, Loki, Alertmanager, cAdvisor |

The two VPSs communicate over a secure WireGuard tunnel (`10.0.0.1` ↔ `10.0.0.2`).

---

## Prerequisites

- Two VPS instances (Ubuntu 24.04 LTS)
- SSH key pair for authentication
- Anthropic API key for OpenClaw (placeholder can be used)
- (Optional) Domain with Cloudflare DNS for SSL

Anthropic API key is needed for OpenClaw to run. However it can be added after
setup is complete.

---

## Quick Start

### Step 1: Set Up OVHCloud Account and VPSs

Follow the detailed instructions in **[ovh_setup_guide.md](./ovh_setup_guide.md)** to:

1. Create an OVHCloud account
2. Order two VPS-2 instances
3. Generate and configure SSH keys
4. Verify SSH access to both VPSs
5. Create the `openclaw-config.env` configuration file

### Step 2: Generate SSL Origin Certificates (Cloudflare)

If using Cloudflare for your domain, generate Origin CA certificates for secure communication between Cloudflare and your origin servers.

#### 2.1 Create Origin Certificate in Cloudflare

1. Log into [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select your domain
3. Navigate to **SSL/TLS → Origin Server**
4. Click **Create Certificate**
5. Configure:
   - **Private key type**: RSA (2048)
   - **Hostnames**: `*.yourdomain.com` and `yourdomain.com`
   - **Certificate validity**: 15 years (recommended)
6. Click **Create**
7. **Important**: Copy both the certificate and private key immediately (private key is only shown once)

#### 2.2 Save Certificates Locally

```bash
# Create certs directory
mkdir -p certs

# Save the certificate (paste from Cloudflare)
cat > certs/origin_yourdomain.pem << 'EOF'
-----BEGIN CERTIFICATE-----
<paste certificate here>
-----END CERTIFICATE-----
EOF

# Save the private key (paste from Cloudflare)
cat > certs/origin_yourdomain.key << 'EOF'
-----BEGIN PRIVATE KEY-----
<paste private key here>
-----END PRIVATE KEY-----
EOF

# Secure the files
chmod 600 certs/*.key
chmod 644 certs/*.pem
```

#### 2.3 Configure Cloudflare SSL Settings

1. In Cloudflare Dashboard → **SSL/TLS → Overview**
2. Set encryption mode to **Full (strict)**
3. This ensures end-to-end encryption with certificate validation

#### 2.4 Create DNS Records

In Cloudflare Dashboard → **DNS**:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | `claw` | `<VPS-1-IP>` | Proxied (orange cloud) |
| A | `observe` | `<VPS-2-IP>` | Proxied (orange cloud) |

### Step 3: Deploy with Claude Code

1. Ensure your SSH key is loaded:

   ```bash
   ssh-add ~/.ssh/ovh_openclaw_ed25519
   ```

2. Open Claude Code in this directory and provide:
   - The `openclaw-config.env` file
   - The `CLAUDE.md` deployment guide
   - The SSL certificates in `certs/`

3. Ask Claude to deploy OpenClaw following CLAUDE.md

---

## Post-Deployment: Getting Started

### Access OpenClaw Dashboard

1. Navigate to your OpenClaw URL:
   - With domain: `https://claw.yourdomain.com/_openclaw/_admin`
   - Without domain: `https://<VPS-1-IP>/_openclaw/_admin`

2. **Important**: You need the gateway token to access the admin interface:

   ```bash
   # SSH to VPS-1 and get the token (note: SSH uses port 222)
   ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 openclaw@<VPS-1-IP>
   cat /home/openclaw/openclaw/.env | grep OPENCLAW_GATEWAY_TOKEN
   ```

3. Enter the token when prompted at the `_admin` page

### Access Grafana

1. Navigate to your Grafana URL:
   - With domain: `https://observe.yourdomain.com/_observe/grafana/`
   - Without domain: `https://<VPS-2-IP>/_observe/grafana/`

2. Get the Grafana password:

   ```bash
   # SSH to VPS-2 and get the password (note: SSH uses port 222)
   ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 openclaw@<VPS-2-IP>
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
# On VPS-1 (SSH port 222)
ssh -p 222 openclaw@<VPS-1-IP> "cd /home/openclaw/openclaw && docker compose ps"

# On VPS-2 (SSH port 222)
ssh -p 222 openclaw@<VPS-2-IP> "cd /home/openclaw/monitoring && docker compose ps"
```

### WireGuard Tunnel

```bash
# On VPS-1 (SSH port 222)
ssh -p 222 openclaw@<VPS-1-IP> "sudo wg show"
ssh -p 222 openclaw@<VPS-1-IP> "ping -c 3 10.0.0.2"
```

For comprehensive testing, see **[docs/TESTING.md](./docs/TESTING.md)**.

---

## File Structure

```
openclaw-vps/
├── README.md                 # This file
├── CLAUDE.md                 # Deployment guide for Claude Code
├── ovh_setup_guide.md        # OVHCloud account setup instructions
├── openclaw-config.env       # Configuration (contains secrets)
├── certs/                    # SSL certificates
│   ├── origin_*.pem          # Origin CA certificate
│   └── origin_*.key          # Origin CA private key
└── docs/
    └── TESTING.md            # Testing instructions
```

---

## Troubleshooting

### Can't Access OpenClaw Admin

- Ensure you're using the correct URL: `/_openclaw/_admin` (not just `/_admin`)
- Verify the gateway token is correct
- Check that Caddy is running: `docker ps | grep caddy`

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

- **SSH uses port 222** (not 22) to avoid bot scanners - always use `-p 222`
- **SSH key-only** - password authentication is disabled
- **Openclaw user** has passwordless sudo for automation - remember the password you set during setup for console access
- **Obscured URL paths**: Services use non-standard paths to avoid bot scanners:
  - OpenClaw: `/_openclaw/` (admin at `/_openclaw/_admin`)
  - Grafana: `/_observe/grafana/`
- Gateway token should be kept secret - it provides admin access
- SSL certificates and private keys are sensitive - never commit to git
- The `.gitignore` excludes `*.env` and `certs/` by default
- All public access is HTTPS-only (port 443)
- WireGuard tunnel encrypts all inter-VPS traffic

---

## Support

- OpenClaw Documentation: <https://docs.openclaw.ai>
- OpenClaw GitHub: <https://github.com/openclaw/openclaw>
- OVHCloud Support: <https://help.ovhcloud.com>
