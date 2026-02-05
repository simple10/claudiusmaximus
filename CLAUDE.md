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

## General Rules

- **Preserve comments in config files.** Comments document intent and aid future maintenance. Never strip comments unless explicitly asked.
- **Update stale comments.** If code changes make a comment inaccurate, fix the comment — don't delete it.
- **Add comments for non-obvious settings.** Explain *why*, not *what*.

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

# Add to sudo and docker groups
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

# IMPORTANT: Ubuntu uses 'ssh' not 'sshd' as service name
sudo systemctl restart ssh
```

### 1.4 UFW Firewall Setup

**On VPS-1 (OpenClaw):**

```bash
#!/bin/bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH
sudo ufw allow 22/tcp

# HTTPS only (port 80 blocked for security - use Cloudflare Origin CA)
sudo ufw allow 443/tcp

# WireGuard
sudo ufw allow 51820/udp

# IMPORTANT: Allow metrics ports from WireGuard network for Prometheus scraping
sudo ufw allow from 10.0.0.0/24 to any port 9100
sudo ufw allow from 10.0.0.0/24 to any port 18789

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

# HTTPS only (port 80 blocked for security - use Cloudflare Origin CA)
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
sudo docker info | grep -i "sysbox"
```

### 4.2 Create Docker Networks

```bash
#!/bin/bash
# IMPORTANT: Use 172.30.x.x subnets to avoid conflicts with Docker's default bridge (172.20.0.0/16)

# Gateway network (for OpenClaw)
docker network create \
    --driver bridge \
    --subnet 172.30.0.0/24 \
    openclaw-gateway-net

# Sandbox network (internal only, for sandboxes)
docker network create \
    --driver bridge \
    --internal \
    --subnet 172.31.0.0/24 \
    openclaw-sandbox-net
```

### 4.3 Create Directory Structure

```bash
#!/bin/bash
# Create directories as openclaw user
sudo -u openclaw bash << 'EOF'
OPENCLAW_HOME="/home/openclaw"

mkdir -p "${OPENCLAW_HOME}/openclaw"
mkdir -p "${OPENCLAW_HOME}/.openclaw/workspace"
mkdir -p "${OPENCLAW_HOME}/.openclaw/credentials"
mkdir -p "${OPENCLAW_HOME}/.openclaw/logs"
mkdir -p "${OPENCLAW_HOME}/.openclaw/backups"
mkdir -p "${OPENCLAW_HOME}/scripts"

chmod 700 "${OPENCLAW_HOME}/.openclaw"
chmod 700 "${OPENCLAW_HOME}/.openclaw/credentials"
EOF

# IMPORTANT: Container runs as uid 1000 (node user), which is typically 'ubuntu' on the host
# Change ownership of .openclaw to uid 1000 for container write access
sudo chown -R 1000:1000 /home/openclaw/.openclaw
```

### 4.4 Clone OpenClaw Repository

```bash
#!/bin/bash
sudo -u openclaw bash << 'EOF'
cd /home/openclaw
git clone https://github.com/openclaw/openclaw.git openclaw
EOF
```

### 4.5 Create Environment File

```bash
#!/bin/bash
# Generate gateway token
GATEWAY_TOKEN=$(openssl rand -hex 32)
GRAFANA_PASSWORD=$(openssl rand -base64 16)

sudo -u openclaw tee /home/openclaw/openclaw/.env << EOF
# Gateway authentication
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}

# Model provider
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

# Channels (add as needed)
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}

# Grafana password for monitoring
GRAFANA_PASSWORD=${GRAFANA_PASSWORD}

# Docker compose variables (required by repo's docker-compose.yml)
OPENCLAW_CONFIG_DIR=/home/openclaw/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/openclaw/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=127.0.0.1:18789
OPENCLAW_BRIDGE_PORT=127.0.0.1:18790
OPENCLAW_GATEWAY_BIND=lan
EOF

sudo chmod 600 /home/openclaw/openclaw/.env
sudo chown openclaw:openclaw /home/openclaw/openclaw/.env
```

### 4.6 Create Docker Compose Override

The OpenClaw repo includes a docker-compose.yml. Create an override file to add build config, security hardening, and monitoring services:

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/openclaw/docker-compose.override.yml << 'EOF'
services:
  openclaw-gateway:
    # Build configuration - required for docker compose build
    build:
      context: .
      dockerfile: Dockerfile
    image: openclaw:local
    container_name: openclaw-gateway
    runtime: sysbox-runc

    # Security hardening: read-only root filesystem with tmpfs for writable dirs
    read_only: true
    tmpfs:
      - /tmp:size=500M,mode=1777
      - /var/tmp:size=200M,mode=1777
      - /run:size=100M,mode=755

    # Run as non-root user (node user in container is uid 1000)
    user: "1000:1000"

    deploy:
      resources:
        limits:
          cpus: "4"
          memory: 8G
        reservations:
          cpus: "1"
          memory: 2G
    security_opt:
      - no-new-privileges:true
    environment:
      - NODE_ENV=production
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - TZ=UTC
    networks:
      - openclaw-gateway-net
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
    # IMPORTANT: Pass --allow-unconfigured to start without full setup
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "lan",
        "--port",
        "18789",
      ]

  openclaw-cli:
    # Build configuration for CLI
    build:
      context: .
      dockerfile: Dockerfile
    image: openclaw:local
    runtime: sysbox-runc
    networks:
      - openclaw-gateway-net

  # Node Exporter - ships metrics to VPS-2 Prometheus
  node-exporter:
    image: prom/node-exporter:latest
    container_name: node-exporter
    restart: unless-stopped
    command:
      - "--path.procfs=/host/proc"
      - "--path.sysfs=/host/sys"
      - "--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    network_mode: host

  promtail:
    image: grafana/promtail:latest
    container_name: promtail
    restart: unless-stopped
    volumes:
      - ./promtail-config.yml:/etc/promtail/config.yml:ro
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
    command: -config.file=/etc/promtail/config.yml
    network_mode: host

networks:
  openclaw-gateway-net:
    external: true
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
# IMPORTANT: Keep this minimal - OpenClaw rejects unknown config keys
sudo tee /home/openclaw/.openclaw/openclaw.json << 'EOF'
{
  "gateway": {
    "bind": "lan",
    "mode": "local"
  }
}
EOF

# Ensure container (uid 1000) can read/write
sudo chown 1000:1000 /home/openclaw/.openclaw/openclaw.json
```

### 4.9 Setup SSL Certificates (Cloudflare Origin CA)

Copy the Cloudflare Origin CA certificate and private key to the server:

```bash
#!/bin/bash
# Create certs directory
sudo mkdir -p /etc/caddy/certs

# Copy certificate and key (from local certs/ directory)
# These should be generated from Cloudflare Dashboard > SSL/TLS > Origin Server
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

# Set secure permissions
sudo chmod 644 /etc/caddy/certs/origin.pem
sudo chmod 600 /etc/caddy/certs/origin.key
```

### 4.10 Setup Caddy Reverse Proxy (SSL-Only)

```bash
#!/bin/bash
sudo mkdir -p /etc/caddy /var/log/caddy

# SSL-only configuration using Cloudflare Origin CA
# Port 80 is blocked at firewall level - no HTTP at all
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
        X-Frame-Options "DENY"
        -Server
    }

    reverse_proxy localhost:18789 {
        header_up Host {host}
        header_up X-Real-IP {remote}
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size 100mb
            roll_keep 5
        }
    }
}
EOF

# Run Caddy with certificate volumes
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

### 4.11 Build and Start OpenClaw

```bash
#!/bin/bash
cd /home/openclaw/openclaw

# Build image
sudo -u openclaw docker build -t openclaw:local .

# Start services
sudo -u openclaw docker compose up -d

# Check status
sudo -u openclaw docker compose ps
sudo docker logs --tail 20 openclaw-openclaw-gateway-1
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
# IMPORTANT: Use host network mode for prometheus, alertmanager, and cadvisor
# to access WireGuard network (10.0.0.x)
sudo -u openclaw tee /home/openclaw/monitoring/docker-compose.yml << 'EOF'
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
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.path=/prometheus"
      - "--storage.tsdb.retention.time=30d"
      - "--web.enable-lifecycle"
    # IMPORTANT: Use host network to reach WireGuard IPs
    network_mode: host

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
      - "10.0.0.2:3100:3100"
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
      - "--config.file=/etc/alertmanager/alertmanager.yml"
      - "--storage.path=/alertmanager"
    # IMPORTANT: Use host network for Prometheus access
    network_mode: host

  node-exporter:
    image: prom/node-exporter:latest
    container_name: node-exporter
    restart: unless-stopped
    command:
      - "--path.procfs=/host/proc"
      - "--path.sysfs=/host/sys"
      - "--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)"
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
    # IMPORTANT: Use host network for Prometheus access
    network_mode: host

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
# IMPORTANT: Since Prometheus runs on host network, use localhost for local services
# and 10.0.0.1 for VPS-1 metrics via WireGuard
sudo -u openclaw tee /home/openclaw/monitoring/prometheus.yml << 'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["localhost:9093"]

rule_files:
  - alerts.yml

scrape_configs:
  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]

  # Local VPS-2 metrics
  - job_name: "node-exporter-local"
    static_configs:
      - targets: ["localhost:9100"]
        labels:
          host: "observe"

  - job_name: "cadvisor-local"
    static_configs:
      - targets: ["localhost:8080"]
        labels:
          host: "observe"

  # Remote VPS-1 metrics (via WireGuard)
  - job_name: "node-exporter-openclaw"
    static_configs:
      - targets: ["10.0.0.1:9100"]
        labels:
          host: "openclaw"

  - job_name: "openclaw-gateway"
    static_configs:
      - targets: ["10.0.0.1:18789"]
        labels:
          host: "openclaw"
    metrics_path: /metrics
    scrape_timeout: 10s
EOF
```

### 5.4 Create Alert Rules

```bash
#!/bin/bash
# IMPORTANT: Use proper YAML - do not escape $ in template variables
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

### 5.6 Create Loki Configuration

```bash
#!/bin/bash
# IMPORTANT: Use schema v13 with tsdb store (required by newer Loki versions)
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
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

ruler:
  alertmanager_url: http://localhost:9093

limits_config:
  retention_period: 720h
EOF
```

### 5.7 Create Grafana Datasource Provisioning

```bash
#!/bin/bash
# IMPORTANT: Use localhost URLs since services run on host network
sudo -u openclaw tee /home/openclaw/monitoring/grafana/provisioning/datasources/datasources.yml << 'EOF'
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://localhost:9090
    isDefault: true
    editable: false

  - name: Loki
    type: loki
    access: proxy
    url: http://localhost:3100
    editable: false
EOF
```

### 5.8 Setup SSL Certificates (Cloudflare Origin CA)

Copy the same Cloudflare Origin CA certificate and private key to VPS-2:

```bash
#!/bin/bash
# Create certs directory
sudo mkdir -p /etc/caddy/certs

# Copy certificate and key (same wildcard cert as VPS-1)
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

# Set secure permissions
sudo chmod 644 /etc/caddy/certs/origin.pem
sudo chmod 600 /etc/caddy/certs/origin.key
```

### 5.9 Setup Caddy for Grafana (SSL-Only)

```bash
#!/bin/bash
sudo mkdir -p /etc/caddy /var/log/caddy

# SSL-only configuration using Cloudflare Origin CA
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
        X-Frame-Options "DENY"
        -Server
    }

    reverse_proxy localhost:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote}
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size 100mb
            roll_keep 5
        }
    }
}
EOF

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

### 5.10 Create Environment File and Start

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
echo "  URL: http://${VPS2_IP:-<VPS2-IP>}"
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
EOF

sudo -u openclaw chmod +x /home/openclaw/scripts/backup.sh
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
sudo -u openclaw docker compose ps

# Check logs
sudo docker logs --tail 20 openclaw-openclaw-gateway-1

# Test internal endpoint
curl -s http://localhost:18789/ | grep -o "<title>.*</title>"

# Test via Caddy (HTTPS only - port 80 blocked)
curl -sk https://localhost:443/ | grep -o "<title>.*</title>"

# Verify port 80 is blocked (should fail/timeout)
curl -s --connect-timeout 3 http://localhost:80/ || echo "Port 80 blocked (expected)"
```

### 7.3 Verify Monitoring (VPS-2)

```bash
# Check containers
sudo -u openclaw docker compose ps

# Test Prometheus targets (should show all targets as "up")
curl -s http://localhost:9090/api/v1/targets | jq -r '.data.activeTargets[] | .scrapePool + ": " + .health'

# Test Loki
curl -s http://localhost:3100/ready

# Test Grafana via Caddy (HTTPS only)
curl -sk https://localhost:443/ | head -5

# Verify port 80 is blocked (should fail/timeout)
curl -s --connect-timeout 3 http://localhost:80/ || echo "Port 80 blocked (expected)"
```

### 7.4 Test End-to-End

1. Configure Cloudflare DNS to point your domain to the VPS IPs (use Cloudflare proxy for SSL termination)
2. In Cloudflare SSL/TLS settings, set encryption mode to "Full (strict)"
3. Access OpenClaw dashboard via `https://<your-domain>`
4. Access Grafana via `https://<grafana-subdomain>` (login: admin / generated password)
5. Verify Prometheus targets in Grafana → Explore → Prometheus
6. Check logs flowing from VPS-1 in Grafana → Explore → Loki

---

## Quick Reference

### SSH Access

```bash
# OpenClaw VPS
ssh -i ~/.ssh/ovh_openclaw_ed25519 ubuntu@<VPS1-IP>

# Observability VPS
ssh -i ~/.ssh/ovh_openclaw_ed25519 ubuntu@<VPS2-IP>
```

### Service Management

```bash
# VPS-1: OpenClaw
cd /home/openclaw/openclaw
sudo -u openclaw docker compose up -d      # Start
sudo -u openclaw docker compose down       # Stop
sudo -u openclaw docker compose logs -f    # Logs
sudo -u openclaw docker compose ps         # Status

# VPS-2: Monitoring
cd /home/openclaw/monitoring
sudo -u openclaw docker compose up -d
sudo -u openclaw docker compose down
sudo -u openclaw docker compose logs -f
sudo -u openclaw docker compose ps
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
- [ ] UFW firewall enabled (port 80 blocked, only 443 open)
- [ ] Fail2ban running
- [ ] Automatic security updates enabled
- [ ] Kernel hardening applied
- [ ] WireGuard tunnel established
- [ ] Cloudflare Origin CA certificate installed
- [ ] Caddy serving HTTPS-only with Origin CA cert

### VPS-1 (OpenClaw)

- [ ] Sysbox runtime installed
- [ ] OpenClaw gateway running with Sysbox
- [ ] Gateway bound to localhost (Caddy handles external)
- [ ] Caddy reverse proxy with TLS (port 443 only)
- [ ] Node Exporter shipping metrics (port 9100 open to WireGuard)
- [ ] Promtail shipping logs
- [ ] Backup cron job scheduled

### VPS-2 (Observability)

- [ ] Prometheus scraping both VPSs (all targets UP)
- [ ] Grafana accessible with strong password
- [ ] Loki receiving logs
- [ ] Alertmanager configured
- [ ] Caddy reverse proxy with TLS (port 443 only)

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

# Check logs for config errors
sudo docker logs openclaw-openclaw-gateway-1

# Common issue: Invalid config keys in openclaw.json
# Solution: Keep config minimal, only use documented keys

# Check resources
docker system df
free -h
df -h
```

### Prometheus Not Scraping VPS-1 Targets

```bash
# Test connectivity via WireGuard
curl http://10.0.0.1:9100/metrics | head -5

# If connection refused: Check UFW on VPS-1
sudo ufw status | grep 9100
# Add rule if missing:
sudo ufw allow from 10.0.0.0/24 to any port 9100
```

### Logs Not Appearing in Loki

```bash
# Check Promtail on VPS-1
sudo docker logs promtail

# Check Loki on VPS-2
sudo docker logs loki
curl http://localhost:3100/ready

# Common issue: Schema version mismatch
# Solution: Use schema v13 with tsdb store in loki-config.yml
```

### SSH Service Name on Ubuntu

```bash
# Ubuntu uses 'ssh' not 'sshd'
sudo systemctl restart ssh    # Correct
sudo systemctl restart sshd   # Wrong - will fail
```

---

## Key Deployment Notes

1. **SSH service**: Ubuntu uses `ssh` not `sshd` as the service name
2. **Docker networks**: Use 172.30.x.x subnets to avoid conflicts with Docker's default 172.20.0.0/16
3. **File ownership**: Container runs as uid 1000 (node), so `.openclaw` directory must be owned by uid 1000
4. **OpenClaw config**: Keep `openclaw.json` minimal - it rejects unknown keys
5. **Gateway startup**: Use `--allow-unconfigured` flag to start without full setup
6. **UFW on VPS-1**: Must allow ports 9100 and 18789 from WireGuard network (10.0.0.0/24)
7. **Prometheus networking**: Use host network mode to access WireGuard IPs
8. **Loki schema**: Use v13 with tsdb store (required by newer Loki versions)
9. **SSL-only configuration**:
   - Port 80 is blocked at firewall level (UFW)
   - Use Cloudflare Origin CA certificates for TLS
   - Set Cloudflare SSL mode to "Full (strict)"
   - Origin CA certs don't support OCSP stapling (warning in Caddy logs is expected)
   - Same wildcard cert can be used on both VPSs
10. **Container security hardening**:
    - `build:` section required in override for `docker compose build` to work
    - `read_only: true` makes root filesystem read-only (security hardening)
    - `tmpfs` mounts provide writable `/tmp`, `/var/tmp`, `/run` directories
    - `user: "1000:1000"` runs container as non-root (node user)
    - Gateway writes logs to `/tmp/openclaw/` which is on tmpfs mount
