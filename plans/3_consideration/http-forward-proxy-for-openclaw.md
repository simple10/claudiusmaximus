# Plan: HTTPS Forward Proxy for LLM Traffic Logging

Refer to <https://claude.ai/share/33400959-a738-48ba-a00c-6ff601c48489> before implementing.
Also see [](./http-transparent-sidecar-proxy.md)

We want to be able to allow or deny outbound traffic based on the container type.
e.g. Browser Sandbox -> Allow. Arbitrary Code Sandbox -> Deny.

We don't really need the sidecar for LLMetry when openclaw is configured to use
the cloudflare worker gateway as the only configured endpoint.

Sidecar is for security.

## Context

All outbound HTTP/HTTPS traffic from the OpenClaw gateway currently flows directly to external APIs (Anthropic, OpenAI, etc.) with no interception point. We need a forward proxy sidecar on VPS-1 that intercepts HTTPS traffic, logs full request/response bodies to the OTEL backend (Loki on VPS-2), and forwards requests to the intended LLM provider.

## Architecture

```
openclaw-gateway (172.30.0.x)
    │
    │  HTTP_PROXY / HTTPS_PROXY
    │  (Node.js patched via --require proxy-bootstrap.cjs)
    │
    ▼
openclaw-proxy (mitmproxy/mitmdump, 172.30.0.x)
    │  ├── LLM traffic (api.anthropic.com, api.openai.com, ...) → log to OTEL → forward
    │  └── Other traffic → forward without logging
    │
    ▼
Internet ──────────── VPS-2 (10.0.0.2) for proxy's own OTEL log export
```

Both containers on `openclaw-gateway-net` (existing bridge network, kept non-internal for now — see Phase 2 note below).

## Proxy Choice: mitmproxy (mitmdump)

- Native HTTPS MITM with automatic CA cert generation
- Python addon system for custom OTEL logging logic
- Headless `mitmdump` mode for sidecar use
- Selective logging: addon filters by destination host, only logs LLM API traffic

## Implementation Steps

### 1. Create proxy config directory and Dockerfile

**Create** `proxy-config/Dockerfile` on VPS-1 at `/home/openclaw/openclaw/proxy-config/`:

```dockerfile
FROM mitmproxy/mitmproxy:latest
RUN pip install --no-cache-dir \
    opentelemetry-api \
    opentelemetry-sdk \
    opentelemetry-exporter-otlp-proto-http
```

Builds as `openclaw-proxy:local`. Follows existing pattern of local image builds (`openclaw:local`).

### 2. Create mitmproxy OTEL addon script

**Create** `proxy-config/otel_logger.py` — a mitmproxy addon that:

- Filters by destination host (configurable via `PROXY_LLM_HOSTS` env var)
- Captures: method, URL, headers (auth redacted), request body, response status/body, timing, token usage
- Exports structured OTEL log records to Loki on VPS-2 (`http://10.0.0.2:3100/otlp/v1/logs`)
- Truncates bodies > 1MB, sets `body_truncated` attribute
- Severity mapping: 4xx=WARN, 5xx=ERROR, 2xx=INFO
- Parses LLM-specific metadata: model name, provider, input/output token counts

### 3. Create Node.js proxy bootstrap script

**Add** to build script (`scripts/build-openclaw.sh`): create `proxy-bootstrap.cjs` and patch Dockerfile to COPY it.

```javascript
// proxy-bootstrap.cjs — loaded via node --require ./proxy-bootstrap.cjs
// Configures both undici (fetch) and http/https modules to use HTTP_PROXY.
// No-op when proxy env vars are not set (image works with or without proxy).
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  // undici fetch() proxy support (built into Node.js)
  const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
```

This covers `fetch()`. If testing reveals `http.request()`/`https.request()` calls aren't proxied, we add `global-agent` as a follow-up (requires `npm install` in Dockerfile patch).

### 4. Update build script

**Modify** `scripts/build-openclaw.sh`:

- Add step between existing patches and build to create `proxy-bootstrap.cjs`
- Patch Dockerfile to `COPY proxy-bootstrap.cjs ./proxy-bootstrap.cjs`
- Add `proxy-bootstrap.cjs` to the `git checkout` restore step

### 5. Update docker-compose.override.yml

**Modify** `playbooks/04-vps1-openclaw.md` section 4.6 to add:

**New `openclaw-proxy` service:**

```yaml
openclaw-proxy:
  build:
    context: ./proxy-config
    dockerfile: Dockerfile
  image: openclaw-proxy:local
  container_name: openclaw-proxy
  restart: unless-stopped
  command: ["mitmdump", "--mode", "regular", "--listen-host", "0.0.0.0",
            "--listen-port", "8080", "--set", "connection_strategy=lazy",
            "-s", "/addons/otel_logger.py"]
  environment:
    - OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://10.0.0.2:3100/otlp/v1/logs
    - OTEL_SERVICE_NAME=openclaw-proxy
    - PROXY_LLM_HOSTS=api.anthropic.com,api.openai.com
    - PROXY_MAX_BODY_SIZE=1048576
  volumes:
    - ./data/proxy-ca:/home/mitmproxy/.mitmproxy          # persistent CA certs
    - ./proxy-config/otel_logger.py:/addons/otel_logger.py:ro
  networks:
    - openclaw-gateway-net
  healthcheck:
    test: ["CMD-SHELL", "python3 -c \"import socket; s=socket.create_connection(('localhost',8080)); s.close()\""]
    interval: 30s
    timeout: 5s
    retries: 3
    start_period: 10s
  deploy:
    resources:
      limits:
        cpus: "1"
        memory: 512M
  logging:
    driver: "json-file"
    options:
      max-size: "20m"
      max-file: "3"
```

**Modify `openclaw-gateway` service:**

- Add env vars: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY=10.0.0.0/8,localhost,127.0.0.1`, `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/proxy-ca.pem`
- Add volume: `./data/proxy-ca/mitmproxy-ca-cert.pem:/etc/ssl/certs/proxy-ca.pem:ro`
- Update command: insert `"--require", "./proxy-bootstrap.cjs"` after `"node"`
- Add `depends_on: openclaw-proxy: condition: service_healthy`

### 6. CA certificate bootstrap

On first run, mitmproxy auto-generates CA certs into `./data/proxy-ca/`. The gateway's `depends_on` ensures the proxy (and its CA) is ready before the gateway starts. The CA cert is bind-mounted into the gateway at `/etc/ssl/certs/proxy-ca.pem` and trusted via `NODE_EXTRA_CA_CERTS`.

### 7. Create extras playbook

**Create** `playbooks/extras/https-forward-proxy.md` documenting the full setup, verification, and troubleshooting.

**Update** `playbooks/extras/README.md` to list the new feature.

## Files to Create

| File | Location (VPS-1) | Purpose |
|------|-------------------|---------|
| `proxy-config/Dockerfile` | `/home/openclaw/openclaw/proxy-config/` | mitmproxy + Python OTEL SDK |
| `proxy-config/otel_logger.py` | `/home/openclaw/openclaw/proxy-config/` | Addon: intercept, log, forward |
| `playbooks/extras/https-forward-proxy.md` | Repo | Setup playbook |

## Files to Modify

| File | Changes |
|------|---------|
| `scripts/build-openclaw.sh` | Add proxy-bootstrap.cjs creation + Dockerfile COPY patch |
| `playbooks/04-vps1-openclaw.md` | Add proxy service, modify gateway service (section 4.6) |
| `playbooks/extras/README.md` | List new feature |
| `CLAUDE.md` | Add playbook row, key notes |

## Key Design Decisions

1. **Application-level proxy enforcement** (HTTP_PROXY env vars) rather than Docker internal network, because the gateway's sysbox nested Docker daemon needs direct internet access to pull/build sandbox images. Network isolation would break this. See Phase 2 note.

2. **NO_PROXY for OTEL traffic** (`10.0.0.0/8`) — gateway's OTEL telemetry to VPS-2 bypasses the proxy and flows directly, as it does today.

3. **Selective logging** — the proxy forwards ALL traffic but only logs requests to hosts in `PROXY_LLM_HOSTS`. OTEL data, Docker registry pulls, and other traffic pass through unlogged.

4. **Proxy's own OTEL export** — the proxy container ships its logs directly to Loki on VPS-2 (`http://10.0.0.2:3100/otlp/v1/logs`) as a separate service (`openclaw-proxy`).

5. **Bind mounts only** — CA certs in `./data/proxy-ca/`, addon script mounted read-only. No named volumes.

## Phase 2 (Future): Network-Level Enforcement

To enforce ALL traffic at the network level (not just application-level):

- Make `openclaw-gateway-net` internal (`--internal`)
- Add a second network (`proxy-external-net`) for the proxy's internet access
- Address sysbox nested Docker's need for registry access (pre-build sandbox, or configure nested daemon proxy)
- Route OTEL traffic through the proxy too

This is deferred because it adds complexity and the application-level approach already covers LLM API calls.

## Verification

```bash
# 1. Proxy container running and healthy
sudo docker ps | grep openclaw-proxy

# 2. CA cert exists and is mounted in gateway
sudo docker exec openclaw-gateway ls -la /etc/ssl/certs/proxy-ca.pem

# 3. Gateway env vars set correctly
sudo docker exec openclaw-gateway env | grep -E 'PROXY|CA_CERTS'

# 4. Send actual LLM traffic (message via gateway UI or API)
# 5. Check Loki for proxy logs: {service_name="openclaw-proxy"}
# 6. Verify response came back correctly (proxy didn't break the flow)
```

## Rollback

Remove proxy service + gateway proxy env vars from compose override, rebuild gateway image without proxy-bootstrap, restart. The proxy is fully additive — no existing functionality is modified.
