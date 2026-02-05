# 02 - WireGuard Tunnel Setup

Establishes a secure WireGuard tunnel between VPS-1 and VPS-2 for internal communication.

## Overview

This playbook configures:
- WireGuard key generation on both VPSs
- Tunnel configuration (10.0.0.1 <-> 10.0.0.2)
- Systemd service for automatic startup

## Prerequisites

- [01-base-setup.md](01-base-setup.md) completed on both VPSs
- SSH access as `adminclaw` on port 222
- UFW port 51820/udp allowed (done in base setup)

## Variables

From `../openclaw-config.env`:
- `VPS1_IP` - Public IP of VPS-1 (OpenClaw)
- `VPS2_IP` - Public IP of VPS-2 (Observability)

WireGuard IPs (fixed):
- VPS-1: `10.0.0.1/24`
- VPS-2: `10.0.0.2/24`

---

## 2.1 Generate Keys

### On VPS-1 (OpenClaw)

```bash
#!/bin/bash
wg genkey | sudo tee /etc/wireguard/private.key
sudo chmod 600 /etc/wireguard/private.key
sudo cat /etc/wireguard/private.key | wg pubkey | sudo tee /etc/wireguard/public.key

# Display keys (save these)
echo "VPS-1 Private Key: $(sudo cat /etc/wireguard/private.key)"
echo "VPS-1 Public Key: $(sudo cat /etc/wireguard/public.key)"
```

### On VPS-2 (Observability)

```bash
#!/bin/bash
wg genkey | sudo tee /etc/wireguard/private.key
sudo chmod 600 /etc/wireguard/private.key
sudo cat /etc/wireguard/private.key | wg pubkey | sudo tee /etc/wireguard/public.key

# Display keys (save these)
echo "VPS-2 Private Key: $(sudo cat /etc/wireguard/private.key)"
echo "VPS-2 Public Key: $(sudo cat /etc/wireguard/public.key)"
```

**Important:** Save both public keys - you'll need each VPS's public key to configure the other VPS.

---

## 2.2 Configure WireGuard

### On VPS-1 (OpenClaw)

Create `/etc/wireguard/wg0.conf`:

```bash
#!/bin/bash
# Replace placeholders with actual values
VPS1_PRIVATE_KEY="<output from 2.1 on VPS-1>"
VPS2_PUBLIC_KEY="<output from 2.1 on VPS-2>"
VPS2_PUBLIC_IP="<VPS2_IP from config>"

sudo tee /etc/wireguard/wg0.conf << EOF
[Interface]
Address = 10.0.0.1/24
PrivateKey = ${VPS1_PRIVATE_KEY}
ListenPort = 51820

[Peer]
# VPS-2 (Observability)
PublicKey = ${VPS2_PUBLIC_KEY}
AllowedIPs = 10.0.0.2/32
Endpoint = ${VPS2_PUBLIC_IP}:51820
PersistentKeepalive = 25
EOF
```

### On VPS-2 (Observability)

Create `/etc/wireguard/wg0.conf`:

```bash
#!/bin/bash
# Replace placeholders with actual values
VPS2_PRIVATE_KEY="<output from 2.1 on VPS-2>"
VPS1_PUBLIC_KEY="<output from 2.1 on VPS-1>"
VPS1_PUBLIC_IP="<VPS1_IP from config>"

sudo tee /etc/wireguard/wg0.conf << EOF
[Interface]
Address = 10.0.0.2/24
PrivateKey = ${VPS2_PRIVATE_KEY}
ListenPort = 51820

[Peer]
# VPS-1 (OpenClaw)
PublicKey = ${VPS1_PUBLIC_KEY}
AllowedIPs = 10.0.0.1/32
Endpoint = ${VPS1_PUBLIC_IP}:51820
PersistentKeepalive = 25
EOF
```

---

## 2.3 Enable WireGuard

Run on: **Both VPSs**

```bash
#!/bin/bash
# Secure the config file
sudo chmod 600 /etc/wireguard/wg0.conf

# Enable and start WireGuard
sudo systemctl enable wg-quick@wg0
sudo systemctl start wg-quick@wg0

# Verify interface is up
sudo wg show
```

---

## Verification

### Test Connectivity

From VPS-1:
```bash
ping -c 3 10.0.0.2
```

From VPS-2:
```bash
ping -c 3 10.0.0.1
```

### Check WireGuard Status

```bash
sudo wg show
```

Expected output (example):
```
interface: wg0
  public key: <your-public-key>
  private key: (hidden)
  listening port: 51820

peer: <peer-public-key>
  endpoint: X.X.X.X:51820
  allowed ips: 10.0.0.X/32
  latest handshake: X seconds ago
  transfer: X KiB received, X KiB sent
```

The "latest handshake" confirms the tunnel is active.

---

## Troubleshooting

### No Handshake / Tunnel Not Connecting

```bash
# Check interface exists
ip a show wg0

# Check firewall
sudo ufw status | grep 51820

# Check service status
sudo systemctl status wg-quick@wg0
sudo journalctl -u wg-quick@wg0

# Verify config syntax
sudo wg-quick strip wg0
```

### Handshake But No Ping

```bash
# Check routing
ip route | grep 10.0.0

# Check if peer IP is correct
sudo wg show wg0

# Try traceroute
traceroute 10.0.0.X
```

### Key Mismatch Error

```bash
# Regenerate keys if needed
sudo wg genkey | sudo tee /etc/wireguard/private.key
sudo cat /etc/wireguard/private.key | wg pubkey | sudo tee /etc/wireguard/public.key

# Update config and restart
sudo systemctl restart wg-quick@wg0
```

### Restart WireGuard

```bash
sudo systemctl restart wg-quick@wg0
```

---

## Security Notes

- WireGuard keys are stored in `/etc/wireguard/` with 600 permissions
- Only root can read the private key
- The tunnel encrypts all traffic between VPSs
- PersistentKeepalive (25s) keeps NAT mappings alive
