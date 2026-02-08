# Playbooks

Deployment playbooks for Claude to execute. See `CLAUDE.md` for orchestration.

## User & Sudo

`adminclaw` user has passwordless sudo access.
Most setup commands will need to be executed via sudo.

`openclaw` user does not have passwordless sudo.

## Analysis Mode

For existing deployments, run `00-analysis-mode.md` first to verify current state before making changes.

## Execution Order

1. `01-base-setup.md` - VPS-1
2. `03-docker.md` - VPS-1
3. `04-vps1-openclaw.md` - VPS-1
4. `networking/<option>.md` - VPS-1 (based on `NETWORKING_OPTION`)
5. `06-backup.md` - VPS-1
6. `08-workers.md` - Deploy Cloudflare Workers (AI Gateway + Log Receiver)
7. Reboot VPS-1
8. `07-verification.md` - VPS-1 + Workers
9. `98-post-deploy.md` - First access & device pairing

## Archived Playbooks

These playbooks are from the two-VPS architecture (preserved in the `otel-v1` branch):

- `02-wireguard.md` - WireGuard tunnel (no longer used in single-VPS setup)
- `05-vps2-observability.md` - VPS-2 monitoring stack (replaced by Cloudflare Workers)

## Networking Options

- `networking/cloudflare-tunnel.md` - No certificates needed (recommended)
- `networking/caddy.md` - Requires Origin CA cert (see `docs/CLOUDFLARE-SSL.md`)

## Meta Playbooks

These playbooks guide Claude in extending the deployment:

- `99-new-feature-planning.md` - Process for planning new features
- `99-new-feature-implementation.md` - Process for implementing planned features

## Optional Features

The `extras/` directory contains optional playbooks that enhance the deployment but are not required for core functionality. See `extras/README.md` for details.

## Decommission

- `09-decommission-vps2.md` - Steps to decommission VPS-2 after migrating to single-VPS architecture
