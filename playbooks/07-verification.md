# 07 - Verification & Testing

Comprehensive verification procedures after deployment for playbooks 01 through 06.

## Overview

This playbook verifies:

- WireGuard tunnel connectivity
- OpenClaw gateway functionality
- Monitoring stack health
- End-to-end connectivity

## Prerequisites

- All previous playbooks completed
- Networking playbook (cloudflare-tunnel or caddy) completed
- Both VPSs rebooted after configuration

## Pre-Verification: Reboot Both VPSs

Before running verification tests, reboot both VPSs to ensure all configuration changes take effect cleanly (especially kernel parameters, SSH config, and systemd services).

**On VPS-1:**

```bash
sudo reboot
```

**On VPS-2:**

```bash
sudo reboot
```

Wait 1-2 minutes for both VPSs to come back online, then verify SSH access:

```bash
# Test SSH to both VPSs on port 222 (using adminclaw)
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 adminclaw@<VPS1-IP> "echo 'VPS-1 online'"
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 adminclaw@<VPS2-IP> "echo 'VPS-2 online'"
```

---

## 7.1 Verify WireGuard Tunnel

### On VPS-1

```bash
# Check interface is up
sudo wg show

# Ping VPS-2
ping -c 3 10.0.0.2
```

### On VPS-2

```bash
# Check interface is up
sudo wg show

# Ping VPS-1
ping -c 3 10.0.0.1
```

**Expected:** Both pings succeed, `wg show` shows "latest handshake" within the last minute.

---

## 7.2 Verify OpenClaw (VPS-1)

```bash
# Check containers are running
cd /home/openclaw/openclaw
sudo -u openclaw docker compose ps

# Check logs for errors
sudo docker logs --tail 50 openclaw-openclaw-gateway-1

# Test internal endpoint
curl -s http://localhost:18789/ | head -5

# Test health endpoint
curl -s http://localhost:18789/health

# Check Node Exporter
curl -s http://localhost:9100/metrics | head -5

# Check Promtail
sudo docker logs --tail 10 promtail
```

**Expected:** All containers running, health endpoint returns OK.

---

## 7.3 Verify Monitoring (VPS-2)

```bash
# Check containers are running
cd /home/openclaw/monitoring
sudo -u openclaw docker compose ps

# Test Prometheus targets (should show all targets as "up")
curl -s http://localhost:9090/api/v1/targets | jq -r '.data.activeTargets[] | .scrapePool + ": " + .health'

# Test Loki readiness
curl -s http://10.0.0.2:3100/ready

# Test Grafana health
curl -s http://localhost:3000/api/health

# Test Alertmanager
curl -s http://localhost:9093/-/healthy
```

**Expected:** All containers running, all Prometheus targets "up", Loki and Grafana healthy.

---

## 7.4 Verify Cross-VPS Metrics

From VPS-2, verify it can scrape VPS-1 metrics:

```bash
# Test Node Exporter on VPS-1
curl -s http://10.0.0.1:9100/metrics | head -5

# Check Prometheus is scraping successfully
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | select(.scrapePool | contains("openclaw")) | {job: .scrapePool, health: .health}'
```

**Expected:** Metrics returned from VPS-1, Prometheus shows "up" for OpenClaw targets.

---

## 7.5 Verify Log Shipping

From VPS-2, verify Loki is receiving logs from VPS-1:

```bash
# Query recent logs
curl -s "http://10.0.0.2:3100/loki/api/v1/query" \
  --data-urlencode 'query={host="openclaw"}' | jq '.data.result | length'

# Should return > 0 if logs are flowing
```

From VPS-1, check Promtail:

```bash
sudo docker logs --tail 20 promtail
```

**Expected:** Promtail shows successful pushes to Loki, Loki has logs from "openclaw" host.

---

## 7.6 Verify External Access

The specific tests depend on which networking option you chose.

### If using Cloudflare Tunnel

```bash
# On VPS-1, verify tunnel is running
sudo systemctl status cloudflared

# Test external access (from any machine)
curl -s https://claw.example.com/_openclaw/ | head -5

# Verify direct IP access is blocked
curl -sk --connect-timeout 5 https://<VPS1-IP>/ || echo "Direct access blocked (expected)"
```

### If using Caddy

```bash
# On VPS-1, verify Caddy is running
sudo docker ps | grep caddy

# Test HTTPS locally
curl -sk https://localhost:443/_openclaw/ | head -5

# Verify port 80 is blocked
curl -s --connect-timeout 3 http://localhost:80/ || echo "Port 80 blocked (expected)"
```

---

## 7.7 Security Checklist

### Both VPSs

- [ ] SSH on port 222 only (port 22 removed from UFW)
- [ ] SSH key-only authentication (password disabled)
- [ ] Only `adminclaw` user can SSH (AllowUsers directive)
- [ ] UFW enabled with minimal rules
- [ ] Fail2ban running
- [ ] WireGuard tunnel active

```bash
# Verify on each VPS
sudo ufw status
sudo systemctl status fail2ban
sudo wg show
ss -tlnp | grep 222
```

### VPS-1 (OpenClaw)

- [ ] OpenClaw gateway running
- [ ] Sysbox runtime available
- [ ] Node Exporter accessible via WireGuard
- [ ] Promtail shipping logs
- [ ] Backup cron job configured

```bash
sudo systemctl status sysbox
sudo -u openclaw docker compose ps
curl http://localhost:9100/metrics | head -1
cat /etc/cron.d/openclaw-backup
```

### VPS-2 (Observability)

- [ ] All monitoring containers running
- [ ] Prometheus scraping all targets
- [ ] Loki receiving logs
- [ ] Grafana accessible

```bash
sudo -u openclaw docker compose ps
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[].health' | sort | uniq -c
curl -s http://10.0.0.2:3100/ready
```

---

## 7.8 End-to-End Test

1. **Access OpenClaw** via configured domain
2. **Login to Grafana** at `https://<grafana-domain>/_observe/grafana/`
3. **Verify Prometheus targets** in Grafana → Explore → Prometheus
4. **Check logs flowing** in Grafana → Explore → Loki → `{host="openclaw"}`
5. **Trigger a test alert** (optional):

   ```bash
   # Stop Node Exporter on VPS-1 temporarily
   sudo docker stop node-exporter
   # Wait 1-2 minutes, check Alertmanager
   curl http://localhost:9093/api/v2/alerts
   # Restart
   sudo docker start node-exporter
   ```

---

## Troubleshooting Quick Reference

### WireGuard Issues

```bash
sudo wg show
sudo systemctl status wg-quick@wg0
sudo journalctl -u wg-quick@wg0
sudo ufw status | grep 51820
```

### Container Issues

```bash
sudo -u openclaw docker compose ps
sudo -u openclaw docker compose logs -f <service>
docker system df
free -h
```

### Networking Issues

```bash
ss -tlnp                          # List listening ports
curl -v http://localhost:PORT/    # Test local connectivity
sudo ufw status                   # Check firewall rules
```

### Service Not Starting After Reboot

```bash
sudo systemctl status <service>
sudo systemctl enable <service>
sudo journalctl -u <service> -f
```

---

## Success Criteria

Deployment is complete when:

1. ✅ Both VPSs accessible via SSH on port 222
2. ✅ WireGuard tunnel active with recent handshakes
3. ✅ OpenClaw gateway responding on VPS-1
4. ✅ All Prometheus targets showing "up"
5. ✅ Logs appearing in Loki from VPS-1
6. ✅ Grafana accessible with working datasources
7. ✅ External access working via configured networking option
8. ✅ Backup cron job configured on VPS-1
