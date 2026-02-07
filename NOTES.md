# Working Notes

These are research notes that document various concerns & research findings.

## OpenClaw Update

Our current setup does not support `openclaw update` due to .git/ not being in the container.
The /app source dir is also not bind mounted to the container, so any updates would not survive
restart. However, we don't really need openclaw update if we're building from source on the host
when creating the Docker container image.

What openclaw update is

  It's a convenience wrapper around git pull + pnpm install + pnpm build + gateway restart. That's it. It:

  1. Fetches latest code via git (requires .git)
  2. Rebases to the selected channel (stable/beta/dev)
  3. Installs deps and rebuilds
  4. Restarts the gateway

  It does not manage extensions, sandbox images, or any runtime configuration. It's purely a core code updater.

  What works perfectly WITHOUT openclaw update

  Everything you listed works independently of the update mechanism:
  ┌─────────────────────────────────┬────────────────────────────────────────────────────────────────────┬────────────────────┐
  │           Capability            │                            How it works                            │  Needs openclaw    │
  │                                 │                                                                    │      update?       │
  ├─────────────────────────────────┼────────────────────────────────────────────────────────────────────┼────────────────────┤
  │ Install extensions              │ plugins.load.paths in openclaw.json + restart                      │ No                 │
  ├─────────────────────────────────┼────────────────────────────────────────────────────────────────────┼────────────────────┤
  │ Build custom containers         │ Agent uses Sysbox nested Docker: docker build -t                   │ No                 │
  │ (ffmpeg, etc.)                  │ openclaw-sandbox-ffmpeg .                                          │                    │
  ├─────────────────────────────────┼────────────────────────────────────────────────────────────────────┼────────────────────┤
  │ Run sandbox containers          │ Config: agents.defaults.sandbox.docker.image                       │ No                 │
  ├─────────────────────────────────┼────────────────────────────────────────────────────────────────────┼────────────────────┤
  │ Install packages in sandboxes   │ Config: sandbox.docker.setupCommand: "apt-get install -y ffmpeg"   │ No                 │
  ├─────────────────────────────────┼────────────────────────────────────────────────────────────────────┼────────────────────┤
  │ Modify config at runtime        │ Agent edits openclaw.json + SIGUSR1 restart (commands.restart:     │ No                 │
  │                                 │ true)                                                              │                    │
  ├─────────────────────────────────┼────────────────────────────────────────────────────────────────────┼────────────────────┤
  │ Manage channels                 │ CLI: openclaw-cli channels add ...                                 │ No                 │
  ├─────────────────────────────────┼────────────────────────────────────────────────────────────────────┼────────────────────┤
  │ Sandbox image management        │ openclaw sandbox recreate --all, docker pull/tag                   │ No                 │
  ├─────────────────────────────────┼────────────────────────────────────────────────────────────────────┼────────────────────┤
  │ Browser sandbox                 │ Config: agents.defaults.sandbox.browser.enabled: true              │ No                 │
  └─────────────────────────────────┴────────────────────────────────────────────────────────────────────┴────────────────────┘
  What DOES require a host-level rebuild

  Only two things:

  1. Core code updates (new OpenClaw release) — git pull + build script + compose up
  2. System packages in the gateway image (not sandboxes) — rebuild with OPENCLAW_DOCKER_APT_PACKAGES

  Both are handled by our build script from the host. The official GCP/VPS docs recommend the same host-level approach: git
  pull && docker compose build && docker compose up -d.

  Bottom line

  You're not losing any runtime capability. openclaw update is just a dev-convenience for non-Docker installs. All the
  power-user features (extensions, custom containers, sandbox building, config management) operate at the runtime/config level,
   not the code-update level. Manual host-level rebuilds via the build script are the standard Docker pattern and what OpenClaw
   officially recommends for VPS deployments.
