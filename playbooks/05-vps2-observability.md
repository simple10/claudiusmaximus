# 05 - VPS-2 Observability Setup

Install and configure the observability stack on VPS-2.

## Overview

This playbook configures:
- Prometheus for metrics collection
- Grafana for dashboards
- Loki for log aggregation
- Tempo for distributed tracing
- Alertmanager for alerts
- Node Exporter and cAdvisor for host metrics

## Prerequisites

- [01-base-setup.md](01-base-setup.md) completed on VPS-2
- [02-wireguard.md](02-wireguard.md) completed (tunnel active)
- [03-docker.md](03-docker.md) completed on VPS-2
- SSH access as `adminclaw` on port 222

## Variables

From `../openclaw-config.env`:
- `DOMAIN_GRAFANA` - Domain for Grafana (e.g., observe.example.com)

Generated:
- `GRAFANA_PASSWORD` - Auto-generated admin password

---

## 5.1 Create Directory Structure

```bash
#!/bin/bash
sudo -u openclaw bash << 'EOF'
mkdir -p /home/openclaw/monitoring
mkdir -p /home/openclaw/monitoring/grafana/provisioning/datasources
mkdir -p /home/openclaw/monitoring/grafana/provisioning/dashboards

# Persistent data directories (bind mounts instead of named volumes)
# These live under monitoring/ so a single rsync captures everything
mkdir -p /home/openclaw/monitoring/data/prometheus
mkdir -p /home/openclaw/monitoring/data/grafana
mkdir -p /home/openclaw/monitoring/data/loki
mkdir -p /home/openclaw/monitoring/data/tempo
mkdir -p /home/openclaw/monitoring/data/alertmanager
EOF

# Fix ownership per container expectations
sudo chown -R 65534:65534 /home/openclaw/monitoring/data/prometheus
sudo chown -R 65534:65534 /home/openclaw/monitoring/data/alertmanager
sudo chown -R 472:root /home/openclaw/monitoring/data/grafana
sudo chown -R 10001:10001 /home/openclaw/monitoring/data/loki
sudo chown -R 10001:10001 /home/openclaw/monitoring/data/tempo
```

---

## 5.2 Create Docker Compose for Monitoring

```bash
#!/bin/bash
# SECURITY: All services use host network but bind to localhost where possible
# Loki, Tempo, and Prometheus need WireGuard access (receive OTLP data from VPS-1)
# Prometheus receives OTLP metrics from VPS-1 and scrapes VPS-1 via WireGuard
sudo -u openclaw tee /home/openclaw/monitoring/docker-compose.yml << 'EOF'
services:
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    restart: unless-stopped
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./alerts.yml:/etc/prometheus/alerts.yml:ro
      - ./data/prometheus:/prometheus
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.path=/prometheus"
      - "--storage.tsdb.retention.time=30d"
      - "--web.enable-lifecycle"
      # SECURITY: Bind to WireGuard IP - receives OTLP metrics from VPS-1
      # Same pattern as Loki (WireGuard only, not public)
      - "--web.listen-address=10.0.0.2:9090"
      # Enable OTLP receiver for OpenClaw app metrics
      - "--web.enable-otlp-receiver"
    network_mode: host

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    restart: unless-stopped
    volumes:
      - ./data/grafana:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD}
      - GF_USERS_ALLOW_SIGN_UP=false
      # Serve Grafana under subpath to avoid bot scanners
      - GF_SERVER_ROOT_URL=https://${GRAFANA_DOMAIN:-localhost}/_observe/grafana/
      - GF_SERVER_SERVE_FROM_SUB_PATH=true
      # SECURITY: Bind to localhost only - reverse proxy handles external access
      - GF_SERVER_HTTP_ADDR=127.0.0.1
    network_mode: host

  loki:
    image: grafana/loki:latest
    container_name: loki
    restart: unless-stopped
    volumes:
      - ./loki-config.yml:/etc/loki/local-config.yaml:ro
      - ./data/loki:/loki
    command: -config.file=/etc/loki/local-config.yaml
    # NOTE: Loki needs WireGuard access - Promtail on VPS-1 pushes logs to 10.0.0.2:3100
    # Binding configured in loki-config.yml to listen on WireGuard interface
    network_mode: host

  alertmanager:
    image: prom/alertmanager:latest
    container_name: alertmanager
    restart: unless-stopped
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - ./data/alertmanager:/alertmanager
    command:
      - "--config.file=/etc/alertmanager/alertmanager.yml"
      - "--storage.path=/alertmanager"
      # SECURITY: Bind to localhost only - accessed by Prometheus, not externally
      - "--web.listen-address=127.0.0.1:9093"
    network_mode: host

  node-exporter:
    image: prom/node-exporter:latest
    container_name: node-exporter
    restart: unless-stopped
    command:
      - "--path.procfs=/host/proc"
      - "--path.sysfs=/host/sys"
      - "--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)"
      # SECURITY: Bind to localhost only - scraped by local Prometheus
      - "--web.listen-address=127.0.0.1:9100"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    network_mode: host

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    container_name: cadvisor
    restart: unless-stopped
    # SECURITY: Bind to localhost only - scraped by local Prometheus
    command:
      - "--listen_ip=127.0.0.1"
      - "--port=8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    network_mode: host

  tempo:
    image: grafana/tempo:latest
    container_name: tempo
    restart: unless-stopped
    volumes:
      - ./tempo-config.yml:/etc/tempo/config.yaml:ro
      - ./data/tempo:/var/tempo
    command: ["-config.file=/etc/tempo/config.yaml"]
    # NOTE: Tempo needs WireGuard access - OpenClaw on VPS-1 pushes traces to 10.0.0.2:4318
    # Binding configured in tempo-config.yml
    network_mode: host

# No custom networks needed - all services use host network with localhost binding
# Data persisted via bind mounts under ./data/ (no named volumes)
EOF
```

---

## 5.3 Create Prometheus Configuration

```bash
#!/bin/bash
# Local services bound to 127.0.0.1 for security
# VPS-1 metrics accessed via WireGuard (10.0.0.1)
sudo -u openclaw tee /home/openclaw/monitoring/prometheus.yml << 'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["127.0.0.1:9093"]

rule_files:
  - alerts.yml

scrape_configs:
  - job_name: "prometheus"
    static_configs:
      - targets: ["10.0.0.2:9090"]

  # Local VPS-2 metrics (bound to 127.0.0.1 for security)
  - job_name: "node-exporter-local"
    static_configs:
      - targets: ["127.0.0.1:9100"]
        labels:
          host: "observe"

  - job_name: "cadvisor-local"
    static_configs:
      - targets: ["127.0.0.1:8080"]
        labels:
          host: "observe"

  # Remote VPS-1 metrics (via WireGuard)
  - job_name: "node-exporter-openclaw"
    static_configs:
      - targets: ["10.0.0.1:9100"]
        labels:
          host: "openclaw"

EOF
```

---

## 5.4 Create Alert Rules

```bash
#!/bin/bash
# IMPORTANT: Use proper YAML - do not escape $ in template variables
sudo -u openclaw tee /home/openclaw/monitoring/alerts.yml << 'EOF'
groups:
  - name: openclaw
    rules:
      - alert: OpenClawHostDown
        expr: up{job="node-exporter-openclaw"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "OpenClaw host (VPS-1) is unreachable"
          description: "Cannot scrape Node Exporter on VPS-1 for more than 2 minutes."

      - alert: HighMemoryUsage
        expr: (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage on {{ $labels.host }}"
          description: "Memory usage is above 90% for more than 5 minutes."

      - alert: HighDiskUsage
        expr: (1 - (node_filesystem_avail_bytes{fstype!="tmpfs"} / node_filesystem_size_bytes{fstype!="tmpfs"})) > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High disk usage on {{ $labels.host }}"
          description: "Disk usage is above 85%."

      - alert: HighCPUUsage
        expr: 100 - (avg by(host) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 80
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High CPU usage on {{ $labels.host }}"
          description: "CPU usage is above 80% for more than 10 minutes."
EOF
```

---

## 5.5 Create Alertmanager Configuration

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/monitoring/alertmanager.yml << 'EOF'
global:
  resolve_timeout: 5m

route:
  group_by: ["alertname", "host"]
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 1h
  receiver: "default"

receivers:
  - name: "default"
    # Configure webhooks, email, Slack, etc. as needed
EOF
```

---

## 5.6 Create Loki Configuration

```bash
#!/bin/bash
# IMPORTANT: Use schema v13 with tsdb store (required by newer Loki versions)
# SECURITY: Loki binds to WireGuard IP (10.0.0.2) for Promtail access from VPS-1
sudo -u openclaw tee /home/openclaw/monitoring/loki-config.yml << 'EOF'
auth_enabled: false

server:
  # SECURITY: Bind to WireGuard IP - receives logs from VPS-1 Promtail
  # IMPORTANT: Both HTTP and gRPC must be on same interface (10.0.0.2) for internal
  # component communication. Using different interfaces causes "connection refused" errors.
  http_listen_address: 10.0.0.2
  http_listen_port: 3100
  grpc_listen_address: 10.0.0.2
  grpc_listen_port: 9096

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    # Must match the listen addresses for internal communication
    instance_addr: 10.0.0.2
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2020-10-24
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

ruler:
  alertmanager_url: http://127.0.0.1:9093

limits_config:
  retention_period: 720h
  # Required for OTLP log ingestion (structured metadata from OTEL attributes)
  allow_structured_metadata: true
EOF
```

---

## 5.6a Create Tempo Configuration

```bash
#!/bin/bash
# SECURITY: Tempo HTTP API on localhost, OTLP receiver on WireGuard (10.0.0.2:4318)
# OpenClaw on VPS-1 pushes traces via OTLP/HTTP over WireGuard
sudo -u openclaw tee /home/openclaw/monitoring/tempo-config.yml << 'EOF'
stream_over_http_enabled: true

server:
  http_listen_address: 127.0.0.1
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: "10.0.0.2:4318"

ingester:
  max_block_duration: 5m
  lifecycler:
    ring:
      kvstore:
        store: inmemory
      replication_factor: 1

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/blocks
    wal:
      path: /var/tempo/wal
EOF
```

---

## 5.7 Create Grafana Datasource Provisioning

```bash
#!/bin/bash
# Prometheus: WireGuard IP (bound to 10.0.0.2 - receives OTLP metrics from VPS-1)
# Loki: WireGuard IP (bound to 10.0.0.2 for security - same host, still accessible)
sudo -u openclaw tee /home/openclaw/monitoring/grafana/provisioning/datasources/datasources.yml << 'EOF'
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    # Prometheus binds to WireGuard IP (receives OTLP metrics from VPS-1)
    # Grafana on same host can still reach it via this IP
    url: http://10.0.0.2:9090
    isDefault: true
    editable: false

  - name: Loki
    type: loki
    access: proxy
    # Loki binds to WireGuard IP for security (only accepts connections from VPS-1 Promtail)
    # Grafana on same host can still reach it via this IP
    url: http://10.0.0.2:3100
    uid: loki
    editable: false

  - name: Tempo
    type: tempo
    access: proxy
    url: http://127.0.0.1:3200
    editable: false
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: '-1h'
        spanEndTimeShift: '1h'
        tags: ['host', 'job']
        filterByTraceID: true
        filterBySpanID: true
      nodeGraph:
        enabled: true
EOF
```

---

## 5.8 Create Environment File and Start

```bash
#!/bin/bash
GRAFANA_PASSWORD=$(openssl rand -base64 16)

# Get domain from config
# GRAFANA_DOMAIN=observe.example.com

sudo -u openclaw tee /home/openclaw/monitoring/.env << EOF
GRAFANA_PASSWORD=${GRAFANA_PASSWORD}
GRAFANA_DOMAIN=${GRAFANA_DOMAIN:-}
EOF

sudo chmod 600 /home/openclaw/monitoring/.env

cd /home/openclaw/monitoring
sudo -u openclaw docker compose up -d

echo ""
echo "========================================="
echo "Grafana Credentials:"
echo "  User: admin"
echo "  Password: ${GRAFANA_PASSWORD}"
echo "========================================="
```

---

## Verification

```bash
# Check containers
cd /home/openclaw/monitoring
sudo -u openclaw docker compose ps

# Test Prometheus targets (should show all targets as "up")
# Note: Prometheus now bound to WireGuard IP (10.0.0.2)
curl -s http://10.0.0.2:9090/api/v1/targets | jq -r '.data.activeTargets[] | .scrapePool + ": " + .health'

# Test Loki (via WireGuard IP)
curl -s http://10.0.0.2:3100/ready

# Test Grafana
curl -s http://localhost:3000/api/health

# Verify metrics from VPS-1 are reachable
curl -s http://10.0.0.1:9100/metrics | head -5
```

---

## Troubleshooting

### Prometheus Not Scraping VPS-1 Targets

```bash
# Test connectivity via WireGuard
curl http://10.0.0.1:9100/metrics | head -5

# If connection refused: Check UFW on VPS-1
ssh -p 222 adminclaw@<VPS1_IP>
sudo ufw status | grep 9100
# Add rule if missing:
sudo ufw allow from 10.0.0.0/24 to any port 9100
```

### Loki Connection Refused

```bash
# Check Loki is running
sudo docker logs loki

# Check binding
ss -tlnp | grep 3100

# Common issue: HTTP and gRPC on different interfaces
# Solution: Both must bind to 10.0.0.2 in loki-config.yml
```

### Grafana Datasource Connection Refused

```bash
# Check network modes
docker inspect grafana --format '{{.HostConfig.NetworkMode}}'
docker inspect prometheus --format '{{.HostConfig.NetworkMode}}'

# All must be 'host' - mixed networking doesn't work
```

### Logs Not Appearing in Loki

```bash
# Check Promtail on VPS-1
ssh -p 222 adminclaw@<VPS1_IP>
sudo docker logs promtail

# Check Loki on VPS-2
sudo docker logs loki
curl http://10.0.0.2:3100/ready

# Common issue: Schema version mismatch
# Solution: Use schema v13 with tsdb store in loki-config.yml
```

---

## Security Notes

- Most services bind to localhost; Loki, Tempo, and Prometheus bind to WireGuard IP (10.0.0.2)
- Prometheus on WireGuard (10.0.0.2:9090) - receives OTLP metrics from VPS-1 and scrapes VPS-1
- Loki on WireGuard (10.0.0.2:3100) - receives logs from VPS-1 Promtail and OTLP logs from OpenClaw
- Tempo HTTP API on localhost (127.0.0.1:3200), OTLP receiver on WireGuard (10.0.0.2:4318)
- UFW must allow traffic from WireGuard subnet: `sudo ufw allow from 10.0.0.0/24`
- Grafana authentication required (auto-generated password)
- Host network mode used for reliable inter-service communication
- No ports exposed to public internet from this stack
