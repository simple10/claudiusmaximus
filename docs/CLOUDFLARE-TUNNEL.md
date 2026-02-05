# Cloudflare Tunnel Setup for OpenClaw

This document describes how to secure OpenClaw behind Cloudflare Tunnel, eliminating the need to expose port 443 on the origin server.

## Why Cloudflare Tunnel?

| Before (Origin Exposed) | After (Tunnel) |
|------------------------|----------------|
| Port 443 open to internet | Port 443 closed |
| Origin IP discoverable | Origin IP hidden |
| Direct IP access possible | Direct IP access blocked |
| Cloudflare can be bypassed | All traffic through Cloudflare |

## Prerequisites

- Cloudflare account with your domain added
- Domain DNS managed by Cloudflare
- SSH access to VPS-1 (<adminclaw@15.204.xxx.xxx>, port 222)

## Architecture

```
┌─────────────────────────────────────────────────────────────-┐
│                         Internet                             │
│                                                              │
│    User ──► openclaw.yourdomain.com ──► Cloudflare Edge      │
│                                              │               │
│                                    Cloudflare Access         │
│                                        (auth check)          │
│                                              │               │
└──────────────────────────────────────────────┼───────────────┘
                                               │
                              Encrypted Tunnel (outbound)
                                               │
┌──────────────────────────────────────────────┼───────────────┐
│  VPS-1 (Origin - No inbound ports needed)    │               │
│                                              ▼               │
│    cloudflared ◄─────────────────────────────┘               │
│        │                                                     │
│        ▼                                                     │
│    localhost:18789 (OpenClaw Gateway)                        │
│                                                              │
│    Port 443: CLOSED                                          │
│    Port 80:  CLOSED                                          │
└──────────────────────────────────────────────────────────────┘
```

## Installation Steps

### Step 1: Install cloudflared

```bash
ssh -p 222 adminclaw@15.204.xxx.xxx

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

**Actual tunnel ID (created 2026-02-05):** `7d64559d-5946-45f1-a0da-5818c7d9b348`

### Step 4: Configure the Tunnel

Create the tunnel configuration file:

```bash
sudo mkdir -p /etc/cloudflared

sudo tee /etc/cloudflared/config.yml << 'EOF'
tunnel: openclaw
credentials-file: /etc/cloudflared/credentials.json

ingress:
  # OpenClaw Gateway (web UI and API)
  - hostname: openclaw.yourdomain.com
    service: http://localhost:18789
    originRequest:
      noTLSVerify: true

  # Catch-all rule (required)
  - service: http_status:404
EOF
```

Copy credentials to system location:

```bash
# Copy the credentials file created during tunnel creation
sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/credentials.json
sudo chmod 600 /etc/cloudflared/credentials.json
```

### Step 5: Configure DNS

Route your domain through the tunnel:

```bash
# This creates a CNAME record pointing to the tunnel
cloudflared tunnel route dns openclaw openclaw.yourdomain.com
```

**Important:** This replaces the existing A record. In Cloudflare Dashboard, you should see:

- `openclaw.yourdomain.com` → `CNAME` → `<tunnel-id>.cfargotunnel.com` (Proxied)

### Step 6: Test the Tunnel

```bash
# Run tunnel in foreground to test
cloudflared tunnel run openclaw

# In another terminal, verify it works
curl -s https://openclaw.yourdomain.com/_openclaw/ | head -5
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

Expected UFW rules after this change:

```
Status: active

To                         Action      From
--                         ------      ----
222/tcp                    ALLOW       Anywhere        # SSH
51820/udp                  ALLOW       Anywhere        # WireGuard
9100                       ALLOW       10.0.0.0/24     # Node Exporter (WireGuard)
18789                      ALLOW       10.0.0.0/24     # OpenClaw metrics (WireGuard)
```

### Step 9: Stop and Remove Caddy (Optional)

Since Cloudflare Tunnel handles TLS termination, Caddy is no longer needed on VPS-1:

```bash
# Stop and remove Caddy container
sudo docker stop caddy
sudo docker rm caddy

# Remove Caddy volumes (optional)
sudo docker volume rm caddy_data caddy_config
```

## Cloudflare Access Configuration

After the tunnel is working, add authentication via Cloudflare Access:

### In Cloudflare Dashboard

1. Go to **Zero Trust** → **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**
3. Configure:
   - **Application name:** OpenClaw
   - **Session duration:** 24 hours
   - **Application domain:** `openclaw.yourdomain.com`
   - **Path:** `/_openclaw/*` (or leave blank to protect entire domain)

4. Add a policy:
   - **Policy name:** Allowed Users
   - **Action:** Allow
   - **Include:**
     - Emails: `your-email@yourdomain.com`
     - Or: Login Methods → GitHub/Google

5. Save the application

### Test Access Protection

1. Open `https://openclaw.yourdomain.com/_openclaw/` in an incognito window
2. You should see the Cloudflare Access login page
3. Authenticate with your configured method
4. You should now see the OpenClaw UI

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
dig openclaw.yourdomain.com

# Should show CNAME to <tunnel-id>.cfargotunnel.com
```

### 502 Bad Gateway

The origin service isn't responding:

```bash
# Check OpenClaw is running
sudo -u openclaw docker compose ps

# Check it's listening on localhost:18789
curl -s http://localhost:18789/
```

### Reverting to Direct Access

If you need to revert to the previous setup:

```bash
# Stop cloudflared
sudo systemctl stop cloudflared
sudo systemctl disable cloudflared

# Re-enable port 443
sudo ufw allow 443/tcp

# Restart Caddy (if still installed)
sudo docker start caddy

# Update Cloudflare DNS back to A record pointing to VPS IP
```

## Maintenance

### Updating cloudflared

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
sudo systemctl restart cloudflared
```

### Viewing Tunnel Metrics

Cloudflare Dashboard → Zero Trust → Networks → Tunnels → openclaw → Metrics

### Rotating Tunnel Credentials

```bash
# Delete and recreate the tunnel
cloudflared tunnel delete openclaw
cloudflared tunnel create openclaw

# Update credentials file
sudo cp ~/.cloudflared/<NEW_TUNNEL_ID>.json /etc/cloudflared/credentials.json

# Update config.yml with new tunnel name/ID
sudo systemctl restart cloudflared
```

## Security Checklist

After completing setup, verify:

- [ ] Port 443 is closed (`sudo ufw status` shows no 443/tcp rule)
- [ ] Port 80 is closed (was never opened)
- [ ] Tunnel is running (`sudo systemctl status cloudflared`)
- [ ] DNS routes through tunnel (`dig openclaw.yourdomain.com` shows CNAME)
- [ ] Cloudflare Access is enabled (incognito browser shows login page)
- [ ] Direct IP access fails (`curl -sk https://15.204.xxx.xxx/` times out or refused)
- [ ] Telegram bot still works (uses outbound long-polling)
- [ ] Slack bot still works (uses outbound Socket Mode)

## Current Deployment Status (2026-02-05)

### VPS-1 (OpenClaw)

| Component | Status |
|-----------|--------|
| cloudflared installed | ✅ v2026.1.2 |
| Tunnel created | ✅ ID: 7d64559d-5946-45f1-a0da-5818c7d9b348 |
| DNS configured | ✅ openclaw.yourdomain.com → tunnel |
| Systemd service | ✅ Enabled and running |
| Port 443 closed | ✅ Removed from UFW |
| Caddy removed | ✅ Container stopped and removed |
| Cloudflare Access | ✅ Configured |

### VPS-2 (Observe/Grafana)

| Component | Status |
|-----------|--------|
| cloudflared installed | ✅ v2026.1.2 |
| Tunnel created | ✅ ID: 4c7a52f5-d93c-4e5a-94ce-dc7f111ff4f5 |
| DNS configured | ✅ observe.yourdomain.com → tunnel |
| Systemd service | ✅ Enabled and running |
| Port 443 closed | ✅ Removed from UFW |
| Caddy removed | ✅ Container stopped and removed |
| Cloudflare Access | ✅ Configured |

## Related Files

### VPS-1 (OpenClaw)

- `/etc/cloudflared/config.yml` - Tunnel configuration
- `/etc/cloudflared/credentials.json` - Tunnel credentials
- `~/.cloudflared/cert.pem` - Cloudflare account certificate

### VPS-2 (Observe)

- `/etc/cloudflared/config.yml` - Tunnel configuration
- `/etc/cloudflared/credentials.json` - Tunnel credentials
- `~/.cloudflared/cert.pem` - Cloudflare account certificate

## Tunnel Management

Both tunnels have been migrated to **dashboard management**. Configure routes, Access policies, and view metrics at:

**Cloudflare Dashboard** → **Zero Trust** → **Networks** → **Tunnels**
