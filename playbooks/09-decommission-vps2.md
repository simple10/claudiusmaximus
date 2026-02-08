# 09 - Decommission VPS-2

Remove the observability stack from VPS-2 after migrating to the single-VPS architecture.

## Overview

This playbook:
- Stops all monitoring containers on VPS-2
- Removes the Cloudflare Tunnel for Grafana
- Removes WireGuard from both VPSs
- Cleans up UFW rules on both VPSs

## Prerequisites

- Single-VPS architecture fully deployed and verified (07-verification.md)
- Vector shipping logs to Cloudflare Worker successfully
- AI Gateway Worker routing LLM requests successfully
- Backup of VPS-2 data taken (if desired)

## Important

This is a destructive operation. Verify the new architecture is working correctly before proceeding.

---

## 9.1 Stop Monitoring Stack (VPS-2)

```bash
ssh -p 222 adminclaw@<VPS2_IP>

# Stop all monitoring containers
cd /home/openclaw/monitoring
sudo -u openclaw docker compose down

# Verify all containers stopped
sudo -u openclaw docker compose ps
```

---

## 9.2 Remove Cloudflare Tunnel (VPS-2)

```bash
# Stop and disable cloudflared service
sudo systemctl stop cloudflared
sudo systemctl disable cloudflared

# Delete the tunnel
cloudflared tunnel delete observe

# Remove DNS route for Grafana domain (if needed, do this in Cloudflare Dashboard)
# Delete the CNAME record for DOMAIN_GRAFANA

# Clean up config
sudo rm -rf /etc/cloudflared/
rm -rf ~/.cloudflared/
```

---

## 9.3 Remove WireGuard (VPS-2)

```bash
# Stop and disable WireGuard
sudo systemctl stop wg-quick@wg0
sudo systemctl disable wg-quick@wg0

# Remove config and keys
sudo rm -f /etc/wireguard/wg0.conf /etc/wireguard/private.key

# Remove WireGuard packages
sudo apt remove -y wireguard wireguard-tools

# Remove UFW rule
sudo ufw delete allow 51820/udp
sudo ufw delete allow from 10.0.0.0/24
sudo ufw reload
```

---

## 9.4 Remove WireGuard (VPS-1)

```bash
ssh -p 222 adminclaw@<VPS1_IP>

# Stop and disable WireGuard
sudo systemctl stop wg-quick@wg0
sudo systemctl disable wg-quick@wg0

# Remove config and keys
sudo rm -f /etc/wireguard/wg0.conf /etc/wireguard/private.key

# Remove WireGuard packages
sudo apt remove -y wireguard wireguard-tools

# Clean up UFW rules related to WireGuard
sudo ufw delete allow 51820/udp
# Remove VPS-2 specific rules (if they exist)
sudo ufw delete allow from 10.0.0.0/24 to any port 9100
sudo ufw delete allow from 10.0.0.0/24 to any port 18789
sudo ufw reload
```

---

## 9.5 Remove Promtail and Node Exporter (VPS-1)

If these were running as separate containers (not via docker-compose.override.yml), stop and remove them:

```bash
# Stop containers if running outside compose
sudo docker stop promtail node-exporter 2>/dev/null || true
sudo docker rm promtail node-exporter 2>/dev/null || true

# Remove promtail config and positions
rm -f /home/openclaw/openclaw/promtail-config.yml
rm -rf /home/openclaw/openclaw/promtail-positions/
```

---

## 9.6 Verify Cleanup

### VPS-1

```bash
# No WireGuard interface
ip link show wg0 2>&1 | grep -q "does not exist" && echo "OK: No WireGuard"

# UFW only has SSH
sudo ufw status

# Only gateway and vector containers running
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'

# No promtail or node-exporter
sudo docker ps | grep -E "promtail|node-exporter" && echo "FAIL" || echo "OK: No promtail/node-exporter"
```

### VPS-2

```bash
# No containers running
sudo docker ps

# No WireGuard
ip link show wg0 2>&1 | grep -q "does not exist" && echo "OK: No WireGuard"

# No cloudflared
sudo systemctl status cloudflared 2>&1 | grep -q "could not be found" && echo "OK: No cloudflared"
```

---

## 9.7 VPS-2 Cancellation

After verifying cleanup, you may:

1. **Cancel the VPS** — If VPS-2 is no longer needed
2. **Repurpose it** — Use for another project
3. **Keep as standby** — Leave it idle for future use

This is a user decision — the decommission playbook does not cancel the VPS automatically.

---

## Rollback

If you need to restore the two-VPS architecture, the `otel-v1` branch preserves the full OTEL-based configuration:

```bash
git checkout otel-v1
```

This branch contains all the OTEL patches, Promtail config, VPS-2 monitoring compose files, and WireGuard setup.
