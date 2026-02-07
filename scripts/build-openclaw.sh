#!/bin/bash
# Build OpenClaw with auto-patching for upstream issues.
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: copy extension package.json before pnpm install (upstream #7201)
#   2. OTEL extension: fix @opentelemetry v2.x API changes (upstream #3201)
#
# Usage: sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh
set -euo pipefail

cd /home/openclaw/openclaw

# ── 1. Patch Dockerfile for extension deps (upstream #7201) ──────────
if ! grep -q "extensions/diagnostics-otel/package.json" Dockerfile; then
  echo "[build] Patching Dockerfile for extension deps (upstream #7201)..."
  sed -i '/COPY scripts \.\/scripts/a COPY extensions/diagnostics-otel/package.json ./extensions/diagnostics-otel/package.json' Dockerfile
else
  echo "[build] Dockerfile already includes extension deps (upstream #7201 fixed or already patched)"
fi

# ── 2. Patch OTEL v2.x API compat (upstream #3201) ──────────────────
if grep -q "new Resource(" extensions/diagnostics-otel/src/service.ts 2>/dev/null; then
  echo "[build] Applying OTEL v2.x compatibility patch (upstream #3201)..."
  patch -p1 < /home/openclaw/patches/otel-v2-compat.patch
else
  echo "[build] OTEL v2.x patch not needed (upstream fixed or already patched)"
fi

# ── 3. Build image ───────────────────────────────────────────────────
echo "[build] Building openclaw:local..."
docker build -t openclaw:local .

# ── 4. Restore patched files (keep git working tree clean) ───────────
git checkout -- Dockerfile extensions/ 2>/dev/null || true

echo "[build] Done. Run: docker compose up -d openclaw-gateway"
