# OpenClaw Two-VPS Testing Guide

This document provides comprehensive testing instructions for verifying an existing OpenClaw two-VPS deployment is working correctly.

## Security Configuration Summary

Before testing, note these security configurations:

| Setting | Value | Reason |
|---------|-------|--------|
| **SSH Port** | 222 (not 22) | Avoid bot scanners |
| **OpenClaw Path** | `<SUBPATH_OPENCLAW>/` | Obscured URL (from openclaw-config.env) |
| **Grafana Path** | `<SUBPATH_GRAFANA>/` | Obscured URL (from openclaw-config.env) |
| **HTTP Port 80** | Blocked | HTTPS-only |
| **HTTP Port 22** | Blocked | SSH on 222 |

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
- `VPS2_IP` - Observability VPS
- `SSH_KEY_PATH` - SSH key location
- `SSH_USER` - SSH username (should be `adminclaw` - the admin user with sudo)

---

## Test Suite

### 1. Network Connectivity Tests

#### 1.1 SSH Access

**Important**: SSH uses port 222 (not 22) to avoid bot scanners.

```bash
# Test SSH to VPS-1 (OpenClaw) - note port 222
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 -o ConnectTimeout=10 openclaw@<VPS1_IP> "echo 'VPS-1 SSH OK'"

# Test SSH to VPS-2 (Observability) - note port 222
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 -o ConnectTimeout=10 openclaw@<VPS2_IP> "echo 'VPS-2 SSH OK'"
```

**Success criteria**: Both commands return "OK" messages without errors.

#### 1.2 WireGuard Tunnel

```bash
# On VPS-1: Check tunnel status and connectivity
ssh -p 222 adminclaw@<VPS1_IP> "sudo wg show && ping -c 3 10.0.0.2"

# On VPS-2: Check tunnel status and connectivity
ssh -p 222 adminclaw@<VPS2_IP> "sudo wg show && ping -c 3 10.0.0.1"
```

**Success criteria**:

- `wg show` displays peer connection with recent handshake
- Ping shows 0% packet loss

#### 1.3 Port Accessibility (Security Check)

```bash
# Test that only HTTPS (443) and SSH (222) are accessible from public internet
# Port 80 should be blocked (not allowed)
# Port 22 should be blocked (SSH is on 222)

# On VPS-1
ssh -p 222 adminclaw@<VPS1_IP> "sudo ufw status"

# On VPS-2
ssh -p 222 adminclaw@<VPS2_IP> "sudo ufw status"
```

**Success criteria**:

- Port 222/tcp: ALLOW (SSH on non-standard port)
- Port 443/tcp: ALLOW (HTTPS)
- Port 51820/udp: ALLOW (WireGuard)
- Port 22/tcp: NOT listed (blocked)
- Port 80/tcp: NOT listed (blocked)
- Default: deny incoming

---

### 2. Service Health Tests

#### 2.1 VPS-1 Docker Services

```bash
ssh -p 222 adminclaw@<VPS1_IP> "cd /home/openclaw/openclaw && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
```

**Expected services**:

- `openclaw-gateway` - Up (healthy)
- `node-exporter` - Up
- `promtail` - Up

#### 2.2 VPS-1 Caddy Reverse Proxy

```bash
ssh -p 222 adminclaw@<VPS1_IP> "docker ps --filter name=caddy --format 'table {{.Names}}\t{{.Status}}'"
```

**Success criteria**: Caddy container is running.

#### 2.3 VPS-2 Docker Services

```bash
ssh -p 222 adminclaw@<VPS2_IP> "cd /home/openclaw/monitoring && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
```

**Expected services**:

- `prometheus` - Up
- `grafana` - Up
- `loki` - Up
- `tempo` - Up
- `alertmanager` - Up
- `node-exporter` - Up
- `cadvisor` - Up

#### 2.4 VPS-2 Caddy Reverse Proxy

```bash
ssh -p 222 adminclaw@<VPS2_IP> "docker ps --filter name=caddy --format 'table {{.Names}}\t{{.Status}}'"
```

**Success criteria**: Caddy container is running.

---

### 3. System Log Verification

#### 3.1 Check for Permission Errors on VPS-1

```bash
ssh -p 222 adminclaw@<VPS1_IP> "sudo journalctl -p err -n 50 --no-pager"
```

**Success criteria**: No permission-related errors for openclaw-gateway container.

#### 3.2 Check for Permission Errors on VPS-2

```bash
ssh -p 222 adminclaw@<VPS2_IP> "sudo journalctl -p err -n 50 --no-pager"
```

**Success criteria**: No critical errors related to monitoring stack.

#### 3.3 Check OpenClaw Gateway Logs

```bash
ssh -p 222 adminclaw@<VPS1_IP> "cd /home/openclaw/openclaw && docker compose logs --tail 50 openclaw-gateway"
```

**Success criteria**: No error messages, gateway is listening on expected port.

---

### 4. UI Testing with Chrome DevTools MCP

Use the Chrome DevTools MCP to test the web interfaces.

#### 4.1 Test OpenClaw Admin Interface

**Important**: Services use obscured paths to avoid bot scanners.

```
# Navigate to OpenClaw admin page (note: <SUBPATH_OPENCLAW>/_admin path)
mcp__chrome-devtools__navigate_page(url="https://openclaw.yourdomain.com<SUBPATH_OPENCLAW>/_admin")

# Take a snapshot to verify the page loaded
mcp__chrome-devtools__take_snapshot()
```

**Success criteria**:

- Page loads without SSL errors
- Shows OpenClaw admin interface or token prompt
- No console errors related to connection failures

#### 4.2 Test Grafana Interface

```
# Navigate to Grafana (note: <SUBPATH_GRAFANA>/ path)
mcp__chrome-devtools__navigate_page(url="https://observe.yourdomain.com<SUBPATH_GRAFANA>/")

# Take a snapshot
mcp__chrome-devtools__take_snapshot()
```

**Success criteria**:

- Page loads with valid SSL
- Shows Grafana login page or dashboard
- No console errors

#### 4.3 Verify SSL Certificates

```
# Check for SSL/TLS errors in console
mcp__chrome-devtools__list_console_messages(types=["error"])
```

**Success criteria**: No SSL certificate errors.

#### 4.4 Verify HTTPS-Only Access and 404 on Root

```
# Try root path - should redirect to <SUBPATH_OPENCLAW>/ or return 404
mcp__chrome-devtools__navigate_page(url="https://openclaw.yourdomain.com/")
mcp__chrome-devtools__take_snapshot()

# Try random path - should return 404
mcp__chrome-devtools__navigate_page(url="https://openclaw.yourdomain.com/random-path")
mcp__chrome-devtools__take_snapshot()
```

**Success criteria**:

- Root redirects to `<SUBPATH_OPENCLAW>/` or obscured path
- Random paths return 404 (not proxied to backend)

---

### 4.5 Security Hardening Verification (VPS-2)

Verify that monitoring services are bound to localhost (not exposed publicly):

```bash
ssh -p 222 adminclaw@<VPS2_IP> "sudo ss -tlnp | grep -E '(9090|3000|3100|3200|4318|9093|9100|8080)'"
```

**Success criteria** - Services should bind to these addresses:

- `10.0.0.2:9090` - Prometheus (WireGuard only, receives OTLP metrics)
- `127.0.0.1:3000` - Grafana (localhost only)
- `10.0.0.2:3100` - Loki (WireGuard only)
- `127.0.0.1:3200` - Tempo HTTP API (localhost only)
- `10.0.0.2:4318` - Tempo OTLP receiver (WireGuard only)
- `127.0.0.1:9093` - Alertmanager (localhost only)
- `127.0.0.1:9100` - Node Exporter (localhost only)
- `127.0.0.1:8080` - cAdvisor (localhost only)

**Security note**: Prometheus, Loki, and Tempo OTLP are accessible via WireGuard (Prometheus receives OTLP metrics, Loki receives logs from Promtail and OTLP, Tempo receives traces). All other services are bound to localhost, providing defense-in-depth even if UFW is misconfigured.

---

### 5. Metrics and Logging Pipeline

#### 5.1 Prometheus Targets

```bash
# Note: Prometheus is bound to WireGuard IP (10.0.0.2) - receives OTLP metrics from VPS-1
ssh -p 222 adminclaw@<VPS2_IP> "curl -s http://10.0.0.2:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'"
```

**Success criteria**: These targets should show `"health": "up"`:

- prometheus
- node-exporter-local
- cadvisor-local
- node-exporter-openclaw

#### 5.2 Loki Health

```bash
# Note: Loki is bound to WireGuard IP (10.0.0.2) for security
ssh -p 222 adminclaw@<VPS2_IP> "curl -s http://10.0.0.2:3100/ready"
```

**Success criteria**: Returns "ready" (may show "Ingester not ready" briefly after restart - wait 15s and retry).

#### 5.3 Verify Logs Flowing to Loki

```bash
# Check if logs from VPS-1 are appearing in Loki
# Note: Loki is bound to WireGuard IP (10.0.0.2) for security
ssh -p 222 adminclaw@<VPS2_IP> "curl -s http://10.0.0.2:3100/loki/api/v1/labels | jq '.data'"
```

**Success criteria**: Returns a number > 0 (indicates logs are being received).

---

### 6. Grafana Loki Integration Test (UI)

#### 6.1 Login to Grafana

First, get the Grafana password:

```bash
ssh -p 222 adminclaw@<VPS2_IP> "cat /home/openclaw/monitoring/.env | grep GRAFANA_PASSWORD"
```

Then use DevTools to test:

```
# Navigate to Grafana login (note: <SUBPATH_GRAFANA>/ path)
mcp__chrome-devtools__navigate_page(url="https://observe.yourdomain.com<SUBPATH_GRAFANA>/login")
mcp__chrome-devtools__take_snapshot()

# Fill login form (adjust uids based on snapshot)
mcp__chrome-devtools__fill(uid="<username-field-uid>", value="admin")
mcp__chrome-devtools__fill(uid="<password-field-uid>", value="<GRAFANA_PASSWORD>")
mcp__chrome-devtools__click(uid="<login-button-uid>")
```

#### 6.2 Navigate to Explore and Check Loki

```
# Navigate to Explore page (note: <SUBPATH_GRAFANA>/ path)
mcp__chrome-devtools__navigate_page(url="https://observe.yourdomain.com<SUBPATH_GRAFANA>/explore")
mcp__chrome-devtools__take_snapshot()

# Select Loki datasource and run a query
# Look for the datasource selector and select Loki
# Then look for job labels like "docker" or "varlogs"
```

**Success criteria**:

- Loki datasource is available
- Can query logs with `{job="docker"}` or `{host="openclaw"}`
- Recent logs appear in results

---

## Complete Test Summary

After running all tests, compile results:

| Category | Test | Status |
|----------|------|--------|
| **Network** | SSH to VPS-1 | ✓/✗ |
| | SSH to VPS-2 | ✓/✗ |
| | WireGuard tunnel | ✓/✗ |
| | HTTPS-only access | ✓/✗ |
| **Services** | VPS-1 containers | ✓/✗ |
| | VPS-2 containers | ✓/✗ |
| | Caddy (both) | ✓/✗ |
| **Logs** | No permission errors | ✓/✗ |
| | Gateway logs clean | ✓/✗ |
| **UI** | OpenClaw admin loads | ✓/✗ |
| | Grafana loads | ✓/✗ |
| | Valid SSL certs | ✓/✗ |
| **Pipeline** | Prometheus targets up | ✓/✗ |
| | Loki ready | ✓/✗ |
| | Logs in Grafana | ✓/✗ |

---

## Quick Test Command

For a rapid health check, run this single command (note: SSH uses port 222):

```bash
echo "=== VPS-1 Health ===" && \
ssh -p 222 adminclaw@<VPS1_IP> "sudo docker ps --format '{{.Names}}: {{.Status}}' && echo && sudo wg show wg0 | head -3" && \
echo && echo "=== VPS-2 Health ===" && \
ssh -p 222 adminclaw@<VPS2_IP> "sudo docker ps --format '{{.Names}}: {{.Status}}' && curl -s http://10.0.0.2:9090/api/v1/targets | jq -r '.data.activeTargets[] | \"\(.labels.job): \(.health)\"'"
```

---

## Troubleshooting Common Issues

### SSL Certificate Errors in Browser

1. Check Cloudflare SSL mode is "Full (strict)"
2. Verify origin certificates are correctly installed on Caddy
3. Check certificate expiration dates

### Prometheus Target Down

1. Check WireGuard tunnel connectivity
2. Verify the service is running on VPS-1
3. Check firewall rules allow internal traffic

### No Logs in Loki

1. Check Promtail logs on VPS-1: `docker compose logs promtail`
2. Verify Promtail can reach Loki at `10.0.0.2:3100`
3. Check Loki logs on VPS-2: `docker compose logs loki`

### Container Permission Errors

1. Check container user matches volume ownership
2. Verify tmpfs mounts are configured for writable directories
3. Review `read_only` settings if files can't be written
