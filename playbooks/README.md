# Playbooks

Deployment playbooks for Claude to execute. See `CLAUDE.md` for orchestration.

## User & Sudo

`adminclaw` user has passwordless sudo access.
Most setup commands will need to be executed via sudo.

`openclaw` user does not have passwordless sudo.

## Analysis Mode

For existing deployments, run `00-analysis-mode.md` first to verify current state before making changes.

## Execution Order

1. `01-base-setup.md` - Both VPSs
2. `02-wireguard.md` - Both VPSs
3. `03-docker.md` - Both VPSs
4. `04-vps1-openclaw.md` - VPS-1 only
5. `05-vps2-observability.md` - VPS-2 only
6. `networking/<option>.md` - Both VPSs (based on `NETWORKING_OPTION`)
7. `06-backup.md` - VPS-1 only
8. Reboot both VPSs
9. `07-verification.md` - Both VPSs
10. `98-post-deploy.md` - First access & device pairing (VPS-1)

## Networking Options

- `networking/cloudflare-tunnel.md` - No certificates needed
- `networking/caddy.md` - Requires Origin CA cert (see `docs/CLOUDFLARE-SSL.md`)

## Meta Playbooks

These playbooks guide Claude in extending the deployment:

- `99-new-feature-planning.md` - Process for planning new features
- `99-new-feature-implementation.md` - Process for implementing planned features

## Optional Features

The `extras/` directory contains optional playbooks that enhance the deployment but are not required for core functionality. See `extras/README.md` for details.
