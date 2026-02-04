# CLAUDE.md — OpenClaw Two-VPS Deployment

## Overview

This document guides the automated deployment of OpenClaw across two OVHCloud VPS-2 instances:

| VPS | Role | WireGuard IP | Services |
|-----|------|--------------|----------|
| **VPS-1** | OpenClaw | `10.0.0.1` | Gateway, Sysbox, Caddy, Node Exporter, Promtail |
| **VPS-2** | Observability | `10.0.0.2` | Prometheus, Grafana, Loki, Alertmanager, cAdvisor |

## Prerequisites

Read configuration from `~/openclaw-config.env`:

- `VPS1_IP`, `VPS2_IP` — Public IPs
- `SSH_KEY_PATH`, `SSH_USER` — SSH access
- `ANTHROPIC_API_KEY` — Required for OpenClaw
- Optional: `DOMAIN`, `TELEGRAM_BOT_TOKEN`, etc.

---

## Phase 1: Base Setup (Both VPSs)

Run these steps on **both VPS-1 and VPS-2**.

### 1.1 System Update & Essential Packages

```bash
#!/bin/bash
set -euo pipefail

# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y \
    curl wget git vim htop tmux unzip \
    ca-certificates gnupg lsb-release \
    apt-transport-https software-properties-common \
    ufw fail2ban auditd \
    wireguard wireguard-tools
```

### 1.2 Create Dedicated User

```bash
#!/bin/bash
OPENCLAW_USER="openclaw"

# Create user
sudo useradd -m -s /bin/bash "$OPENCLAW_USER"

# Generate random password (user won't need it, SSH key auth only)
echo "${OPENCLAW_USER}:$(openssl rand -base64 32)" | sudo chpasswd

# Add to sudo group
sudo usermod -aG sudo "$OPENCLAW_USER"

# Copy SSH authorized_keys
sudo mkdir -p /home/${OPENCLAW_USER}/.ssh
sudo cp ~/.ssh/authorized_keys /home/${OPENCLAW_USER}/.ssh/
sudo chown -R ${OPENCLAW_USER}:${OPENCLAW_USER} /home/${OPENCLAW_USER}/.ssh
sudo chmod 700 /home/${OPENCLAW_USER}/.ssh
sudo chmod 600 /home/${OPENCLAW_USER}/.ssh/authorized_keys
```

### 1.3 SSH Hardening

```bash
#!/bin/bash
# Backup original config
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup

# Create hardened config
sudo tee /etc/ssh/sshd_config.d/hardening.conf << 'EOF'
# Disable root login
PermitRootLogin no

# Disable password authentication
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM yes

# Only allow specific user
AllowUsers openclaw ubuntu

# Connection settings
MaxAuthTries 3
MaxSessions 3
LoginGraceTime 30

# Disable unused features
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no

# Use strong algorithms only
KexAlgorithms curve25519-sha256@libssh.org,diffie-hellman-group16-sha512
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
EOF

# Restart SSH
sudo systemctl restart sshd
```

### 1.4 UFW Firewall Setup

**On VPS-1 (OpenClaw):**

```bash
#!/bin/bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH
sudo ufw allow 22/tcp

# HTTP/HTTPS (for Caddy)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# WireGuard
sudo ufw allow 51820/udp

# Enable
sudo ufw --force enable
```

**On VPS-2 (Observability):**

```bash
#!/bin/bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH
sudo ufw allow 22/tcp

# HTTP/HTTPS (for Grafana via Caddy)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# WireGuard
sudo ufw allow 51820/udp

# Enable
sudo ufw --force enable
```

### 1.5 Fail2ban Configuration

```bash
#!/bin/bash
sudo tee /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
backend = systemd

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 24h
EOF

sudo systemctl enable fail2ban
sudo systemctl restart fail2ban
```

### 1.6 Automatic Security Updates

```bash
#!/bin/bash
sudo apt install -y unattended-upgrades

sudo tee /etc/apt/apt.conf.d/50unattended-upgrades << 'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

sudo systemctl enable unattended-upgrades
```

### 1.7 Kernel Hardening

```bash
#!/bin/bash
sudo tee /etc/sysctl.d/99-security.conf << 'EOF'
# IP Spoofing protection
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP broadcast requests
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Disable source packet routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0

# Ignore send redirects
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# Block SYN attacks
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2

# Log Martians
net.ipv4.conf.all.log_martians = 1

# Ignore ICMP redirects
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0

# Enable ASLR
kernel.randomize_va_space = 2

# Restrict dmesg access
kernel.dmesg_restrict = 1

# Restrict kernel pointer access
kernel.kptr_restrict = 2
EOF

sudo sysctl -p /etc/sysctl.d/99-security.conf
```

---

## Phase 2: WireGuard Tunnel Setup

### 2.1 Generate Keys (Both VPSs)

**On VPS-1:**

```bash
#!/bin/bash
wg genkey | sudo tee /etc/wireguard/private.key
sudo chmod 600 /etc/wireguard/private.key
sudo cat /etc/wireguard/private.key | wg pubkey | sudo tee /etc/wireguard/public.key

# Display keys (save these)
echo "VPS-1 Private Key: $(sudo cat /etc/wireguard/private.key)"
echo "VPS-1 Public Key: $(sudo cat /etc/wireguard/public.key)"
```

**On VPS-2:**

```bash
#!/bin/bash
wg genkey | sudo tee /etc/wireguard/private.key
sudo chmod 600 /etc/wireguard/private.key
sudo cat /etc/wireguard/private.key | wg pubkey | sudo tee /etc/wireguard/public.key

# Display keys (save these)
echo "VPS-2 Private Key: $(sudo cat /etc/wireguard/private.key)"
echo "VPS-2 Public Key: $(sudo cat /etc/wireguard/public.key)"
```

### 2.2 Configure WireGuard

**On VPS-1 (OpenClaw) — `/etc/wireguard/wg0.conf`:**

```ini
[Interface]
Address = 10.0.0.1/24
PrivateKey = <VPS1_PRIVATE_KEY>
ListenPort = 51820

[Peer]
# VPS-2 (Observability)
PublicKey = <VPS2_PUBLIC_KEY>
AllowedIPs = 10.0.0.2/32
Endpoint = <VPS2_PUBLIC_IP>:51820
PersistentKeepalive = 25
```

**On VPS-2 (Observability) — `/etc/wireguard/wg0.conf`:**

```ini
[Interface]
Address = 10.0.0.2/24
PrivateKey = <VPS2_PRIVATE_KEY>
ListenPort = 51820

[Peer]
# VPS-1 (OpenClaw)
PublicKey = <VPS1_PUBLIC_KEY>
AllowedIPs = 10.0.0.1/32
Endpoint = <VPS1_PUBLIC_IP>:51820
PersistentKeepalive = 25
```

### 2.3 Enable WireGuard (Both VPSs)

```bash
#!/bin/bash
sudo chmod 600 /etc/wireguard/wg0.conf
sudo systemctl enable wg-quick@wg0
sudo systemctl start wg-quick@wg0

# Verify connection
sudo wg show
ping -c 3 10.0.0.1  # From VPS-2
ping -c 3 10.0.0.2  # From VPS-1
```

---

## Phase 3: Docker Installation (Both VPSs)

### 3.1 Install Docker

```bash
#!/bin/bash
# Add Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add openclaw user to docker group
sudo usermod -aG docker openclaw

# Start and enable Docker
sudo systemctl enable docker
sudo systemctl start docker
```

### 3.2 Docker Daemon Hardening

```bash
#!/bin/bash
sudo mkdir -p /etc/docker

sudo tee /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  },
  "storage-driver": "overlay2",
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 65536,
      "Soft": 65536
    }
  }
}
EOF

sudo systemctl restart docker
```

---

## Phase 4: VPS-1 OpenClaw Setup

All remaining Phase 4 steps run only on **VPS-1**.

### 4.1 Install Sysbox Runtime

```bash
#!/bin/bash
# Download Sysbox (check for latest version)
wget https://downloads.nestybox.com/sysbox/releases/v0.6.4/sysbox-ce_0.6.4-0.linux_amd64.deb

# Install dependencies
sudo apt install -y jq fuse

# Install Sysbox
sudo dpkg -i sysbox-ce_0.6.4-0.linux_amd64.deb

# Verify installation
sudo systemctl status sysbox

# Verify runtime is available
docker info | grep -i runtime
```

### 4.2 Create Docker Networks

```bash
#!/bin/bash
# Gateway network (for OpenClaw)
docker network create \
    --driver bridge \
    --subnet 172.20.0.0/24 \
    openclaw-gateway-net

# Sandbox network (internal only, for sandboxes)
docker network create \
    --driver bridge \
    --internal \
    --subnet 172.21.0.0/24 \
    openclaw-sandbox-net
```

### 4.3 Create Directory Structure

```bash
#!/bin/bash
sudo -u openclaw bash << 'EOF'
OPENCLAW_HOME="/home/openclaw"

mkdir -p "${OPENCLAW_HOME}/openclaw"
mkdir -p "${OPENCLAW_HOME}/.openclaw"
mkdir -p "${OPENCLAW_HOME}/.openclaw/workspace"
mkdir -p "${OPENCLAW_HOME}/.openclaw/credentials"
mkdir -p "${OPENCLAW_HOME}/.openclaw/logs"
mkdir -p "${OPENCLAW_HOME}/.openclaw/backups"
mkdir -p "${OPENCLAW_HOME}/scripts"

chmod 700 "${OPENCLAW_HOME}/.openclaw"
chmod 700 "${OPENCLAW_HOME}/.openclaw/credentials"
EOF
```

### 4.4 Clone OpenClaw Repository

```bash
#!/bin/bash
sudo -u openclaw bash << 'EOF'
cd /home/openclaw/openclaw
git clone https://github.com/openclaw/openclaw.git .
EOF
```

### 4.5 Create Environment File

```bash
#!/bin/bash
# Generate gateway token
GATEWAY_TOKEN=$(openssl rand -hex 32)

sudo -u openclaw tee /home/openclaw/openclaw/.env << EOF
# Gateway authentication
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}

# Model provider
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

# Channels (add as needed)
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}

# Grafana password for monitoring
GRAFANA_PASSWORD=$(openssl rand -base64 16)
EOF

sudo chmod 600 /home/openclaw/openclaw/.env
sudo chown openclaw:openclaw /home/openclaw/openclaw/.env
```

### 4.6 Create Docker Compose for OpenClaw

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/openclaw/docker-compose.yml << 'EOF'
version: '3.8'

services:
  openclaw-gateway:
    build:
      context: .
      dockerfile: Dockerfile
    image: openclaw:local
    container_name: openclaw-gateway
    runtime: sysbox-runc
    restart: unless-stopped

    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 8G
        reservations:
          cpus: '1'
          memory: 2G

    security_opt:
      - no-new-privileges:true

    read_only: true
    tmpfs:
      - /tmp:size=500M,mode=1777
      - /var/tmp:size=200M,mode=1777
      - /run:size=100M,mode=755

    user: "1000:1000"

    environment:
      - NODE_ENV=production
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - OPENCLAW_BIND=0.0.0.0
      - TZ=UTC

    volumes:
      - /home/openclaw/.openclaw:/home/node/.openclaw:rw
      - /home/openclaw/.openclaw/workspace:/home/node/workspace:rw
      - openclaw_node_modules:/app/node_modules:rw

    networks:
      - openclaw-gateway-net

    ports:
      - "127.0.0.1:18789:18789"

    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18789/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"

  # CLI for management
  openclaw-cli:
    image: openclaw:local
    container_name: openclaw-cli
    runtime: sysbox-runc
    profiles:
      - cli
    user: "1000:1000"
    volumes:
      - /home/openclaw/.openclaw:/home/node/.openclaw:rw
      - /home/openclaw/.openclaw/workspace:/home/node/workspace:rw
    networks:
      - openclaw-gateway-net
    stdin_open: true
    tty: true
    entrypoint: ["node", "dist/index.js"]

  # Node Exporter (metrics to VPS-2)
  node-exporter:
    image: prom/node-exporter:latest
    container_name: node-exporter
    restart: unless-stopped
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    network_mode: host

  # Promtail (ships logs to VPS-2)
  promtail:
    image: grafana/promtail:latest
    container_name: promtail
    restart: unless-stopped
    volumes:
      - /home/openclaw/openclaw/promtail-config.yml:/etc/promtail/config.yml:ro
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
    command: -config.file=/etc/promtail/config.yml
    network_mode: host

networks:
  openclaw-gateway-net:
    external: true

volumes:
  openclaw_node_modules:
EOF
```

### 4.7 Create Promtail Config (Ships logs to VPS-2)

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/openclaw/promtail-config.yml << 'EOF'
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://10.0.0.2:3100/loki/api/v1/push

scrape_configs:
  - job_name: system
    static_configs:
      - targets:
          - localhost
        labels:
          job: varlogs
          host: openclaw
          __path__: /var/log/*log

  - job_name: docker
    static_configs:
      - targets:
          - localhost
        labels:
          job: docker
          host: openclaw
          __path__: /var/lib/docker/containers/*/*-json.log
EOF
```

### 4.8 Create OpenClaw Configuration

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/.openclaw/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "readOnlyRoot": true,
          "network": "none",
          "user": "1000:1000",
          "capDrop": ["ALL"],
          "memory": "1g",
          "cpus": 1,
          "pidsLimit": 100
        }
      },
      "tools": {
        "allowlist": ["exec", "read", "write", "edit", "glob", "grep"],
        "denylist": ["elevated"]
      }
    }
  },
  "channels": {
    "dm": {
      "policy": "pairing"
    }
  },
  "gateway": {
    "bind": "loopback"
  }
}
EOF
```

### 4.9 Setup Caddy Reverse Proxy

```bash
#!/bin/bash
sudo mkdir -p /etc/caddy

# Determine Caddyfile based on whether domain is configured
if [ -n "${DOMAIN:-}" ]; then
    sudo tee /etc/caddy/Caddyfile << EOF
{
    email ${LETSENCRYPT_EMAIL}
}

${DOMAIN} {
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        -Server
    }

    reverse_proxy localhost:18789 {
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size 100mb
            roll_keep 5
        }
    }
}
EOF
else
    # No domain — serve on IP with self-signed cert
    sudo tee /etc/caddy/Caddyfile << 'EOF'
:443 {
    tls internal

    reverse_proxy localhost:18789 {
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
    }
}

:80 {
    redir https://{host}{uri} permanent
}
EOF
fi

# Run Caddy
docker run -d \
    --name caddy \
    --restart unless-stopped \
    --network host \
    -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
    -v caddy_data:/data \
    -v caddy_config:/config \
    -v /var/log/caddy:/var/log/caddy \
    caddy:2-alpine
```

### 4.10 Build and Start OpenClaw

```bash
#!/bin/bash
cd /home/openclaw/openclaw

# Build image
sudo -u openclaw docker compose build

# Start services
sudo -u openclaw docker compose up -d

# Check status
docker compose ps
docker compose logs -f openclaw-gateway
```

---

## Phase 5: VPS-2 Observability Setup

All Phase 5 steps run only on **VPS-2**.

### 5.1 Create Directory Structure

```bash
#!/bin/bash
sudo -u openclaw bash << 'EOF'
mkdir -p /home/openclaw/monitoring
mkdir -p /home/openclaw/monitoring/grafana/provisioning/datasources
mkdir -p /home/openclaw/monitoring/grafana/provisioning/dashboards
EOF
```

### 5.2 Create Docker Compose for Monitoring

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/monitoring/docker-compose.yml << 'EOF'
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    restart: unless-stopped
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./alerts.yml:/etc/prometheus/alerts.yml:ro
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=30d'
      - '--web.enable-lifecycle'
    ports:
      - "127.0.0.1:9090:9090"
    networks:
      - monitoring-net

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    restart: unless-stopped
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD}
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_SERVER_ROOT_URL=https://${GRAFANA_DOMAIN:-localhost}
    ports:
      - "127.0.0.1:3000:3000"
    networks:
      - monitoring-net

  loki:
    image: grafana/loki:latest
    container_name: loki
    restart: unless-stopped
    volumes:
      - ./loki-config.yml:/etc/loki/local-config.yaml:ro
      - loki_data:/loki
    command: -config.file=/etc/loki/local-config.yaml
    ports:
      - "10.0.0.2:3100:3100"  # Only on WireGuard interface
    networks:
      - monitoring-net

  alertmanager:
    image: prom/alertmanager:latest
    container_name: alertmanager
    restart: unless-stopped
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - alertmanager_data:/alertmanager
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
      - '--storage.path=/alertmanager'
    ports:
      - "127.0.0.1:9093:9093"
    networks:
      - monitoring-net

  node-exporter:
    image: prom/node-exporter:latest
    container_name: node-exporter
    restart: unless-stopped
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    network_mode: host

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    container_name: cadvisor
    restart: unless-stopped
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    ports:
      - "127.0.0.1:8080:8080"
    networks:
      - monitoring-net

networks:
  monitoring-net:
    driver: bridge

volumes:
  prometheus_data:
  grafana_data:
  loki_data:
  alertmanager_data:
EOF
```

### 5.3 Create Prometheus Configuration

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/monitoring/prometheus.yml << 'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

rule_files:
  - alerts.yml

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  # Local VPS-2 metrics
  - job_name: 'node-exporter-local'
    static_configs:
      - targets: ['localhost:9100']
        labels:
          host: 'observe'

  - job_name: 'cadvisor-local'
    static_configs:
      - targets: ['cadvisor:8080']
        labels:
          host: 'observe'

  # Remote VPS-1 metrics (via WireGuard)
  - job_name: 'node-exporter-openclaw'
    static_configs:
      - targets: ['10.0.0.1:9100']
        labels:
          host: 'openclaw'

  - job_name: 'openclaw-gateway'
    static_configs:
      - targets: ['10.0.0.1:18789']
        labels:
          host: 'openclaw'
    metrics_path: /metrics
    scrape_timeout: 10s
EOF
```

### 5.4 Create Alert Rules

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/monitoring/alerts.yml << 'EOF'
groups:
  - name: openclaw
    rules:
      - alert: OpenClawGatewayDown
        expr: up{job="openclaw-gateway"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "OpenClaw Gateway is down"
          description: "The OpenClaw gateway has been unreachable for more than 1 minute."

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

### 5.5 Create Alertmanager Configuration

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/monitoring/alertmanager.yml << 'EOF'
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'host']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 1h
  receiver: 'default'

receivers:
  - name: 'default'
    # Configure webhooks, email, Slack, etc. as needed
    # webhook_configs:
    #   - url: 'http://localhost:5001/'
EOF
```

### 5.6 Create Loki Configuration

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/monitoring/loki-config.yml << 'EOF'
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2020-10-24
      store: boltdb-shipper
      object_store: filesystem
      schema: v11
      index:
        prefix: index_
        period: 24h

ruler:
  alertmanager_url: http://alertmanager:9093

limits_config:
  retention_period: 720h  # 30 days
EOF
```

### 5.7 Create Grafana Datasource Provisioning

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/monitoring/grafana/provisioning/datasources/datasources.yml << 'EOF'
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false

  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    editable: false
EOF
```

### 5.8 Setup Caddy for Grafana

```bash
#!/bin/bash
sudo mkdir -p /etc/caddy

if [ -n "${GRAFANA_DOMAIN:-}" ]; then
    sudo tee /etc/caddy/Caddyfile << EOF
{
    email ${LETSENCRYPT_EMAIL}
}

${GRAFANA_DOMAIN} {
    reverse_proxy localhost:3000
}
EOF
else
    sudo tee /etc/caddy/Caddyfile << 'EOF'
:443 {
    tls internal
    reverse_proxy localhost:3000
}

:80 {
    redir https://{host}{uri} permanent
}
EOF
fi

docker run -d \
    --name caddy \
    --restart unless-stopped \
    --network host \
    -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
    -v caddy_data:/data \
    -v caddy_config:/config \
    caddy:2-alpine
```

### 5.9 Create Environment File and Start

```bash
#!/bin/bash
GRAFANA_PASSWORD=$(openssl rand -base64 16)

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
echo "  URL: https://${GRAFANA_DOMAIN:-<VPS2-IP>}"
echo "  User: admin"
echo "  Password: ${GRAFANA_PASSWORD}"
echo "========================================="
```

---

## Phase 6: Backup Setup (VPS-1)

### 6.1 Create Backup Script

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/scripts/backup.sh << 'EOF'
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/home/openclaw/.openclaw/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/openclaw_backup_${TIMESTAMP}.tar.gz"
RETENTION_DAYS=30

# Create backup
tar -czf "${BACKUP_FILE}" \
    -C /home/openclaw \
    .openclaw/openclaw.json \
    .openclaw/credentials \
    .openclaw/workspace \
    openclaw/.env \
    2>/dev/null || true

# Verify
if tar -tzf "${BACKUP_FILE}" > /dev/null 2>&1; then
    echo "$(date): Backup created: ${BACKUP_FILE}"
else
    echo "$(date): Backup failed!"
    exit 1
fi

# Cleanup old backups
find "${BACKUP_DIR}" -name "openclaw_backup_*.tar.gz" -mtime +${RETENTION_DAYS} -delete

# Optional: Copy to VPS-2 via WireGuard
# scp "${BACKUP_FILE}" openclaw@10.0.0.2:/home/openclaw/backups/
EOF

chmod +x /home/openclaw/scripts/backup.sh
```

### 6.2 Schedule Cron Job

```bash
#!/bin/bash
sudo -u openclaw bash -c '(crontab -l 2>/dev/null; echo "0 3 * * * /home/openclaw/scripts/backup.sh >> /home/openclaw/.openclaw/logs/backup.log 2>&1") | crontab -'
```

---

## Phase 7: Verification & Testing

### 7.1 Verify WireGuard Tunnel

```bash
# On VPS-1
ping -c 3 10.0.0.2

# On VPS-2
ping -c 3 10.0.0.1
```

### 7.2 Verify OpenClaw (VPS-1)

```bash
# Check containers
docker compose ps

# Check logs
docker compose logs openclaw-gateway

# Test health endpoint
curl -s http://localhost:18789/health

# Get dashboard URL
docker compose --profile cli run --rm openclaw-cli dashboard --no-open
```

### 7.3 Verify Monitoring (VPS-2)

```bash
# Check containers
docker compose ps

# Test Prometheus targets
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[].health'

# Test Loki
curl -s http://localhost:3100/ready

# Access Grafana
echo "Grafana: https://<VPS2-IP> or https://${GRAFANA_DOMAIN}"
```

### 7.4 Test End-to-End

1. Access OpenClaw dashboard via `https://<VPS1-IP>` or `https://<DOMAIN>`
2. Pair a messaging channel (e.g., Telegram)
3. Send a test message to your OpenClaw bot
4. Check Grafana for metrics and logs flowing from VPS-1

---

## Quick Reference

### SSH Access

```bash
# OpenClaw VPS
ssh -i ~/.ssh/openclaw_ed25519 openclaw@<VPS1-IP>

# Observability VPS
ssh -i ~/.ssh/openclaw_ed25519 openclaw@<VPS2-IP>
```

### Service Management

```bash
# VPS-1: OpenClaw
cd /home/openclaw/openclaw
docker compose up -d      # Start
docker compose down       # Stop
docker compose logs -f    # Logs
docker compose ps         # Status

# VPS-2: Monitoring
cd /home/openclaw/monitoring
docker compose up -d
docker compose down
docker compose logs -f
docker compose ps
```

### WireGuard

```bash
sudo wg show              # Status
sudo systemctl restart wg-quick@wg0  # Restart
```

### Firewall

```bash
sudo ufw status           # View rules
sudo ufw allow <port>     # Add rule
sudo ufw reload           # Reload
```

---

## Security Checklist

### Both VPSs

- [ ] SSH hardened (key-only, no root)
- [ ] UFW firewall enabled
- [ ] Fail2ban running
- [ ] Automatic security updates enabled
- [ ] Kernel hardening applied
- [ ] WireGuard tunnel established

### VPS-1 (OpenClaw)

- [ ] Sysbox runtime installed
- [ ] OpenClaw gateway running with Sysbox
- [ ] Gateway bound to localhost only
- [ ] Caddy reverse proxy with TLS
- [ ] Node Exporter shipping metrics
- [ ] Promtail shipping logs
- [ ] Backup cron job scheduled

### VPS-2 (Observability)

- [ ] Prometheus scraping both VPSs
- [ ] Grafana accessible with strong password
- [ ] Loki receiving logs
- [ ] Alertmanager configured
- [ ] Caddy reverse proxy with TLS

---

## Troubleshooting

### WireGuard Not Connecting

```bash
# Check interface
sudo wg show

# Check firewall
sudo ufw status | grep 51820

# Check service
sudo systemctl status wg-quick@wg0
sudo journalctl -u wg-quick@wg0
```

### OpenClaw Container Won't Start

```bash
# Check Sysbox
sudo systemctl status sysbox

# Check logs
docker compose logs openclaw-gateway

# Check resources
docker system df
free -h
df -h
```

### Prometheus Not Scraping

```bash
# Check targets
curl http://localhost:9090/api/v1/targets

# Test connectivity to VPS-1
curl http://10.0.0.1:9100/metrics
```

### Logs Not Appearing in Loki

```bash
# Check Promtail on VPS-1
docker compose logs promtail

# Check Loki on VPS-2
docker compose logs loki
curl http://localhost:3100/ready
```
