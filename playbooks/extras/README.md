# Optional Features

This directory contains optional playbooks that enhance the deployment but are not required for core functionality.

## What Are Optional Features?

Optional features are enhancements that:
- Add convenience or additional capabilities
- Are not required for OpenClaw to function
- Can be added after initial deployment
- May have external dependencies (accounts, services)

## Difference from Base Playbooks

| Aspect | Base Playbooks (`01-07`) | Optional Features (`extras/`) |
|--------|--------------------------|-------------------------------|
| Required | Yes | No |
| Execution order | Sequential, numbered | Any time after deployment |
| Dependencies | Build on each other | Require base deployment complete |
| Naming | `XX-name.md` | `name.md` (no number) |

## Available Optional Features

*No optional features yet. Features will be added here as they're created.*

## Adding Optional Features

See [99-new-feature-planning.md](../99-new-feature-planning.md) for the process to plan and implement new optional features.
