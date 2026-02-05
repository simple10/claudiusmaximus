# Cloudflare Origin CA Certificate Setup

**Only required if using Caddy networking option.** Skip this if using Cloudflare Tunnel.

This guide walks you through generating a Cloudflare Origin CA certificate for securing the connection between Cloudflare and your origin servers.

## Prerequisites

- Cloudflare account
- Domain added to Cloudflare with DNS managed by Cloudflare

## Step 1: Assign Domains to Your IP Addresses

Create A records pointing to your VPSs:

| Record | Type | Value |
|--------|------|-------|
| `openclaw.yourdomain.com` | A | `<VPS-1-IP>` |
| `grafana.yourdomain.com` | A | `<VPS-2-IP>` |

This enables:

- TLS certificates via Let's Encrypt
- Clean URLs instead of IP addresses

## Step 2: Generate Origin CA Certificate

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select your domain
3. Navigate to **SSL/TLS** → **Origin Server**
4. Click **Create Certificate**

## Step 3: Configure Certificate Options

| Setting | Recommended Value |
|---------|-------------------|
| Private key type | RSA (2048) |
| Hostnames | `*.yourdomain.com, yourdomain.com` |
| Certificate validity | 15 years |

Click **Create**.

## Step 4: Save Certificate and Key

**IMPORTANT:** The private key is only shown once. Save both immediately!

You'll see two text blocks:

- **Origin Certificate** - Save as `origin.pem`
- **Private Key** - Save as `origin.key`

Store these securely. You'll need them during the Caddy setup playbook.

## Step 5: Set SSL Mode

1. Go to **SSL/TLS** → **Overview**
2. Set encryption mode to **Full (strict)**

This ensures end-to-end encryption between visitors, Cloudflare, and your origin.

## Step 6: Configure DNS Records

For each service, add an A record pointing to the VPS IP:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | `claw` | `<VPS1_IP>` | Proxied (orange cloud) |
| A | `observe` | `<VPS2_IP>` | Proxied (orange cloud) |

The orange cloud (Proxied) is required for Cloudflare to terminate TLS.

## Using the Certificate

During the Caddy playbook (`playbooks/networking/caddy.md`), you'll copy these certificates to the server:

```bash
# On each VPS
sudo mkdir -p /etc/caddy/certs
sudo tee /etc/caddy/certs/origin.pem << 'EOF'
<paste certificate here>
EOF

sudo tee /etc/caddy/certs/origin.key << 'EOF'
<paste private key here>
EOF

sudo chmod 644 /etc/caddy/certs/origin.pem
sudo chmod 600 /etc/caddy/certs/origin.key
```

## Troubleshooting

### Certificate Not Trusted

Origin CA certificates are **only trusted by Cloudflare**. They won't work for direct access to the origin IP. This is expected - all traffic should go through Cloudflare.

### 526 Invalid SSL Certificate

- Verify certificate is correctly installed at `/etc/caddy/certs/origin.pem`
- Check private key matches the certificate
- Ensure Cloudflare SSL mode is "Full (strict)"

### Certificate Expired

Origin CA certificates can be valid for up to 15 years. If expired:

1. Generate a new certificate following the steps above
2. Replace the files on both VPSs
3. Reload Caddy: `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`
