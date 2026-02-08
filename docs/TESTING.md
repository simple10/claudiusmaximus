# OpenClaw Single-VPS Testing Guide

This document provides comprehensive testing instructions for verifying an existing OpenClaw single-VPS deployment is working correctly.

## Security Configuration Summary

Before testing, note these security configurations:

| Setting | Value | Reason |
|---------|-------|--------|
| **SSH Port** | 222 (not 22) | Avoid bot scanners |
| **OpenClaw Path** | `<OPENCLAW_DOMAIN_PATH>/` | Obscured URL (from openclaw-config.env) |
| **HTTP Port 80** | Blocked | No HTTP access |
| **HTTP Port 22** | Blocked | SSH on 222 |
| **HTTP Port 443** | Blocked | Cloudflare Tunnel uses outbound only |

---

## For Claude Code Agents

When asked to test the OpenClaw deployment, follow this complete checklist. Use the MCP Chrome DevTools for UI testing and SSH commands for backend verification.

### Test Configuration

Before testing, load the configuration:

```bash
# Read configuration file
cat /Users/joe/Development/openclaw/openclaw-vps/openclaw-config.env
```

Extract these values:

- `VPS1_IP` - OpenClaw VPS
- `SSH_KEY_PATH` - SSH key location
- `SSH_USER` - SSH username (should be `adminclaw` - the admin user with sudo)

---

## Test Suite

### 1. SSH Access

**Important**: SSH uses port 222 (not 22) to avoid bot scanners.

```bash
# Test SSH to VPS-1 (OpenClaw) - note port 222
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 -o ConnectTimeout=10 adminclaw@<VPS1_IP> "echo 'VPS-1 SSH OK'"
```

**Success criteria**: Command returns "VPS-1 SSH OK" without errors.

---

### 2. UFW Firewall

```bash
ssh -p 222 adminclaw@<VPS1_IP> "sudo ufw status"
```

**Success criteria**:

- Port 222/tcp: ALLOW (SSH on non-standard port)
- Port 22/tcp: NOT listed (blocked)
- Port 80/tcp: NOT listed (blocked)
- Port 443/tcp: NOT listed (blocked — Cloudflare Tunnel uses outbound only)
- Default: deny incoming

---

### 3. Docker Services

```bash
ssh -p 222 adminclaw@<VPS1_IP> "cd /home/openclaw/openclaw && sudo -u openclaw docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
```

**Expected services**:

- `openclaw-gateway` - Up (healthy)
- `vector` - Up

---

### 4. Cloudflare Tunnel

```bash
ssh -p 222 adminclaw@<VPS1_IP> "sudo systemctl status cloudflared --no-pager"
```

**Success criteria**: cloudflared service is active (running).

---

### 5. Gateway Health

```bash
ssh -p 222 adminclaw@<VPS1_IP> "curl -s http://localhost:18789/health"
```

**Success criteria**: Returns a health response (HTTP 200).

---

### 6. UI Testing with Chrome DevTools MCP

Use the Chrome DevTools MCP to test the web interface.

#### 6.1 Test OpenClaw Interface

**Important**: Services use obscured paths to avoid bot scanners.

```
# Navigate to OpenClaw page
mcp__chrome-devtools__navigate_page(url="https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/")

# Take a snapshot to verify the page loaded
mcp__chrome-devtools__take_snapshot()
```

**Success criteria**:

- Page loads without SSL errors
- Shows OpenClaw interface or token/pairing prompt
- No console errors related to connection failures

#### 6.2 Verify SSL and HTTPS-Only Access

```
# Check for SSL/TLS errors in console
mcp__chrome-devtools__list_console_messages(types=["error"])
```

**Success criteria**: No SSL certificate errors.

#### 6.3 Verify 404 on Unknown Paths

```
# Try random path - should return 404
mcp__chrome-devtools__navigate_page(url="https://<OPENCLAW_DOMAIN>/random-path")
mcp__chrome-devtools__take_snapshot()
```

**Success criteria**: Random paths return 404 (not proxied to backend).

---

### 7. Vector Log Shipping

```bash
# Check Vector is running and shipping logs
ssh -p 222 adminclaw@<VPS1_IP> "cd /home/openclaw/openclaw && sudo -u openclaw docker compose logs --tail 20 vector"
```

**Success criteria**: Vector logs show successful log shipping (no persistent errors).

---

### 8. Cloudflare Workers

```bash
# AI Gateway Worker health check
curl -s https://<AI_GATEWAY_WORKER_URL>/health

# Log Receiver Worker health check
curl -s https://<LOG_WORKER_URL>/health
```

**Success criteria**: Both return `{"status":"ok"}`.

---

### 9. Host Alerter

```bash
ssh -p 222 adminclaw@<VPS1_IP> "cat /etc/cron.d/host-alert 2>/dev/null || crontab -l 2>/dev/null | grep host-alert"
```

**Success criteria**: Cron job for `host-alert.sh` exists.

---

### 10. Backup

```bash
ssh -p 222 adminclaw@<VPS1_IP> "cat /etc/cron.d/openclaw-backup"
```

**Success criteria**: Cron job for backup script exists.

---

## Complete Test Summary

After running all tests, compile results:

| Category | Test | Status |
|----------|------|--------|
| **Network** | SSH to VPS-1 (port 222) | ✓/✗ |
| | UFW firewall rules | ✓/✗ |
| **Services** | Docker containers | ✓/✗ |
| | Cloudflare Tunnel | ✓/✗ |
| | Gateway health | ✓/✗ |
| **UI** | OpenClaw loads | ✓/✗ |
| | Valid SSL | ✓/✗ |
| **Logging** | Vector shipping logs | ✓/✗ |
| **Workers** | AI Gateway healthy | ✓/✗ |
| | Log Receiver healthy | ✓/✗ |
| **Monitoring** | Host alerter cron | ✓/✗ |
| | Backup cron | ✓/✗ |

---

## Quick Test Command

For a rapid health check, run this single command (note: SSH uses port 222):

```bash
echo "=== VPS-1 Health ===" && \
ssh -p 222 adminclaw@<VPS1_IP> "sudo -u openclaw docker ps --format '{{.Names}}: {{.Status}}' && echo && curl -s http://localhost:18789/health && echo && sudo systemctl is-active cloudflared"
```

---

## Troubleshooting Common Issues

### SSL Certificate Errors in Browser

1. Check Cloudflare SSL mode is "Full (strict)"
2. Verify tunnel is running: `sudo systemctl status cloudflared`
3. Check DNS routes through tunnel: `dig <OPENCLAW_DOMAIN>`

### Gateway Not Healthy

1. Check container logs: `sudo -u openclaw docker compose logs --tail 50 openclaw-gateway`
2. Check container is running: `sudo -u openclaw docker compose ps`
3. Verify localhost access: `curl -s http://localhost:18789/health`

### No Logs in Cloudflare

1. Check Vector logs: `sudo -u openclaw docker compose logs vector`
2. Verify LOG_WORKER_URL includes `/logs` path
3. Check Log Receiver Worker health: `curl -s https://<LOG_WORKER_URL>/health`

### Container Permission Errors

1. Check container user matches volume ownership
2. Verify `.openclaw` is owned by uid 1000: `ls -la /home/openclaw/.openclaw/`
3. Review `read_only` settings if files can't be written
