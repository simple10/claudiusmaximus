# NOTE: this is a generic version of [](./http-forward-proxy-for-openclaw.md)

# Transparent Proxy Sidecar — Claude Code Plan

## Goal

Build a Docker Compose setup where an **app container's outbound traffic is transparently intercepted** by a sidecar proxy container. The sidecar inspects HTTP/HTTPS traffic for compliance, logs requests, and forwards them to the internet. The app container has zero knowledge it's being proxied.

## Architecture

- **Shared network namespace** (`network_mode: "service:sidecar"`) — app and sidecar share the same network stack
- **iptables in the sidecar** redirect all outbound TCP (ports 80/443) to the proxy process, except the proxy's own traffic (UID-based exemption to prevent loops)
- **mitmproxy** in transparent mode handles interception, with a custom addon script for compliance logic
- **Custom CA cert** mounted into the app container for HTTPS inspection
- The app container has **no direct internet route** that bypasses the proxy

## Project Structure

```
transparent-proxy-sidecar/
├── docker-compose.yml
├── sidecar/
│   ├── Dockerfile
│   ├── entrypoint.sh          # iptables setup + proxy launch
│   ├── compliance-addon.py    # mitmproxy addon for inspection/logging
│   └── generate-certs.sh      # One-time CA cert generation
├── app/
│   ├── Dockerfile
│   └── src/
│       └── index.ts           # Simple test app that makes outbound requests
├── certs/                     # Generated CA certs (gitignored)
│   ├── ca-cert.pem
│   └── ca-key.pem
├── logs/                      # Proxy logs volume mount
└── README.md
```

## Implementation Steps

### Step 1: Project Scaffolding

Create the directory structure above. Initialize a basic `README.md` explaining the project purpose and how to run it.

Add a `.gitignore` that excludes `certs/` and `logs/`.

### Step 2: Certificate Generation Script

Create `sidecar/generate-certs.sh`:

- Uses `openssl` to generate a self-signed CA certificate and key
- Outputs to `certs/ca-cert.pem` and `certs/ca-key.pem`
- Only generates if certs don't already exist
- Make it executable

### Step 3: Sidecar Container

**`sidecar/Dockerfile`:**

- Base image: `mitmproxy/mitmproxy:latest` (already includes mitmproxy)
- Install `iptables` package
- Create a dedicated `proxyuser` with a known UID (e.g., 1500)
- Copy in `entrypoint.sh` and `compliance-addon.py`
- Set entrypoint to `entrypoint.sh`

**`sidecar/entrypoint.sh`:**

- Define `PROXY_PORT=8080` and `PROXY_UID=1500`
- Set up iptables rules:
  - `iptables -t nat -A OUTPUT -m owner --uid-owner $PROXY_UID -j RETURN` (exempt proxy's own traffic)
  - `iptables -t nat -A OUTPUT -p tcp --dport 80 -j REDIRECT --to-port $PROXY_PORT`
  - `iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port $PROXY_PORT`
  - Safety net: DROP rules for non-proxied traffic on 80/443
- Copy mitmproxy CA certs from mounted volume to mitmproxy's expected location
- Launch mitmproxy in transparent mode as `proxyuser`:

  ```
  exec su -s /bin/sh proxyuser -c "mitmdump --mode transparent --listen-port $PROXY_PORT -s /opt/compliance-addon.py --set confdir=/home/proxyuser/.mitmproxy"
  ```

- Make the script executable in the Dockerfile

**`sidecar/compliance-addon.py`:**

A mitmproxy addon script that:

- Logs every request (method, URL, headers, timestamp) to stdout and to a JSON log file at `/var/log/proxy/requests.jsonl`
- Implements a basic blocklist check (array of blocked domains)
- Returns a 403 response for blocked domains with a clear error message
- Logs response status codes and sizes
- This is the extensibility point — document where users would add their own compliance rules

### Step 4: App Container (Test Workload)

**`app/Dockerfile`:**

- Base image: `node:22-slim`
- Install the custom CA cert into the system trust store (`update-ca-certificates`)
- Set `NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/proxy-ca.crt`
- Copy and build a simple TypeScript test app

**`app/src/index.ts`:**

A simple script (no framework needed, just native `fetch`) that:

- Makes HTTP GET requests to a few public URLs (e.g., `http://httpbin.org/get`, `https://httpbin.org/get`)
- Attempts a request to a domain on the blocklist to demonstrate blocking
- Logs responses to stdout
- Runs in a loop every 10 seconds so you can observe the proxy behavior
- Uses a `tsconfig.json` with `"module": "nodenext"` and `"target": "ES2022"`

### Step 5: Docker Compose

**`docker-compose.yml`:**

```yaml
services:
  sidecar:
    build: ./sidecar
    cap_add:
      - NET_ADMIN
    sysctls:
      - net.ipv4.ip_forward=1
    volumes:
      - ./certs:/certs:ro
      - ./logs:/var/log/proxy

  app:
    build: ./app
    network_mode: "service:sidecar"
    depends_on:
      - sidecar
    volumes:
      - ./certs/ca-cert.pem:/usr/local/share/ca-certificates/proxy-ca.crt:ro
```

Key points:

- `network_mode: "service:sidecar"` is the critical line — forces shared network namespace
- Only `sidecar` needs `NET_ADMIN` capability
- Certs are read-only mounts
- Logs directory is a bind mount for easy inspection

### Step 6: README

Write a README.md covering:

- What this project does (1-2 sentences)
- Prerequisites (Docker, Docker Compose)
- Quick start: `./sidecar/generate-certs.sh && docker compose up --build`
- How to verify it's working (check logs, observe blocked requests)
- How to extend the compliance addon
- Architecture diagram (ASCII)
- Security considerations (CA cert management, production hardening notes)

## Key Technical Decisions

- **mitmproxy over Squid/Envoy**: Best balance of inspection capability and scriptability for a compliance use case. The Python addon API is simple to extend.
- **UID-based iptables exemption**: The only reliable way to prevent proxy loops in a shared network namespace. PID-based won't work across containers.
- **`mitmdump` over `mitmproxy`**: Non-interactive mode suitable for running as a service. Same engine, just no TUI.
- **JSONL log format**: Easy to pipe into log aggregation systems later.

## Testing Checklist

After `docker compose up --build`:

1. App container makes HTTP request → visible in sidecar logs
2. App container makes HTTPS request → visible in sidecar logs (decrypted)
3. App container requests blocked domain → gets 403 back
4. Direct curl from app container also gets intercepted (not just the Node process)
5. Sidecar's own outbound requests reach the internet successfully (no loop)
