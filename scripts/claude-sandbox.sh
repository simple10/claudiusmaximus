#!/usr/bin/env bash
# Start a Claude Code session inside the OpenClaw gateway.
#
# Claude Code's sandbox mode handles container isolation automatically,
# and ~/.claude is shared across all sandbox containers.
#
# Chain: local -> VPS (SSH) -> gateway (docker exec) -> claude (sandbox)
#
# Usage:
#   ./claude-session.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

GATEWAY="openclaw-gateway"

printf 'Start a Claude Code session in a remote sandbox on %s? [Y/n] ' "$VPS1_IP"
read -r CONFIRM
if [[ "$CONFIRM" =~ ^[Nn]$ ]]; then
  echo "Cancelled."
  exit 0
fi

printf '\033[32mConnecting to remote sandbox...\033[0m\n'
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" -t "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec -it $GATEWAY claude"
