# Cloudflare Tunnel Setup

Secure OpenClaw and Grafana behind Cloudflare Tunnel with zero exposed ports.

> **No SSL certificates required!** Cloudflare Tunnel handles TLS automatically.
> You only need a Cloudflare account with your domain's DNS managed by Cloudflare.

## Overview

This playbook configures:

- cloudflared installation on both VPSs
- Tunnels for OpenClaw (VPS-1) and Grafana (VPS-2)
- DNS routing through Cloudflare
- Port 443 removal from firewall
- Optional: Cloudflare Access authentication

## Why Cloudflare Tunnel?

| Before (Origin Exposed) | After (Tunnel) |
|------------------------|----------------|
| Port 443 open to internet | Port 443 closed |
| Origin IP discoverable | Origin IP hidden |
| Direct IP access possible | Direct IP access blocked |
| Cloudflare can be bypassed | All traffic through Cloudflare |

## Prerequisites

- All core playbooks (01-05) completed
- Cloudflare account with your domain added
- Domain DNS managed by Cloudflare
- SSH access as `adminclaw` on port 222

## Variables

From `../openclaw-config.env`:

- `DOMAIN_OPENCLAW` - Domain for OpenClaw (e.g., openclaw.example.com)
- `DOMAIN_GRAFANA` - Domain for Grafana (e.g., observe.example.com)
- `SUBPATH_OPENCLAW` - URL subpath for OpenClaw (default: `/_openclaw`)
- `SUBPATH_GRAFANA` - URL subpath for Grafana (default: `/_observe/grafana`)

## Architecture

```
┌─────────────────────────────────────────────────────────-────┐
│                         Internet                             │
│                                                              │
│    User ──► openclaw.example.com ──► Cloudflare Edge         │
│                                        │                     │
│                              Cloudflare Access               │
│                                  (auth check)                │
│                                        │                     │
└────────────────────────────────────────┼─────────────────────┘
                                         │
                        Encrypted Tunnel (outbound)
                                         │
┌────────────────────────────────────────┼─────────────────────┐
│  VPS-1 (Origin - No inbound ports needed)                    │
│                                        │                     │
│    cloudflared ◄───────────────────────┘                     │
│        │                                                     │
│        ▼                                                     │
│    localhost:18789 (OpenClaw Gateway)                        │
│                                                              │
│    Port 443: CLOSED                                          │
│    Port 80:  CLOSED                                          │
└──────────────────────────────────────────────────────────────┘
```

---

## VPS-1 Setup (OpenClaw)

### Step 1: Install cloudflared

```bash
ssh -p 222 adminclaw@<VPS1_IP>

# Download and install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb

# Verify installation
cloudflared --version
```

### Step 2: Authenticate with Cloudflare

```bash
# This opens a browser URL - copy/paste to authenticate
cloudflared tunnel login
```

This creates `~/.cloudflared/cert.pem` with your Cloudflare credentials.

### Step 3: Create the Tunnel

```bash
# Create a tunnel named "openclaw"
cloudflared tunnel create openclaw

# Note the tunnel ID (UUID) from the output
# Example: Created tunnel openclaw with id a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

Save the tunnel ID for later steps.

### Step 4: Configure the Tunnel

```bash
sudo mkdir -p /etc/cloudflared

# Replace <DOMAIN_OPENCLAW> with your domain
sudo tee /etc/cloudflared/config.yml << 'EOF'
tunnel: openclaw
credentials-file: /etc/cloudflared/credentials.json

ingress:
  # OpenClaw Gateway (web UI and API)
  - hostname: <DOMAIN_OPENCLAW>
    service: http://localhost:18789
    originRequest:
      noTLSVerify: true

  # Catch-all rule (required)
  - service: http_status:404
EOF

# Copy credentials to system location
sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/credentials.json
sudo chmod 600 /etc/cloudflared/credentials.json
```

### Step 5: Configure DNS

```bash
# Route your domain through the tunnel
cloudflared tunnel route dns openclaw <DOMAIN_OPENCLAW>
```

**Important:** This creates a CNAME record pointing to the tunnel. In Cloudflare Dashboard, you should see:

- `<DOMAIN_OPENCLAW>` → `CNAME` → `<tunnel-id>.cfargotunnel.com` (Proxied)

### Step 6: Test the Tunnel

```bash
# Run tunnel in foreground to test
cloudflared tunnel run openclaw

# In another terminal, verify it works
curl -s https://<DOMAIN_OPENCLAW><SUBPATH_OPENCLAW>/ | head -5
```

### Step 7: Install as System Service

```bash
# Install cloudflared as a systemd service
sudo cloudflared service install

# Enable and start the service
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

# Check status
sudo systemctl status cloudflared
```

### Step 8: Remove Port 443 from Firewall

Once the tunnel is working, close port 443:

```bash
# Remove HTTPS from firewall (no longer needed)
sudo ufw delete allow 443/tcp

# Verify
sudo ufw status
```

### Step 9: Stop and Remove Caddy (if installed)

Since Cloudflare Tunnel handles TLS termination, Caddy is no longer needed:

```bash
# Stop and remove Caddy container (if running)
sudo docker stop caddy 2>/dev/null || true
sudo docker rm caddy 2>/dev/null || true

# Remove Caddy volumes (optional)
sudo docker volume rm caddy_data caddy_config 2>/dev/null || true
```

---

## VPS-2 Setup (Grafana)

Repeat similar steps for VPS-2 with Grafana.

### Step 1: Install cloudflared

```bash
ssh -p 222 adminclaw@<VPS2_IP>

curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb

cloudflared --version
```

### Step 2: Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

### Step 3: Create the Tunnel

```bash
cloudflared tunnel create observe

# Note the tunnel ID
```

### Step 4: Configure the Tunnel

```bash
sudo mkdir -p /etc/cloudflared

# Replace <DOMAIN_GRAFANA> with your domain
sudo tee /etc/cloudflared/config.yml << 'EOF'
tunnel: observe
credentials-file: /etc/cloudflared/credentials.json

ingress:
  # Grafana dashboard
  - hostname: <DOMAIN_GRAFANA>
    service: http://localhost:3000
    originRequest:
      noTLSVerify: true

  # Catch-all rule (required)
  - service: http_status:404
EOF

sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/credentials.json
sudo chmod 600 /etc/cloudflared/credentials.json
```

### Step 5: Configure DNS

```bash
cloudflared tunnel route dns observe <DOMAIN_GRAFANA>
```

### Step 6: Test and Install Service

```bash
# Test
cloudflared tunnel run observe

# Install as service
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

### Step 7: Remove Port 443 and Caddy

```bash
sudo ufw delete allow 443/tcp
sudo docker stop caddy 2>/dev/null || true
sudo docker rm caddy 2>/dev/null || true
```

---

## Cloudflare Access Configuration (Optional)

Add authentication via Cloudflare Access for additional security.

### In Cloudflare Dashboard

1. Go to **Zero Trust** → **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**
3. Configure:
   - **Application name:** OpenClaw
   - **Session duration:** 24 hours
   - **Application domain:** `<DOMAIN_OPENCLAW>`
   - **Path:** `<SUBPATH_OPENCLAW>/*` (or leave blank to protect entire domain)

4. Add a policy:
   - **Policy name:** Allowed Users
   - **Action:** Allow
   - **Include:**
     - Emails: `your-email@example.com`
     - Or: Login Methods → GitHub/Google

5. Repeat for Grafana domain

### Test Access Protection

1. Open `https://<DOMAIN_OPENCLAW><SUBPATH_OPENCLAW>/` in an incognito window
2. You should see the Cloudflare Access login page
3. Authenticate with your configured method
4. You should now see the OpenClaw UI

---

## Verification

### VPS-1

```bash
# Check tunnel service
sudo systemctl status cloudflared

# Check tunnel connectivity
cloudflared tunnel info openclaw

# Verify port 443 is closed
sudo ufw status | grep 443 || echo "Port 443 not in UFW (correct)"

# Test external access
curl -s https://<DOMAIN_OPENCLAW><SUBPATH_OPENCLAW>/ | head -5

# Verify direct IP access fails
curl -sk --connect-timeout 5 https://<VPS1_IP>/ || echo "Direct access blocked (expected)"
```

### VPS-2

```bash
# Check tunnel service
sudo systemctl status cloudflared

# Test external access
curl -s https://<DOMAIN_GRAFANA>/ | head -5
```

---

## Troubleshooting

### Tunnel Not Starting

```bash
# Check logs
sudo journalctl -u cloudflared -f

# Verify config
cloudflared tunnel ingress validate

# Test tunnel connection
cloudflared tunnel info openclaw
```

### DNS Not Resolving

```bash
# Check if CNAME is configured
dig <DOMAIN_OPENCLAW>

# Should show CNAME to <tunnel-id>.cfargotunnel.com
```

### 502 Bad Gateway

The origin service isn't responding:

```bash
# Check OpenClaw is running
sudo -u openclaw docker compose ps

# Check it's listening on localhost
curl -s http://localhost:18789/
```

### Reverting to Direct Access

If you need to revert:

```bash
# Stop cloudflared
sudo systemctl stop cloudflared
sudo systemctl disable cloudflared

# Re-enable port 443
sudo ufw allow 443/tcp

# Restart Caddy (if still installed) or reinstall
# See networking/caddy.md

# Update Cloudflare DNS back to A record pointing to VPS IP
```

---

## Maintenance

### Updating cloudflared

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
sudo systemctl restart cloudflared
```

### Viewing Tunnel Metrics

Cloudflare Dashboard → Zero Trust → Networks → Tunnels → (your tunnel) → Metrics

### Rotating Tunnel Credentials

```bash
# Delete and recreate the tunnel
cloudflared tunnel delete openclaw
cloudflared tunnel create openclaw

# Update credentials file
sudo cp ~/.cloudflared/<NEW_TUNNEL_ID>.json /etc/cloudflared/credentials.json

# Update config.yml with new tunnel name/ID if needed
sudo systemctl restart cloudflared

# Re-add DNS route
cloudflared tunnel route dns openclaw <DOMAIN_OPENCLAW>
```

---

## Security Checklist

After completing setup, verify:

- [ ] Port 443 is closed (`sudo ufw status` shows no 443/tcp rule)
- [ ] Port 80 is closed (was never opened)
- [ ] Tunnel is running (`sudo systemctl status cloudflared`)
- [ ] DNS routes through tunnel (`dig <DOMAIN>` shows CNAME)
- [ ] Cloudflare Access is enabled (incognito browser shows login page)
- [ ] Direct IP access fails (`curl -sk https://<VPS_IP>/` times out or refused)
- [ ] Telegram/Slack bots still work (use outbound connections)

---

## Related Files

### VPS-1 (OpenClaw)

- `/etc/cloudflared/config.yml` - Tunnel configuration
- `/etc/cloudflared/credentials.json` - Tunnel credentials
- `~/.cloudflared/cert.pem` - Cloudflare account certificate

### VPS-2 (Observe)

- `/etc/cloudflared/config.yml` - Tunnel configuration
- `/etc/cloudflared/credentials.json` - Tunnel credentials
- `~/.cloudflared/cert.pem` - Cloudflare account certificate

## Dashboard Management

Tunnels can be migrated to dashboard management for easier configuration:

**Cloudflare Dashboard** → **Zero Trust** → **Networks** → **Tunnels**
