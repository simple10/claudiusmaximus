# How OpenClaw's Browser Sandbox Works

  1. Host Install (Normal Setup — No Outer Container)

  When OpenClaw runs directly on the host OS (the documented default), it has direct access to the host's Docker daemon via
  /var/run/docker.sock.

  Architecture

```text
  ┌─────────────────────────────────────────────────────────┐
  │  HOST OS (Linux)                                        │
  │                                                         │
  │  ┌─────────────────────────────┐                        │
  │  │  OpenClaw Gateway Process   │                        │
  │  │  (node dist/index.js)       │                        │
  │  │                             │                        │
  │  │  spawn("docker", ["create", │──────┐                 │
  │  │    "--runtime=runc", ...])  │      │                 │
  │  └─────────────────────────────┘      │                 │
  │                                       ▼                 │
  │  ┌──────────────────────────────────────────────┐       │
  │  │  Docker Daemon (dockerd)                     │       │
  │  │  /var/run/docker.sock                        │       │
  │  │                                              │       │
  │  │  ┌──────────────────┐ ┌────────────────────┐ │       │
  │  │  │ Sandbox Container│ │ Browser Container  │ │       │
  │  │  │ openclaw-sbx-*   │ │ openclaw-sbx-      │ │       │
  │  │  │                  │ │ browser-*          │ │       │
  │  │  │ • sleep infinity │ │                    │ │       │
  │  │  │ • exec tools run │ │ • Xvfb :1          │ │       │
  │  │  │   inside here    │ │ • Chromium + CDP   │ │       │
  │  │  │                  │ │ • x11vnc           │ │       │
  │  │  │ network: none    │ │ • noVNC/websockify │ │       │
  │  │  │ read_only: true  │ │                    │ │       │
  │  │  │ cap_drop: ALL    │ │ Ports (localhost): │ │       │
  │  │  └──────────────────┘ │  9222 → CDP        │ │       │
  │  │                       │  5900 → VNC        │ │       │
  │  │                       │  6080 → noVNC      │ │       │
  │  │                       └────────────────────┘ │       │
  │  └──────────────────────────────────────────────┘       │
  └─────────────────────────────────────────────────────────┘
```

  Flow: Message Arrives → Sandbox Created → Browser Used

  User sends message via webchat
          │
          ▼
  Gateway receives message, starts agent run
          │
          ▼
  shouldSandboxSession() checks mode:
    "off"      → runtime: direct (no Docker)
    "non-main" → sandbox only sub-agents (not main)
    "all"      → sandbox everything
          │
          ▼ (if sandboxed)
  ensureSandboxContainer()
          │
          ├── dockerContainerState() → checks if container exists
          │     runs: spawn("docker", ["inspect", containerName])
          │
          ├── If missing: createSandboxContainer()
          │     runs: spawn("docker", ["create",
          │       "--name", "openclaw-sbx-<agent>-<hash>",
          │       "--read-only",
          │       "--tmpfs", "/tmp:size=500M",
          │       "--network", "none",
          │       "--cap-drop", "ALL",
          │       "--security-opt", "no-new-privileges",
          │       "--memory", "1g",
          │       "--pids-limit", "256",
          │       "--user", "1000:1000",
          │       "openclaw-sandbox-common:bookworm-slim",
          │       "sleep", "infinity"])
          │     then: spawn("docker", ["start", containerName])
          │
          ▼
  Agent runs tools inside sandbox via:
    spawn("docker", ["exec", containerName, "bash", "-c", command])
          │
          ▼ (if agent needs browser)
  ensureSandboxBrowserContainer()
          │
          ├── Creates browser container:
          │     spawn("docker", ["create",
          │       "--name", "openclaw-sbx-browser-<agent>-<hash>",
          │       "-p", "127.0.0.1::9222",    ← dynamic host port
          │       "-p", "127.0.0.1::6080",    ← dynamic host port
          │       "openclaw-sandbox-browser:bookworm-slim"])
          │     then: spawn("docker", ["start", ...])
          │
          ├── readDockerPort() → reads mapped host port
          │     spawn("docker", ["port", containerName, "9222"])
          │     returns e.g. "127.0.0.1:49152"
          │
          ▼
  Gateway connects to Chromium via CDP at 127.0.0.1:<mapped-port>
  Agent gets browser control URL + noVNC observer URL
  Control UI shows live browser view via noVNC WebSocket

  Image Build (One-Time Setup)

  The three images are built using scripts that call docker build:

  scripts/sandbox-setup.sh
    └── docker build -t openclaw-sandbox:bookworm-slim -f Dockerfile.sandbox .
          └── debian:bookworm-slim + bash, curl, git, jq, python3, ripgrep

  scripts/sandbox-common-setup.sh
    └── docker build -t openclaw-sandbox-common:bookworm-slim (heredoc Dockerfile)
          └── FROM openclaw-sandbox:bookworm-slim
              + Node.js, npm, pnpm, Bun, Python3, Go, Rust, Homebrew, build-essential

  scripts/sandbox-browser-setup.sh
    └── docker build -t openclaw-sandbox-browser:bookworm-slim -f Dockerfile.sandbox-browser .
          └── debian:bookworm-slim + Chromium, Xvfb, x11vnc, noVNC, socat, websockify

  On host, you just run these scripts once and the images are available to the Docker daemon that OpenClaw calls.

  Browser Container Internals

  When the browser container starts, the entrypoint (sandbox-browser-entrypoint.sh) does this:

  1. Start Xvfb virtual display on :1 (1280x800x24)
  2. Launch Chromium with CDP on 127.0.0.1:<internal-port>
     (--no-sandbox, --disable-dev-shm-usage, --user-data-dir=/tmp/...)
  3. Wait for CDP to be ready (poll /json/version)
  4. socat forwards 0.0.0.0:9222 → 127.0.0.1:<internal-port>
     (so the gateway can connect from outside the container)
  5. x11vnc captures the Xvfb display → VNC on port 5900
  6. websockify bridges VNC → WebSocket on port 6080 (noVNC)

  The gateway reads the dynamically mapped host ports via docker port and:

- Connects to Chromium via CDP for browser automation
- Passes the noVNC URL to the Control UI for live browser viewing

  ---

  1. Containerized Gateway (Our Setup — Docker + Sysbox)

  When OpenClaw runs inside a Docker container, it can't directly access the host's Docker daemon. Sysbox solves this by
  providing a nested Docker daemon inside the container.

  What Sysbox Does

  Sysbox is an OCI runtime (replaces runc) that makes containers behave like lightweight VMs. When a container runs with
  --runtime=sysbox-runc:

- The container gets its own /proc, /sys with proper isolation
- Systemd or Docker can run inside the container without --privileged
- A nested Docker daemon can start and manage its own containers
- The inner containers are isolated from the host Docker daemon

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │  HOST OS                                                         │
  │                                                                  │
  │  Docker Daemon (host)                                            │
  │  └── uses sysbox-runc runtime for openclaw-gateway container     │
  │                                                                  │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │  openclaw-gateway container (sysbox-runc)                  │  │
  │  │  Looks like a lightweight VM to processes inside           │  │
  │  │                                                            │  │
  │  │  ┌──────────────────────┐                                  │  │
  │  │  │ Inner Docker Daemon  │ ← must be installed + started    │  │
  │  │  │ (dockerd)            │                                  │  │
  │  │  │ /var/run/docker.sock │                                  │  │
  │  │  │                      │                                  │  │
  │  │  │  ┌────────────┐ ┌────────────────┐                      │  │
  │  │  │  │ Sandbox    │ │ Browser        │                      │  │
  │  │  │  │ Container  │ │ Container      │                      │  │
  │  │  │  │ (nested)   │ │ (nested)       │                      │  │
  │  │  │  │            │ │ Chromium+noVNC │                      │  │
  │  │  │  └────────────┘ └────────────────┘                      │  │
  │  │  └──────────────────────┘                                  │  │
  │  │                                                            │  │
  │  │  ┌──────────────────────────┐                              │  │
  │  │  │ OpenClaw Gateway Process │                              │  │
  │  │  │ spawn("docker", ...)     │──→ inner Docker daemon       │  │
  │  │  └──────────────────────────┘                              │  │
  │  └────────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │  Sysbox ensures the inner Docker is fully isolated from host     │
  └──────────────────────────────────────────────────────────────────┘
```

  The Missing Piece in Our Setup

  The critical point: Sysbox provides the capability to run Docker-in-Docker, but doesn't provide Docker itself. The container
  image must include dockerd and the docker CLI. Here's what we have vs. what's needed:

  What our gateway image has:           What's needed for sandbox:
  ─────────────────────────────        ──────────────────────────────
  ✅ node:22-bookworm base              ✅ node:22-bookworm base
  ✅ OpenClaw gateway code              ✅ OpenClaw gateway code
  ✅ ffmpeg, imagemagick, gcc           ✅ ffmpeg, imagemagick, gcc
  ✅ Claude Code CLI                    ✅ Claude Code CLI
  ❌ (no Docker CLI)                    ✅ docker CLI (/usr/bin/docker)
  ❌ (no Docker daemon)                 ✅ dockerd (/usr/bin/dockerd)
  ❌ (no containerd)                    ✅ containerd
  ❌ (no init to start dockerd)         ✅ startup script for dockerd

  Without Docker installed inside the container, this is what happens:

  Message arrives
       │
       ▼
  Gateway calls spawn("docker", ["create", ...])
       │
       ▼
  OS looks for "docker" binary in PATH
       │
       ▼
  Not found → EACCES / ENOENT
       │
       ▼
  Uncaught exception → PROCESS CRASH  ← This is what was happening

  With mode: "non-main", the main agent skips the Docker spawn, so no crash.

  How It Would Work (Once Docker Is Installed)

  If Docker were installed in the gateway image, the full flow would be:

```text
  ┌────────────────────────── Container Boot ──────────────────────────┐
  │                                                                    │
  │  1. Sysbox runtime starts the container                            │
  │  2. Entrypoint script runs:                                        │
  │     a. Clean lock files                                            │
  │     b. Fix openclaw.json permissions                               │
  │     c. Start dockerd (or wait for Sysbox's auto-started one)       │
  │     d. Wait for Docker socket at /var/run/docker.sock              │
  │     e. Build sandbox images if missing:                            │
  │        • docker build -t openclaw-sandbox:bookworm-slim            │
  │          (from /app/Dockerfile.sandbox)                            │
  │        • /app/scripts/sandbox-common-setup.sh                      │
  │          (builds openclaw-sandbox-common:bookworm-slim)            │
  │        • /app/scripts/sandbox-browser-setup.sh                     │
  │          (builds openclaw-sandbox-browser:bookworm-slim)           │
  │     f. exec "$@" → start gateway                                   │
  │                                                                    │
  │  3. Gateway starts, detects Docker available                       │
  │     → sandbox runtime: "sandboxed" (not "direct")                  │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘

  ┌────────────────────── Message Processing ──────────────────────────┐
  │                                                                    │
  │  User message → Gateway agent run                                  │
  │       │                                                            │
  │       ▼                                                            │
  │  spawn("docker", ["create", ...]) → inner dockerd creates nested   │
  │  container from openclaw-sandbox-common:bookworm-slim              │
  │       │                                                            │
  │       ▼                                                            │
  │  Agent tools (exec, read, write, etc.) run inside nested container │
  │       │                                                            │
  │       ▼ (if browser needed)                                        │
  │  spawn("docker", ["create", ...]) → inner dockerd creates browser  │
  │  container from openclaw-sandbox-browser:bookworm-slim             │
  │       │                                                            │
  │       ▼                                                            │
  │  Browser entrypoint starts: Xvfb → Chromium → socat → x11vnc →     │
  │  websockify                                                        │
  │       │                                                            │
  │       ▼                                                            │
  │  Gateway reads dynamic port via docker port → connects CDP         │
  │  Control UI gets noVNC WebSocket URL → shows live browser          │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘

  Full Nesting Diagram (What The Final Architecture Looks Like)

  ┌─ HOST (VPS-1) ─────────────────────────────────────────────────────────┐
  │                                                                        │
  │  Host Docker Daemon (dockerd)                                          │
  │  ├── runtime: sysbox-runc                                              │
  │  │                                                                     │
  │  ├── openclaw-gateway container ◄──────────────────────────────────┐   │
  │  │   │                                                             │   │
  │  │   │  ┌─ Inner Docker Daemon (nested, via Sysbox) ───-─────┐     │   │
  │  │   │  │                                                    │     │   │
  │  │   │  │  openclaw-sbx-main-abc123  (sandbox container)     │     │   │
  │  │   │  │  ├── image: openclaw-sandbox-common:bookworm-slim  │     │   │
  │  │   │  │  ├── network: none                                 │     │   │
  │  │   │  │  ├── read-only root, tmpfs /tmp                    │     │   │
  │  │   │  │  ├── cap-drop ALL                                  │     │   │
  │  │   │  │  └── runs: sleep infinity                          │     │   │
  │  │   │  │      (gateway exec's tools inside)                 │     │   │
  │  │   │  │                                                    │     │   │
  │  │   │  │  openclaw-sbx-browser-main-abc123                  │     │   │
  │  │   │  │  ├── image: openclaw-sandbox-browser:bookworm-slim │     │   │
  │  │   │  │  ├── ports: 127.0.0.1:49152→9222 (CDP)             │     │   │
  │  │   │  │  ├──        127.0.0.1:49153→6080 (noVNC)           │     │   │
  │  │   │  │  └── runs: Xvfb + Chromium + VNC + noVNC           │     │   │
  │  │   │  │                                                    │     │   │
  │  │   │  └────────────────────────────────────────────────────┘     │   │
  │  │   │                                                             │   │
  │  │   │  OpenClaw Gateway Process                                   │   │
  │  │   │  ├── Connects to inner Docker via /var/run/docker.sock      │   │
  │  │   │  ├── CDP to Chromium at 127.0.0.1:49152                     │   │
  │  │   │  └── Proxies noVNC through gateway port (18789)  ───────────┘   │
  │  │   │                                                                 │
  │  │   └── exposed: 0.0.0.0:18789 → gateway                              │
  │  │                                                                     │
  │  ├── cloudflared (systemd) → tunnels claw.ventureunknown.com           │
  │  │   └── forwards to localhost:18789                                   │
  │  │                                                                     │
  │  ├── node-exporter, promtail                                           │
  │  └──                                                                   │
  └────────────────────────────────────────────────────────────────────────┘
```

  Summary: What Needs to Happen
  ┌──────────────────────────┬────────────────────────┬───────────────────────────────┬───────────────────────────────────┐
  │          Aspect          │      Host Install      │ Our Container Setup (Current) │      Container Setup (Fixed)      │
  ├──────────────────────────┼────────────────────────┼───────────────────────────────┼───────────────────────────────────┤
  │ Docker daemon            │ Host's dockerd         │ None (missing)                │ Inner dockerd via Sysbox          │
  ├──────────────────────────┼────────────────────────┼───────────────────────────────┼───────────────────────────────────┤
  │ Docker CLI               │ Host's /usr/bin/docker │ None (missing)                │ Installed in image                │
  ├──────────────────────────┼────────────────────────┼───────────────────────────────┼───────────────────────────────────┤
  │ Sandbox images           │ Built once on host     │ Can't build (no Docker)       │ Built on first boot by entrypoint │
  ├──────────────────────────┼────────────────────────┼───────────────────────────────┼───────────────────────────────────┤
  │ sandbox.mode: "all"      │ Works                  │ Crashes (EACCES)              │ Works                             │
  ├──────────────────────────┼────────────────────────┼───────────────────────────────┼───────────────────────────────────┤
  │ sandbox.mode: "non-main" │ Sub-agents sandboxed   │ Main=direct, subs=crash       │ Sub-agents sandboxed              │
  ├──────────────────────────┼────────────────────────┼───────────────────────────────┼───────────────────────────────────┤
  │ Browser tool             │ Works via Docker       │ Unavailable                   │ Works via nested Docker           │
  ├──────────────────────────┼────────────────────────┼───────────────────────────────┼───────────────────────────────────┤
  │ Security isolation       │ Docker containers      │ None (direct mode)            │ Nested containers via Sysbox      │
  └──────────────────────────┴────────────────────────┴───────────────────────────────┴───────────────────────────────────┘
  To get sandbox and browser working in our containerized setup, the next step is to install Docker (CLI + daemon) inside the
  gateway image, either by:

  1. Adding docker.io to OPENCLAW_DOCKER_APT_PACKAGES and starting dockerd in the entrypoint, or
  2. Patching the Dockerfile to install Docker's official packages and add a dockerd startup step

  Want me to plan that implementation?
