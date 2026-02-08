# REQUIREMENTS.md — OpenClaw Two-VPS Deployment

Authoritative reference for the OpenClaw deployment architecture, configuration, and design decisions. Use this as a safety guide when making modifications.

Networking: Cloudflare Tunnel (zero exposed ports, origin IP hidden).

---

## 1. Architecture Overview

Two OVHCloud VPS instances connected by a WireGuard tunnel. All inter-VPS traffic is encrypted. External access is via Cloudflare Tunnel (outbound-only connections, no inbound ports exposed).

| VPS | Hostname | Role | WireGuard IP | Public IP |
|-----|----------|------|--------------|-----------|
| VPS-1 | `openclaw` | Gateway + Sandboxes | `10.0.0.1` | From `openclaw-config.env` |
| VPS-2 | `observe` | Observability Stack | `10.0.0.2` | From `openclaw-config.env` |

**Data flow:**
- Users -> Cloudflare Edge -> Cloudflare Tunnel -> VPS-1 gateway (port 18789)
- Users -> Cloudflare Edge -> Cloudflare Tunnel -> VPS-2 Grafana (port 3000)
- VPS-1 -> WireGuard (10.0.0.0/24) -> VPS-2 (traces, metrics, logs)
- VPS-2 Prometheus -> WireGuard -> VPS-1 Node Exporter (port 9100)

---

## 2. Common Requirements (Both VPSs)

### 2.1 OS & System Packages

**OS:** Ubuntu (OVHCloud VPS default)

**Required packages:**
```
curl wget git vim htop tmux unzip
ca-certificates gnupg lsb-release apt-transport-https software-properties-common
ufw fail2ban auditd wireguard wireguard-tools
```

### 2.2 Two-User Security Model

| User | SSH Access | Sudo | Purpose |
|------|------------|------|---------|
| `adminclaw` | Key-only, port 222 | Passwordless | System admin, SSH access |
| `openclaw` | None | None | Application runtime, file ownership |

**Rationale:** If `openclaw` is compromised, the attacker cannot escalate to root. `adminclaw` is not a well-known username, reducing brute-force attack surface. Clear separation between admin tasks and application runtime.

**Important:**
- SSH keys are copied from the initial `ubuntu` user to `adminclaw` during setup
- `openclaw` has no SSH access and no sudo — access via `sudo su - openclaw` or `sudo -u openclaw <cmd>`
- Both users should have passwords set (for console access recovery only)
- `adminclaw` cannot `cd` into `/home/openclaw/` (750 perms) — use `sudo -u openclaw bash -c "cd /home/openclaw/... && ..."` or `sudo sh -c 'cd /home/openclaw/... && ...'`

### 2.3 SSH Hardening

**Config file:** `/etc/ssh/sshd_config.d/hardening.conf`

| Setting | Value | Rationale |
|---------|-------|-----------|
| `Port` | `222` | Non-standard port avoids bot scanners |
| `PermitRootLogin` | `no` | Prevent direct root SSH |
| `PasswordAuthentication` | `no` | Key-only authentication |
| `ChallengeResponseAuthentication` | `no` | Disable challenge-response |
| `UsePAM` | `yes` | **Critical on Ubuntu** — `no` breaks authentication |
| `AllowUsers` | `adminclaw` | Only admin user can SSH |
| `MaxAuthTries` | `3` | Rate limit auth attempts |
| `MaxSessions` | `3` | Limit concurrent sessions |
| `LoginGraceTime` | `30` | 30-second window to authenticate |
| `X11Forwarding` | `no` | Disable X11 (not needed) |
| `AllowTcpForwarding` | `no` | Prevent port forwarding |
| `AllowAgentForwarding` | `no` | Prevent agent forwarding |

**Crypto settings:**
- KexAlgorithms: `curve25519-sha256@libssh.org`, `diffie-hellman-group16-sha512`
- Ciphers: `chacha20-poly1305@openssh.com`, `aes256-gcm@openssh.com`
- MACs: `hmac-sha2-512-etm@openssh.com`, `hmac-sha2-256-etm@openssh.com`

**Ubuntu systemd socket activation (critical):**
Ubuntu uses socket activation for SSH. Changing the port requires BOTH:
1. `/etc/ssh/sshd_config.d/hardening.conf` with `Port 222`
2. Systemd socket override at `/etc/systemd/system/ssh.socket.d/override.conf`:
   ```
   [Socket]
   ListenStream=
   ListenStream=0.0.0.0:222
   ListenStream=[::]:222
   ```

The service name is `ssh` on Ubuntu, not `sshd`.

### 2.4 UFW Firewall

**Default policy:** Deny incoming, Allow outgoing

**Common rules (both VPSs):**

| Port | Protocol | Rule | Purpose |
|------|----------|------|---------|
| 222 | TCP | Allow | SSH (hardened port) |
| 51820 | UDP | Allow | WireGuard tunnel |

**VPS-1 additional rules:**

| Port | Protocol | Rule | Purpose |
|------|----------|------|---------|
| 9100 | TCP | Allow from 10.0.0.0/24 | Node Exporter (Prometheus scraping via WireGuard) |
| 18789 | TCP | Allow from 10.0.0.0/24 | Gateway debug endpoint (WireGuard only) |

**VPS-2 additional rules:**

| Rule | Purpose |
|------|---------|
| Allow from 10.0.0.0/24 | WireGuard subnet — required for Loki (3100), Tempo OTLP (4318), Prometheus (9090) to receive data from VPS-1 |

**Design decision:** Port 443 is NOT opened on either VPS. Cloudflare Tunnel uses outbound connections only.

**Critical ordering:** Configure UFW rules BEFORE changing SSH port. Changing SSH port before adding the UFW rule causes lockout.

### 2.5 Fail2ban

**Config file:** `/etc/fail2ban/jail.local`

| Setting | Value | Rationale |
|---------|-------|-----------|
| `bantime` | `1h` | Default ban duration |
| `findtime` | `10m` | Lookback window for retries |
| `maxretry` | `5` | General retry limit |
| `backend` | `systemd` | Use systemd journal |
| SSH `maxretry` | `3` | Stricter for SSH |
| SSH `bantime` | `24h` | Longer ban for SSH brute force |
| SSH `port` | `222` | Matches hardened SSH port |

### 2.6 Kernel Hardening

**Config file:** `/etc/sysctl.d/99-security.conf`

Key parameters:
- `net.ipv4.conf.all.rp_filter = 1` — IP spoofing protection
- `net.ipv4.icmp_echo_ignore_broadcasts = 1` — Ignore ICMP broadcast
- `net.ipv4.conf.all.accept_source_route = 0` — Disable source routing
- `net.ipv4.conf.all.send_redirects = 0` — Ignore redirects
- `net.ipv4.tcp_syncookies = 1` — SYN flood protection
- `net.ipv4.tcp_max_syn_backlog = 2048`
- `net.ipv4.tcp_synack_retries = 2`
- `net.ipv4.conf.all.log_martians = 1` — Log suspicious packets
- `kernel.randomize_va_space = 2` — Full ASLR
- `kernel.dmesg_restrict = 1` — Restrict dmesg access
- `kernel.kptr_restrict = 2` — Restrict kernel pointer access

### 2.7 Automatic Security Updates

**Package:** `unattended-upgrades`
**Config:** `/etc/apt/apt.conf.d/50unattended-upgrades`

- Allowed origins: Main, Security, ESM Apps, ESM Infra
- `AutoFixInterruptedDpkg: true`
- `Remove-Unused-Kernel-Packages: true`
- `Remove-Unused-Dependencies: true`
- `Automatic-Reboot: false` — Manual reboot preferred to avoid unexpected downtime

### 2.8 WireGuard Tunnel

**Purpose:** Encrypted tunnel between VPSs for all monitoring/observability traffic.

| VPS | Interface | Address | Port |
|-----|-----------|---------|------|
| VPS-1 | wg0 | 10.0.0.1/24 | 51820/udp |
| VPS-2 | wg0 | 10.0.0.2/24 | 51820/udp |

**Config file:** `/etc/wireguard/wg0.conf` (chmod 600)

**Key settings:**
- `PersistentKeepalive = 25` — Keeps tunnel alive through NAT (25-second interval)
- Each VPS has its own private key and the peer's public key
- `AllowedIPs` restricted to peer's WireGuard IP (`/32`)
- `Endpoint` set to peer's public IP

**Private key:** `/etc/wireguard/private.key` (chmod 600)

**Service:** `wg-quick@wg0` (systemd, enabled + started)

**Verification:** `sudo wg show` — look for "latest handshake" within 2 minutes

### 2.9 Docker

**Package:** Docker CE from official Docker apt repository

**Components:** `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`

**Users in docker group:** `openclaw`, `adminclaw`

**Daemon hardening** (`/etc/docker/daemon.json`):

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" },
  "storage-driver": "overlay2",
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Hard": 65536, "Soft": 65536 }
  }
}
```

| Setting | Rationale |
|---------|-----------|
| `json-file` with rotation | Standard logging with 50MB/5 files rotation |
| `overlay2` | Recommended storage driver |
| `live-restore: true` | Containers survive daemon restarts |
| `userland-proxy: false` | Use iptables for port mapping (better performance + security) |
| `no-new-privileges: true` | Prevent container privilege escalation |
| `nofile: 65536` | Increase file descriptor limits for stability |

### 2.10 Cloudflare Tunnel

**Purpose:** Zero exposed ports, origin IP hidden, built-in DDoS protection.

**Package:** `cloudflared` (installed from GitHub releases .deb)

**Architecture:**
- `cloudflared` makes outbound connections to Cloudflare edge
- No inbound ports needed (port 443 stays closed)
- DNS routes traffic: domain -> Cloudflare -> tunnel -> local service

**VPS-1 tunnel:** Named `openclaw`
- Routes `DOMAIN_OPENCLAW` -> `http://localhost:18789` (gateway)
- `originRequest.noTLSVerify: true` (local HTTP, TLS at Cloudflare edge)

**VPS-2 tunnel:** Named `observe`
- Routes `DOMAIN_GRAFANA` -> `http://localhost:3000` (Grafana)
- `originRequest.noTLSVerify: true`

**Config:** `/etc/cloudflared/config.yml`
**Credentials:** `/etc/cloudflared/credentials.json` (chmod 600)
**Service:** `cloudflared` (systemd, enabled)

**DNS routing:** `cloudflared tunnel route dns <tunnel-name> <domain>` creates CNAME in Cloudflare DNS

**Security:** Port 443 must remain closed (`sudo ufw delete allow 443/tcp` if it was ever opened)

---

## 3. VPS-1 Requirements (OpenClaw Gateway)

### 3.1 Sysbox Runtime

**Package:** `sysbox-ce` (v0.6.4+)
**Purpose:** User namespace isolation for Docker-in-Docker. Maps uid 0 inside container to an unprivileged uid on the host.

**Key behaviors:**
- Auto-provisions writable mounts at `/var/lib/sysbox/docker/<container-id>/` for `/var/lib/docker` and `/var/lib/containerd`
- These auto-mounts inherit the container's `read_only` flag (important — see 3.4)
- Provides equivalent security to `read_only: true` via user namespace isolation

**Verification:** `sudo docker info | grep -i sysbox`

### 3.2 Docker Networks

| Network | Subnet | Driver | Flags | Purpose |
|---------|--------|--------|-------|---------|
| `openclaw-gateway-net` | `172.30.0.0/24` | bridge | external: true | Gateway, cloudflared, Node Exporter, Promtail |
| `openclaw-sandbox-net` | `172.31.0.0/24` | bridge | internal: true | Agent sandboxes (no outbound internet) |

**Design decision:** Subnets use `172.30.x.x` and `172.31.x.x` to avoid conflicts with Docker's default `172.17.0.0/16` range.

**Critical:** The gateway network's `.1` IP (`172.30.0.1`) is used for `trustedProxies` in the Cloudflare Tunnel setup. cloudflared connects via the Docker bridge and appears as `172.30.0.1` to the gateway.

### 3.3 Directory Structure & Permissions

```
/home/openclaw/
├── openclaw/                    # Cloned repo (github.com/openclaw/openclaw)
│   ├── docker-compose.yml       # Original from upstream
│   ├── docker-compose.override.yml  # Our customizations
│   ├── .env                     # Environment variables
│   ├── promtail-config.yml      # Promtail configuration
│   ├── promtail-positions/      # Persistent Promtail state
│   └── scripts/
│       └── entrypoint-gateway.sh  # Custom entrypoint
├── .openclaw/                   # Gateway config & state (owned by uid 1000)
│   ├── openclaw.json            # Gateway configuration (chmod 600)
│   ├── workspace/               # Agent workspaces
│   ├── credentials/             # Stored credentials
│   ├── logs/
│   └── backups/
├── .claude-sandbox/             # Sandbox Claude Code credentials (isolated from gateway)
└── scripts/
    └── build-openclaw.sh        # Build script with auto-patching
```

**Ownership:**
- `/home/openclaw` and subdirs: `openclaw:openclaw`
- `.openclaw/` contents: `uid 1000:1000` (container's `node` user, which is host `ubuntu` uid 1000)
- **Known deviation:** `ubuntu` user (uid 1000) still exists alongside `openclaw` (uid 1002). Container files in `.openclaw` are owned by uid 1000 (ubuntu), not openclaw. This is correct for container compatibility.

### 3.4 Gateway Container (docker-compose.override.yml)

**Image:** `openclaw:local` (built by `scripts/build-openclaw.sh`)
**Container name:** `openclaw-gateway`
**Runtime:** `sysbox-runc`

| Setting | Value | Rationale |
|---------|-------|-----------|
| `user` | `"0:0"` | Root inside container — Sysbox maps to unprivileged uid on host. Required for starting `dockerd` |
| `read_only` | `false` | **Required.** Sysbox auto-mounts for `/var/lib/docker` inherit this flag. With `true`, dockerd gets `chmod /var/lib/docker: read-only file system` |
| `no-new-privileges` | `true` | Prevent escalation. gosu drops privileges (doesn't gain) |
| `start_period` | `300s` | First boot builds 4 sandbox images (3-5 minutes) |
| `cpus` | `4` (limit), `1` (reservation) | Resource bounds |
| `memory` | `8G` (limit), `2G` (reservation) | Resource bounds |

**tmpfs mounts:**

| Path | Size | Purpose |
|------|------|---------|
| `/tmp` | 1G | Sandbox builds, large operations |
| `/var/tmp` | 200M | Temporary files |
| `/run` | 100M | Runtime files |
| `/var/log` | 100M | `dockerd.log` (nested Docker daemon) |

**Volumes (bind mounts):**
- `./scripts/entrypoint-gateway.sh:/app/scripts/entrypoint-gateway.sh:ro` — Custom entrypoint
- `/home/openclaw/.claude-sandbox:/home/node/.claude-sandbox` — Sandbox Claude credentials

**Command:**
```
node dist/index.js gateway --allow-unconfigured --bind lan --port 18789
```

**Environment variables:**
- `NODE_ENV=production`
- `ANTHROPIC_API_KEY` — From `.env`
- `TELEGRAM_BOT_TOKEN` — From `.env` (optional)
- `TZ=UTC`
- OTEL per-signal endpoints (see 3.8)

### 3.5 Entrypoint Script (`scripts/entrypoint-gateway.sh`)

Runs as root inside container (Sysbox isolation). Performs pre-start tasks in order:

1. **Lock file cleanup** — Removes stale `gateway.*.lock` files from unclean shutdowns
2. **Config permissions** — Enforces `chmod 600` on `openclaw.json` (gateway may rewrite with looser perms)
3. **Sandbox credentials ownership** — `chown -R 1000:1000 /home/node/.claude-sandbox` (Sysbox uid remapping: host uid 1000 appears as uid 1002 inside container)
4. **Start nested Docker daemon** — `dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 --log-level=warn`, waits up to 30 seconds for `docker info` to succeed
5. **Build sandbox images** (only if dockerd is ready):
   - `openclaw-sandbox` — Base sandbox (from `/app/sandbox/Dockerfile`)
   - `openclaw-sandbox-common:bookworm-slim` — Node.js, git, dev tools
   - `openclaw-sandbox-browser:bookworm-slim` — Chromium + noVNC
   - `openclaw-sandbox-claude:bookworm-slim` — Common + Claude Code CLI (layered image)
6. **Privilege drop** — `exec gosu node "$@"` drops from root to node (uid 1000). `gosu` doesn't spawn a subshell (preserves PID 1 signal handling). Full gateway command passed as arguments from compose override.

### 3.6 Build Process (`scripts/build-openclaw.sh`)

**Usage:** `sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh`

Patches upstream Dockerfile and source in-place before `docker build`, then `git checkout` restores the working tree. Each patch auto-skips when upstream fixes the issue (guard checks via `grep` run before patching).

**Patches applied:**

| # | Target | Issue | Fix |
|---|--------|-------|-----|
| 1 | Dockerfile | Extension deps not installed (upstream runs `pnpm install` before `COPY . .`) | Insert `COPY extensions/diagnostics-otel/package.json` before pnpm install |
| 2a | OTEL extension | `@opentelemetry/resources` v2.x removed `new Resource()` | Use `resourceFromAttributes()` instead |
| 2b | OTEL extension | `@opentelemetry/sdk-logs` v0.211+ removed `addLogRecordProcessor()` | Pass `logRecordProcessors: [...]` in `LoggerProvider` constructor |
| 3 | `src/infra/diagnostic-events.ts` | Dual-bundle problem: `listeners` Set duplicated across gateway and plugin-sdk bundles | Use `globalThis.__OPENCLAW_DIAG_LISTENERS__` for shared Set |
| 4 | Dockerfile | Claude Code CLI needed in gateway image | `RUN npm install -g @anthropic-ai/claude-code` before `USER node` |
| 5 | Dockerfile | Docker + gosu needed for nested Docker (sandbox isolation) | `RUN apt-get install docker.io gosu && usermod -aG docker node` before `USER node` |

**Critical constraint:** Patches 4 and 5 MUST be inserted before `USER node` in the Dockerfile. After `USER node`, npm and apt can't write to system directories (EACCES).

**Build args:**
- `OPENCLAW_DOCKER_APT_PACKAGES` — Extra apt packages for gateway image (e.g., `"ffmpeg build-essential imagemagick"`)

**Gotcha:** If build fails, `git checkout` (cleanup step) doesn't run. Next build sees old patches and may skip. Fix: manually `git checkout -- Dockerfile extensions/ src/infra/diagnostic-events.ts` before retrying.

### 3.7 openclaw.json Configuration

**Location:** `/home/openclaw/.openclaw/openclaw.json`
**Permissions:** `chmod 600` (enforced by entrypoint every startup)
**Ownership:** `1000:1000`

**Important:** OpenClaw rejects unknown keys. Only use documented configuration keys.

```json
{
  "commands": {
    "restart": true
  },
  "gateway": {
    "bind": "lan",
    "mode": "local",
    "trustedProxies": ["172.30.0.1"],
    "controlUi": {
      "basePath": "<SUBPATH_OPENCLAW>"
    }
  },
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": { "enabled": true }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 20000
    }
  },
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox-claude:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          "workdir": "/workspace",
          "readOnlyRoot": true,
          "tmpfs": ["/tmp", "/var/tmp", "/run", "/home/linuxbrew:uid=1000,gid=1000"],
          "network": "bridge",
          "user": "1000:1000",
          "capDrop": ["ALL"],
          "env": { "LANG": "C.UTF-8" },
          "pidsLimit": 256,
          "memory": "1g",
          "memorySwap": "2g",
          "cpus": 1,
          "binds": ["/home/node/.claude-sandbox:/home/linuxbrew/.claude"]
        },
        "browser": {
          "enabled": true,
          "image": "openclaw-sandbox-browser:bookworm-slim",
          "containerPrefix": "openclaw-sbx-browser-",
          "cdpPort": 9222,
          "vncPort": 5900,
          "noVncPort": 6080,
          "headless": false,
          "enableNoVnc": true,
          "autoStart": true,
          "autoStartTimeoutMs": 12000
        },
        "prune": {
          "idleHours": 168,
          "maxAgeDays": 60
        }
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "browser",
                  "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status"],
        "deny": ["canvas", "nodes", "cron", "discord", "gateway"]
      }
    }
  }
}
```

**Key design decisions:**

| Setting | Rationale |
|---------|-----------|
| `commands.restart: true` | Agents can modify config and trigger in-process restart via SIGUSR1 |
| `trustedProxies: ["172.30.0.1"]` | cloudflared connects via Docker bridge gateway IP. Only exact IPs work — CIDR ranges NOT supported by `isTrustedProxyAddress()` |
| `controlUi.basePath` | URL prefix for Control UI, set from `SUBPATH_OPENCLAW` in config |
| No `otel.endpoint` field | **Critical.** Setting `endpoint` forces all signals to one destination, overriding env vars. Per-signal env vars only work when `endpoint` is absent |
| `sandbox.mode: "all"` | All agents run in Docker sandboxes. Requires Docker installed inside container (build patch #5). Without Docker, `spawn docker` crashes with EACCES. Fallback: `"non-main"` |
| `sandbox.docker.network: "bridge"` | Required for browser tool. `"none"` breaks CDP connectivity (gateway can't reach port 9222 in sandbox) |
| `tmpfs /home/linuxbrew:uid=1000,gid=1000` | Makes sandbox home writable for `~/.claude.json`. The `:uid=1000,gid=1000` is critical — without it, tmpfs mounts as root-owned and linuxbrew user can't write |
| `readOnlyRoot: true` | Sandbox filesystem is read-only for security. Home dir writable via tmpfs overlay |
| `prune.idleHours: 168` (7 days) | Longer prune avoids repeatedly rebuilding sandbox state |
| `capDrop: ["ALL"]` | Drop all Linux capabilities in sandboxes — minimal privilege |
| `binds` on sandbox | Mounts gateway's `.claude-sandbox` credentials into sandbox home |

### 3.8 OTEL Per-Signal Routing

**Design decision:** Each signal goes to its dedicated backend via separate environment variables. Do NOT use a unified `endpoint` in openclaw.json.

**Environment variables** (set in `docker-compose.override.yml` and `.env`):

| Variable | Value | Backend |
|----------|-------|---------|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://10.0.0.2:4318/v1/traces` | Tempo |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `http://10.0.0.2:9090/api/v1/otlp/v1/metrics` | Prometheus |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `http://10.0.0.2:3100/otlp/v1/logs` | Loki |

**Critical details:**
- Per-signal env vars contain the **full URL** (SDK does not append path). The base env var (`OTEL_EXPORTER_OTLP_ENDPOINT`) appends `/v1/traces` etc., but per-signal vars do not.
- If `otel.endpoint` is set in openclaw.json, the plugin passes explicit `url` to each exporter, which overrides env vars. Must be removed for env vars to work.
- OTEL data only appears when gateway has actual activity (model calls, webhooks, webchat messages). An idle gateway produces no metrics/traces/logs.
- The `agent` CLI bypasses the dispatch system — only webchat/channel messages generate traces.

**Plugin behavior:** The diagnostics-otel plugin only logs `"logs exporter enabled (OTLP/HTTP)"`. There are NO log messages for trace or metrics exporters. All three ARE initialized when enabled. Don't assume missing log = missing exporter.

### 3.9 Sandbox Images

Four images built during first boot by the entrypoint script:

| Image | Base | Contents | Size |
|-------|------|----------|------|
| `openclaw-sandbox` | Upstream Dockerfile | Minimal sandbox (base) | ~150MB |
| `openclaw-sandbox-common:bookworm-slim` | Custom script | Node.js, git, dev tools | ~500MB |
| `openclaw-sandbox-browser:bookworm-slim` | Custom script | Chromium + noVNC | ~800MB |
| `openclaw-sandbox-claude:bookworm-slim` | Layered on common | Common + Claude Code CLI | ~600MB |

**Claude sandbox build command:**
```bash
printf 'FROM openclaw-sandbox-common:bookworm-slim\nUSER root\nRUN npm install -g @anthropic-ai/claude-code\nUSER 1000\n' | docker build -t openclaw-sandbox-claude:bookworm-slim -
```

**Critical constraints:**
- Do NOT use `docker build -f - /dev/null` — nested Docker (Sysbox) rejects `/dev/null` as build context. Use `printf ... | docker build -t tag -` instead.
- Do NOT use `docker run`/`docker commit` to mutate images — creates a dirty layer. Use `docker build` with proper FROM layer.

### 3.10 Claude Code in Sandboxes

**Credential isolation:** Sandboxes use `/home/openclaw/.claude-sandbox` (NOT gateway's `/home/openclaw/.claude`). Gateway credentials are device-bound OAuth tokens that don't work across containers. Sandbox gets its own credentials via `claude login` (one-time setup).

**Bind chain:**
1. Host: `/home/openclaw/.claude-sandbox`
2. -> Gateway container: `/home/node/.claude-sandbox` (via compose volume mount)
3. -> Sandbox container: `/home/linuxbrew/.claude` (via openclaw.json `binds`)

**Sandbox user:** `linuxbrew` (uid 1000), home at `/home/linuxbrew`

**Sysbox uid remapping fix:** Host uid 1000 appears as uid 1002 inside gateway. Entrypoint runs `chown -R 1000:1000 /home/node/.claude-sandbox` to fix this before gosu drops privileges.

### 3.11 Promtail (Log Shipping)

**Image:** `grafana/promtail:latest`
**Container name:** `promtail`
**Network:** host

**Config file:** `/home/openclaw/openclaw/promtail-config.yml`

**Loki endpoint:** `http://10.0.0.2:3100/loki/api/v1/push` (VPS-2 via WireGuard)

**Scrape targets:**
- System logs: `/var/log/*log` (labels: `job=varlogs`, `host=openclaw`)
- Docker container logs: `/var/lib/docker/containers/*/*-json.log` (labels: `job=docker`, `host=openclaw`)

**Persistent state:** `./promtail-positions/` bind mount prevents re-shipping logs after container restart.

### 3.12 Node Exporter

**Image:** `prom/node-exporter:latest`
**Container name:** `node-exporter`
**Network:** host
**Port:** 9100

Exposes host system metrics (CPU, memory, disk, network) for Prometheus on VPS-2 to scrape via WireGuard.

### 3.13 Backup

**Script:** `/home/openclaw/scripts/backup.sh`
**Runs as:** root (via `/etc/cron.d/openclaw-backup`)

**Rationale for root:** `.openclaw` files are owned by uid 1000 (`ubuntu`), but the `openclaw` user is uid 1002. Root is the only user that can read all files reliably.

**Schedule:** `0 3 * * *` (daily at 3 AM)

**Files backed up:**
- `.openclaw/openclaw.json` — Gateway config
- `.openclaw/credentials/` — API keys, tokens
- `.openclaw/workspace/` — User workspaces
- `openclaw/.env` — Environment variables
- `openclaw/promtail-positions` — Log positions (prevents duplicate ingestion)

**Retention:** 30 days (auto-delete older backups)
**Output:** `/home/openclaw/.openclaw/backups/openclaw_backup_YYYYMMDD_HHMMSS.tar.gz`
**Ownership:** Files owned by `1000:1000` (container-compatible)

**Cron job location:** `/etc/cron.d/openclaw-backup` (NOT user crontab — user crontab runs as openclaw uid 1002, which can't read uid 1000 files)

### 3.14 Device Pairing & Authentication

**Flow:**
1. User opens `https://<DOMAIN>/<SUBPATH>/chat?token=<TOKEN>`
2. Token auth succeeds -> gateway checks device pairing
3. If unpaired -> WebSocket closed with code `1008: pairing required`
4. Admin approves via CLI:
   ```bash
   sudo docker exec openclaw-gateway node dist/index.js devices list
   sudo docker exec openclaw-gateway node dist/index.js devices approve <requestId>
   ```
5. Browser auto-retries -> connects successfully

**Important:**
- Pending requests have 5-minute TTL. Browser retries create new requests.
- Once one device is paired, subsequent devices can be approved from the Control UI.
- Stored in `~/.openclaw/devices/pending.json`
- Do NOT use `dangerouslyDisableDeviceAuth` — device pairing is defense-in-depth security.

### 3.15 Gateway .env File

**Location:** `/home/openclaw/openclaw/.env`

| Variable | Purpose |
|----------|---------|
| `OPENCLAW_GATEWAY_TOKEN` | 64-char hex token for URL-based auth |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | Optional: Telegram integration |
| `DISCORD_BOT_TOKEN` | Optional: Discord integration |
| `GRAFANA_PASSWORD` | Auto-generated Grafana admin password |
| `OPENCLAW_CONFIG_DIR` | `/home/openclaw/.openclaw` |
| `OPENCLAW_WORKSPACE_DIR` | `/home/openclaw/.openclaw/workspace` |
| `OPENCLAW_GATEWAY_PORT` | `0.0.0.0:18789` — Must bind all interfaces for tunnel/proxy access |
| `OPENCLAW_BRIDGE_PORT` | `0.0.0.0:18790` — Bridge API |
| `OPENCLAW_GATEWAY_BIND` | `lan` |
| `OTEL_EXPORTER_OTLP_*_ENDPOINT` | Per-signal OTEL routing (see 3.8) |
| `OPENCLAW_DOCKER_APT_PACKAGES` | Extra apt packages for gateway image build |

**Gotcha:** `.env` values with spaces MUST be quoted (e.g., `VAR="a b c"`). Unquoted values cause bash `source .env` to treat words as separate commands.

---

## 4. VPS-2 Requirements (Observability Stack)

### 4.1 Service Architecture

All services use `network_mode: host`. No custom Docker networks.

**Rationale:** Host network provides reliable inter-service communication for metrics, logs, and traces. All services bind to either `127.0.0.1` (local-only) or `10.0.0.2` (WireGuard, accessible from VPS-1).

**Bind mounts, not named volumes:** All data persisted under `./data/<service>/` in `/home/openclaw/monitoring/`. This enables easy backup with `rsync` and keeps data visible on the host filesystem.

### 4.2 Directory Structure

```
/home/openclaw/monitoring/
├── docker-compose.yml
├── prometheus.yml
├── alerts.yml
├── alertmanager.yml
├── loki-config.yml
├── tempo-config.yml
├── .env
├── grafana/
│   └── provisioning/
│       ├── datasources/
│       │   └── datasources.yml
│       └── dashboards/
└── data/
    ├── prometheus/      (owned by 65534:65534)
    ├── grafana/         (owned by 472:root)
    ├── loki/            (owned by 10001:10001)
    ├── tempo/           (owned by 10001:10001)
    └── alertmanager/    (owned by 65534:65534)
```

### 4.3 Prometheus

**Image:** `prom/prometheus:latest`
**Container name:** `prometheus`
**Binding:** `10.0.0.2:9090` (WireGuard IP)
**Data:** `./data/prometheus:/prometheus` (owned by `65534:65534`)
**Retention:** `--storage.tsdb.retention.time=30d`
**OTLP receiver:** Enabled via `--web.enable-otlp-receiver` flag

**Config:** `/home/openclaw/monitoring/prometheus.yml`

| Setting | Value |
|---------|-------|
| `scrape_interval` | `15s` |
| `evaluation_interval` | `15s` |

**Scrape targets:**

| Job | Target | Labels | Purpose |
|-----|--------|--------|---------|
| `prometheus` | `10.0.0.2:9090` | — | Self-monitoring |
| `node-exporter` | `127.0.0.1:9100` | `host=observe` | VPS-2 host metrics |
| `cadvisor` | `127.0.0.1:8080` | `host=observe` | VPS-2 container metrics |
| `node-exporter-openclaw` | `10.0.0.1:9100` | `host=openclaw` | VPS-1 host metrics (via WireGuard) |

**Alert rules:** Loaded from `alerts.yml` (see 4.8)

### 4.4 Grafana

**Image:** `grafana/grafana:latest`
**Container name:** `grafana`
**Binding:** `127.0.0.1:3000` (localhost only, proxied via Cloudflare Tunnel)
**Data:** `./data/grafana:/var/lib/grafana` (owned by `472:root`)

**Environment variables:**

| Variable | Value | Purpose |
|----------|-------|---------|
| `GF_SECURITY_ADMIN_USER` | `admin` | Admin username |
| `GF_SECURITY_ADMIN_PASSWORD` | `${GRAFANA_PASSWORD}` | Auto-generated |
| `GF_USERS_ALLOW_SIGN_UP` | `false` | Disable self-registration |
| `GF_SERVER_ROOT_URL` | `https://${GRAFANA_DOMAIN}${SUBPATH_GRAFANA}/` | Full external URL |
| `GF_SERVER_SERVE_FROM_SUB_PATH` | `true` | Enable subpath serving |
| `GF_SERVER_HTTP_ADDR` | `127.0.0.1` | Localhost only |

### 4.5 Grafana Datasource Provisioning

**File:** `grafana/provisioning/datasources/datasources.yml`

| Datasource | Type | URL | UID | Notes |
|------------|------|-----|-----|-------|
| Prometheus | `prometheus` | `http://10.0.0.2:9090` | — | Default datasource |
| Loki | `loki` | `http://10.0.0.2:3100` | `loki` | UID required for Tempo cross-reference |
| Tempo | `tempo` | `http://127.0.0.1:3200` | — | Links to Loki via `tracesToLogsV2` |

**Tempo trace-to-logs linking:**
- `datasourceUid: loki` — References Loki by UID
- `filterByTraceID: true`, `filterBySpanID: true` — Auto-filter logs by trace/span
- `spanStartTimeShift: '-1h'`, `spanEndTimeShift: '1h'` — Time window for log lookup
- Use `tracesToLogsV2` NOT `tracesToLogs` (deprecated)

**Important:** Adding `uid: loki` to existing Loki datasource requires fresh Grafana data volume (wipe `./data/grafana/`) since the existing db has a different auto-generated UID.

### 4.6 Loki

**Image:** `grafana/loki:latest`
**Container name:** `loki`
**Bindings:** `10.0.0.2:3100` (HTTP), `10.0.0.2:9096` (gRPC) — both on WireGuard IP
**Data:** `./data/loki:/loki` (owned by `10001:10001`)

**Config:** `/home/openclaw/monitoring/loki-config.yml`

| Setting | Value | Rationale |
|---------|-------|-----------|
| `auth_enabled` | `false` | Single-tenant setup |
| HTTP + gRPC binding | Both on `10.0.0.2` | **Must match** — different interfaces causes "connection refused" for internal component communication |
| `instance_addr` | `10.0.0.2` | Must match server bindings |
| Schema store | `tsdb` | Required by newer Loki versions |
| Schema version | `v13` | Required by newer Loki versions |
| Index period | `24h` | Standard |
| `retention_period` | `720h` (30 days) | Log retention |
| `kvstore.store` | `inmemory` | Single-node setup |
| `replication_factor` | `1` | Single-node setup |
| `allow_structured_metadata` | `true` | **Required for OTLP log ingestion** |
| Ruler alertmanager URL | `http://127.0.0.1:9093` | Local alertmanager |

### 4.7 Tempo

**Image:** `grafana/tempo:2.10.0` (PINNED — do NOT use `latest`)
**Container name:** `tempo`
**Bindings:** `127.0.0.1:3200` (HTTP API), `10.0.0.2:4318` (OTLP receiver on WireGuard)
**Data:** `./data/tempo:/var/tempo` (owned by `10001:10001`)

**Why pinned to 2.10.0:** `latest` now points to Tempo 3.0 pre-release which replaces `Ingester` with `LiveStore` + `BlockBuilder` + Kafka. Without Kafka, the ingester ring stays empty and all queries fail with "empty ring".

**Config:** `/home/openclaw/monitoring/tempo-config.yml`

| Setting | Value | Rationale |
|---------|-------|-----------|
| `stream_over_http_enabled` | `true` | HTTP streaming support |
| HTTP API | `127.0.0.1:3200` | Local-only API access |
| OTLP HTTP receiver | `10.0.0.2:4318` | Receives traces from VPS-1 via WireGuard |
| `max_block_duration` | `5m` | Block rotation interval |
| `kvstore.store` | `inmemory` | Single-node setup |
| `replication_factor` | `1` | Single-node setup |
| Storage backend | `local` | Filesystem storage |
| `compactor` | NOT a valid key | Tempo 2.10 does not support `compactor` as a top-level config key |

### 4.8 Alert Rules

**File:** `/home/openclaw/monitoring/alerts.yml`

| Alert | Expression | Duration | Severity |
|-------|-----------|----------|----------|
| `OpenClawHostDown` | `up{job="node-exporter-openclaw"} == 0` | 2m | critical |
| `HighMemoryUsage` | Memory > 90% | 5m | warning |
| `HighDiskUsage` | Disk > 85% | 5m | warning |
| `HighCPUUsage` | CPU > 80% | 10m | warning |

### 4.9 Alertmanager

**Image:** `prom/alertmanager:latest`
**Container name:** `alertmanager`
**Binding:** `127.0.0.1:9093`
**Data:** `./data/alertmanager:/alertmanager` (owned by `65534:65534`)

**Config:** `/home/openclaw/monitoring/alertmanager.yml`

| Setting | Value |
|---------|-------|
| `resolve_timeout` | `5m` |
| Route group_by | `[alertname, host]` |
| `group_wait` | `10s` |
| `group_interval` | `10s` |
| `repeat_interval` | `1h` |
| Default receiver | `"default"` |

Webhooks, email, Slack/Discord integrations can be added to receivers.

### 4.10 Node Exporter (VPS-2)

**Image:** `prom/node-exporter:latest`
**Container name:** `node-exporter`
**Binding:** `127.0.0.1:9100`
**Network:** host

Provides VPS-2 host metrics. Scraped by local Prometheus.

### 4.11 cAdvisor

**Image:** `gcr.io/cadvisor/cadvisor:latest`
**Container name:** `cadvisor`
**Binding:** `127.0.0.1:8080`

Provides container-level metrics (CPU, memory, network, disk per container). Scraped by local Prometheus.

### 4.12 Data Retention & Storage

| Service | Path | Retention | Ownership |
|---------|------|-----------|-----------|
| Prometheus | `./data/prometheus` | 30 days | `65534:65534` |
| Grafana | `./data/grafana` | N/A (config DB) | `472:root` |
| Loki | `./data/loki` | 30 days (720h) | `10001:10001` |
| Tempo | `./data/tempo` | Default | `10001:10001` |
| Alertmanager | `./data/alertmanager` | N/A (state) | `65534:65534` |

---

## 5. Key Ports & IPs Reference

### VPS-1 (10.0.0.1)

| Port | Binding | Service | Access |
|------|---------|---------|--------|
| 222/tcp | 0.0.0.0 | SSH | Public (key-only, adminclaw) |
| 51820/udp | 0.0.0.0 | WireGuard | Public (encrypted tunnel) |
| 18789/tcp | 0.0.0.0 | Gateway | Via Cloudflare Tunnel (not directly exposed) |
| 18790/tcp | 0.0.0.0 | Bridge API | Local |
| 9100/tcp | 0.0.0.0 | Node Exporter | WireGuard only (UFW rule) |
| 9080/tcp | host | Promtail | Local debugging |

### VPS-2 (10.0.0.2)

| Port | Binding | Service | Access |
|------|---------|---------|--------|
| 222/tcp | 0.0.0.0 | SSH | Public (key-only, adminclaw) |
| 51820/udp | 0.0.0.0 | WireGuard | Public (encrypted tunnel) |
| 9090/tcp | 10.0.0.2 | Prometheus | WireGuard only |
| 3000/tcp | 127.0.0.1 | Grafana | Via Cloudflare Tunnel |
| 3100/tcp | 10.0.0.2 | Loki HTTP | WireGuard only |
| 9096/tcp | 10.0.0.2 | Loki gRPC | WireGuard only |
| 3200/tcp | 127.0.0.1 | Tempo HTTP API | Local |
| 4318/tcp | 10.0.0.2 | Tempo OTLP | WireGuard only |
| 9093/tcp | 127.0.0.1 | Alertmanager | Local |
| 9100/tcp | 127.0.0.1 | Node Exporter | Local |
| 8080/tcp | 127.0.0.1 | cAdvisor | Local |

### Docker Networks (VPS-1)

| Network | Subnet | Type | Purpose |
|---------|--------|------|---------|
| `openclaw-gateway-net` | `172.30.0.0/24` | bridge, external | Gateway + supporting services |
| `openclaw-sandbox-net` | `172.31.0.0/24` | bridge, internal | Agent sandboxes (no internet) |

---

## 6. Known Issues & Critical Gotchas

### Security & Access
- **UsePAM must be `yes` on Ubuntu** — Setting it to `no` breaks SSH authentication entirely
- **Ubuntu systemd socket activation** — SSH port change requires both `sshd_config` AND systemd socket override
- **UFW before SSH port change** — Always configure UFW rules BEFORE changing SSH port to prevent lockout
- **adminclaw can't cd into `/home/openclaw/`** — Directory is 750. Use `sudo -u openclaw bash -c "cd ... && ..."` or `sudo sh -c 'cd ... && ...'`

### Container & Docker
- **`read_only: false` is required** for gateway container — Sysbox auto-mounts inherit this flag, and dockerd needs writable `/var/lib/docker`
- **`user: "0:0"` is required** — Sysbox maps uid 0 to unprivileged host uid. Entrypoint drops to node via gosu.
- **Container name is `openclaw-gateway`** (explicit `container_name`), not `openclaw-openclaw-gateway-1`
- **No `openclaw` binary on PATH** — Use `node dist/index.js` instead. Full: `sudo docker exec openclaw-gateway node dist/index.js <subcommand>`

### ESM/CJS Module Boundary
- Gateway runs as ESM (`"type": "module"` in package.json)
- `--require` files must use `.cjs` extension
- CJS `require()` and ESM `import` load different module instances — patch objects, not prototypes
- `@opentelemetry/api` uses `globalThis[Symbol.for()]` singleton — shared across CJS/ESM

### Build & Patching
- **Patches must go before `USER node`** in Dockerfile — npm/apt can't write to system dirs after user change
- **Failed builds leave patches in place** — `git checkout` cleanup only runs on success. Manually restore before retry.
- **`.env` values with spaces must be quoted** — `VAR=a b c` breaks `source .env`
- **`sed /i` with backslash continuations breaks Dockerfiles** — Use single-line RUN commands

### OTEL
- **No `endpoint` in openclaw.json** — Forces all signals to one destination, overriding per-signal env vars
- **Per-signal env vars are full URLs** — SDK does not append path for per-signal vars
- **No trace/metrics exporter log messages** — Plugin only logs for logs exporter. All three are initialized.
- **Dual-bundle fix required** — `diagnostic-events.ts` listeners Set must use `globalThis` to be shared across bundles

### UID & Ownership
- Host `ubuntu` is uid 1000, host `openclaw` is uid 1002. Container `node` is uid 1000.
- Container files in `.openclaw` are owned by uid 1000 (matches `ubuntu`, not `openclaw`)
- Sysbox remaps host uid 1000 to uid 1002 inside container — entrypoint `chown` fixes sandbox credentials
- Backups must run as root (uid 1000 files not readable by openclaw uid 1002)

### Tempo
- **Pin to `grafana/tempo:2.10.0`** — v3.0 pre-release requires Kafka
- **`compactor` is not a valid top-level key** in Tempo 2.10
- Must include `kvstore.store: inmemory` and `replication_factor: 1` for single-node

### Loki
- **HTTP and gRPC must bind to the same interface** — Different interfaces causes internal "connection refused"
- **`allow_structured_metadata: true` required** for OTLP log ingestion
- Schema v13 with tsdb store required by newer versions

### Grafana
- **Changing Loki datasource UID** requires wiping `./data/grafana/` — existing DB has auto-generated UID
- Use `tracesToLogsV2` not `tracesToLogs` (deprecated)

### Sandbox
- **Do NOT use `docker build -f - /dev/null`** in Sysbox — rejects `/dev/null` as build context
- **Do NOT use `docker run`/`docker commit`** — creates dirty layers. Use `docker build` with FROM.
- **Entrypoint heredocs via SSH** mangle shebangs — use `scp` instead
