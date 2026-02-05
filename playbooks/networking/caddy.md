# Caddy Reverse Proxy Setup

Configure Caddy as reverse proxy with Cloudflare Origin CA certificates.

> **Origin CA certificate required!** You must generate a certificate in the Cloudflare Dashboard
> BEFORE running this playbook. See [docs/CLOUDFLARE-SSL.md](../../docs/CLOUDFLARE-SSL.md) for instructions.

## Overview

This playbook configures:

- Cloudflare Origin CA certificates
- Caddy reverse proxy on both VPSs
- HTTPS-only access (port 80 blocked)
- Obscured URL paths to avoid bot scanners

## When to Use This

Use Caddy instead of Cloudflare Tunnel when:

- You don't have a Cloudflare account
- You need direct access to the origin server
- You prefer simpler infrastructure

**Trade-offs:**

- Port 443 is exposed to the internet
- Origin IP is discoverable
- Direct IP access is possible (unless blocked by Cloudflare)

## Prerequisites

- All core playbooks (01-05) completed
- Cloudflare account with your domain (for Origin CA)
- Domain DNS pointing to VPS IPs
- SSH access as `adminclaw` on port 222

## Variables

From `../openclaw-config.env`:

- `DOMAIN_OPENCLAW` - Domain for OpenClaw (e.g., openclaw.example.com)
- `DOMAIN_GRAFANA` - Domain for Grafana (e.g., observe.example.com)

---

## VPS-1 Setup (OpenClaw)

> **Prerequisite:** Complete [docs/CLOUDFLARE-SSL.md](../../docs/CLOUDFLARE-SSL.md) first to generate your Origin CA certificate.

### Step 1: Add Port 443 to UFW

```bash
ssh -p 222 adminclaw@<VPS1_IP>

# Add HTTPS port
sudo ufw allow 443/tcp
sudo ufw status
```

### Step 2: Setup SSL Certificates

```bash
# Create certs directory
sudo mkdir -p /etc/caddy/certs

# Copy certificate (paste from Cloudflare)
sudo tee /etc/caddy/certs/origin.pem << 'EOF'
-----BEGIN CERTIFICATE-----
<YOUR_CLOUDFLARE_ORIGIN_CA_CERTIFICATE>
-----END CERTIFICATE-----
EOF

# Copy private key (paste from Cloudflare)
sudo tee /etc/caddy/certs/origin.key << 'EOF'
-----BEGIN PRIVATE KEY-----
<YOUR_CLOUDFLARE_ORIGIN_CA_PRIVATE_KEY>
-----END PRIVATE KEY-----
EOF

# Set secure permissions
sudo chmod 644 /etc/caddy/certs/origin.pem
sudo chmod 600 /etc/caddy/certs/origin.key
```

### Step 3: Create Caddyfile

```bash
sudo mkdir -p /etc/caddy /var/log/caddy

# SSL-only configuration using Cloudflare Origin CA
# Port 80 is blocked at firewall level - no HTTP at all
# OpenClaw is served under /_openclaw/ to avoid bot scanners
sudo tee /etc/caddy/Caddyfile << 'EOF'
{
    # Disable automatic HTTPS - we're using Cloudflare Origin CA
    auto_https off
}

:443 {
    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        -Server
    }

    # OpenClaw under obscured path to avoid bot scanners
    handle_path /_openclaw/* {
        reverse_proxy localhost:18789 {
            header_up Host {host}
            header_up X-Real-IP {remote}
        }
    }

    # Redirect root to OpenClaw (optional - remove if you want 404 on root)
    handle / {
        redir /_openclaw/ permanent
    }

    # Return 404 for all other paths
    handle {
        respond "Not Found" 404
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size 100mb
            roll_keep 5
        }
    }
}
EOF
```

### Step 4: Run Caddy

```bash
docker run -d \
    --name caddy \
    --restart unless-stopped \
    --network host \
    -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
    -v /etc/caddy/certs:/etc/caddy/certs:ro \
    -v caddy_data:/data \
    -v caddy_config:/config \
    -v /var/log/caddy:/var/log/caddy \
    caddy:2-alpine
```

### Step 5: Configure Cloudflare DNS

In Cloudflare Dashboard:

1. Go to **DNS** → **Records**
2. Add/Update: `<SUBDOMAIN>` → `A` → `<VPS1_IP>` (Proxied)
3. Go to **SSL/TLS** → Set encryption mode to **Full (strict)**

---

## VPS-2 Setup (Grafana)

### Step 1: Add Port 443 to UFW

```bash
ssh -p 222 adminclaw@<VPS2_IP>

sudo ufw allow 443/tcp
sudo ufw status
```

### Step 2: Setup SSL Certificates

```bash
sudo mkdir -p /etc/caddy/certs

# Copy same certificate (wildcard works for both)
sudo tee /etc/caddy/certs/origin.pem << 'EOF'
-----BEGIN CERTIFICATE-----
<YOUR_CLOUDFLARE_ORIGIN_CA_CERTIFICATE>
-----END CERTIFICATE-----
EOF

sudo tee /etc/caddy/certs/origin.key << 'EOF'
-----BEGIN PRIVATE KEY-----
<YOUR_CLOUDFLARE_ORIGIN_CA_PRIVATE_KEY>
-----END PRIVATE KEY-----
EOF

sudo chmod 644 /etc/caddy/certs/origin.pem
sudo chmod 600 /etc/caddy/certs/origin.key
```

### Step 3: Create Caddyfile for Grafana

```bash
sudo mkdir -p /etc/caddy /var/log/caddy

# CRITICAL: Use "handle" NOT "handle_path" for Grafana
# handle_path strips the path prefix, causing redirect loops when Grafana
# is configured with GF_SERVER_ROOT_URL and GF_SERVER_SERVE_FROM_SUB_PATH=true
sudo tee /etc/caddy/Caddyfile << 'EOF'
{
    # Disable automatic HTTPS - we're using Cloudflare Origin CA
    auto_https off
}

:443 {
    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        -Server
    }

    # CRITICAL: Use "handle" NOT "handle_path" for Grafana
    # handle_path strips the path prefix, causing redirect loops when Grafana
    # is configured with GF_SERVER_ROOT_URL and GF_SERVER_SERVE_FROM_SUB_PATH=true
    # With handle, the full path /_observe/grafana/... is preserved and passed to Grafana
    handle /_observe/grafana/* {
        reverse_proxy localhost:3000 {
            header_up Host {host}
            header_up X-Real-IP {remote}
        }
    }

    # Handle requests to /_observe/grafana without trailing slash
    handle /_observe/grafana {
        redir /_observe/grafana/ permanent
    }

    # Redirect root to Grafana (optional - remove if you want 404 on root)
    handle / {
        redir /_observe/grafana/ permanent
    }

    # Return 404 for all other paths
    handle {
        respond "Not Found" 404
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size 100mb
            roll_keep 5
        }
    }
}
EOF
```

### Step 4: Run Caddy

```bash
docker run -d \
    --name caddy \
    --restart unless-stopped \
    --network host \
    -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
    -v /etc/caddy/certs:/etc/caddy/certs:ro \
    -v caddy_data:/data \
    -v caddy_config:/config \
    -v /var/log/caddy:/var/log/caddy \
    caddy:2-alpine
```

### Step 5: Configure Cloudflare DNS

In Cloudflare Dashboard:

1. Go to **DNS** → **Records**
2. Add/Update: `<SUBDOMAIN>` → `A` → `<VPS2_IP>` (Proxied)
3. Ensure SSL/TLS is set to **Full (strict)**

---

## Verification

### VPS-1

```bash
# Check Caddy is running
sudo docker ps | grep caddy
sudo docker logs caddy

# Test internal endpoint
curl -s http://localhost:18789/ | head -5

# Test via Caddy (HTTPS)
curl -sk https://localhost:443/_openclaw/ | head -5

# Verify port 80 is blocked
curl -s --connect-timeout 3 http://localhost:80/ || echo "Port 80 blocked (expected)"
```

### VPS-2

```bash
# Check Caddy is running
sudo docker ps | grep caddy

# Test Grafana via Caddy
curl -sk https://localhost:443/_observe/grafana/ | head -5

# Verify port 80 is blocked
curl -s --connect-timeout 3 http://localhost:80/ || echo "Port 80 blocked (expected)"
```

### External Access

```bash
# Test from any machine
curl -s https://<DOMAIN_OPENCLAW>/_openclaw/ | head -5
curl -s https://<DOMAIN_GRAFANA>/_observe/grafana/ | head -5
```

---

## Troubleshooting

### Grafana Redirect Loop (ERR_TOO_MANY_REDIRECTS)

```bash
# Symptom: Browser shows "too many redirects" when accessing /_observe/grafana/
# Cause: Caddy using handle_path instead of handle

# WRONG - strips path prefix, causes redirect loop:
handle_path /_observe/grafana/* {
    reverse_proxy localhost:3000
}

# CORRECT - preserves full path:
handle /_observe/grafana/* {
    reverse_proxy localhost:3000
}

# Why: Grafana with GF_SERVER_SERVE_FROM_SUB_PATH=true expects requests
# at /_observe/grafana/..., but handle_path strips the prefix and sends /...
# Grafana then redirects back to /_observe/grafana/, creating a loop
```

### Certificate Error

```bash
# Check certificate is valid
openssl x509 -in /etc/caddy/certs/origin.pem -text -noout

# Check Cloudflare SSL mode is "Full (strict)"
# Dashboard → SSL/TLS → Overview
```

### 502 Bad Gateway

```bash
# Check backend is running
curl -s http://localhost:18789/  # OpenClaw
curl -s http://localhost:3000/   # Grafana

# Check Caddy logs
sudo docker logs caddy
```

### OCSP Stapling Warning

```bash
# This warning in Caddy logs is expected with Origin CA:
# "no OCSP stapling for ... certificate is not issued by a trusted CA"
# Origin CA certs don't support OCSP stapling - this is harmless
```

### Reload Caddy Config

```bash
# After editing Caddyfile
sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

---

## Security Notes

- Port 80 is blocked at UFW level (not just Caddy)
- Origin CA certificates are only trusted by Cloudflare
- Set Cloudflare SSL mode to "Full (strict)" for end-to-end encryption
- Obscured paths (`/_openclaw/`, `/_observe/grafana/`) reduce bot scanning
- Security headers added by Caddy (HSTS, X-Frame-Options, etc.)
- Caddy access logs stored in `/var/log/caddy/`

---

## Switching to Cloudflare Tunnel

If you later want to switch to Cloudflare Tunnel:

```bash
# Stop and remove Caddy
sudo docker stop caddy
sudo docker rm caddy

# Remove port 443 from UFW
sudo ufw delete allow 443/tcp

# Follow networking/cloudflare-tunnel.md
```
