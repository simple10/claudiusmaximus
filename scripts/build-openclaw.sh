#!/bin/bash
# Build OpenClaw with auto-patching for upstream issues.
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: copy extension package.json before pnpm install (upstream #7201)
#   2. OTEL extension: fix @opentelemetry v2.x API changes (upstream #3201)
#      a. Resource -> resourceFromAttributes (@opentelemetry/resources v2.x)
#      b. LoggerProvider constructor-based processors (@opentelemetry/sdk-logs v0.211+)
#   3. Diagnostic events: use globalThis for shared listener set (dual-bundle fix)
#      The diagnostic-events.ts module is bundled into both loader chunk and plugin-sdk,
#      creating two separate listener Sets. Using globalThis ensures they share one Set.
#   4. Dockerfile: install Claude Code CLI globally (@anthropic-ai/claude-code)
#   5. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#
# Usage: sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh
set -euo pipefail

cd /home/openclaw/openclaw

OTEL_SERVICE="extensions/diagnostics-otel/src/service.ts"

# ── 1. Patch Dockerfile for extension deps (upstream #7201) ──────────
if ! grep -q "extensions/diagnostics-otel/package.json" Dockerfile; then
  echo "[build] Patching Dockerfile for extension deps (upstream #7201)..."
  sed -i '/COPY scripts \.\/scripts/a COPY extensions/diagnostics-otel/package.json ./extensions/diagnostics-otel/package.json' Dockerfile
else
  echo "[build] Dockerfile already includes extension deps (upstream #7201 fixed or already patched)"
fi

# ── 2. Patch OTEL v2.x API compat (upstream #3201) ──────────────────
if grep -q "new Resource(" "$OTEL_SERVICE" 2>/dev/null; then
  echo "[build] Patching OTEL v2.x API: Resource -> resourceFromAttributes..."
  # 2a. Import: Resource -> resourceFromAttributes
  sed -i 's/import { Resource } from "@opentelemetry\/resources";/import { resourceFromAttributes } from "@opentelemetry\/resources";/' "$OTEL_SERVICE"
  # 2b. Usage: new Resource( -> resourceFromAttributes(
  sed -i 's/const resource = new Resource(/const resource = resourceFromAttributes(/' "$OTEL_SERVICE"
else
  echo "[build] OTEL Resource patch not needed (upstream fixed or already patched)"
fi

if grep -q "addLogRecordProcessor" "$OTEL_SERVICE" 2>/dev/null; then
  echo "[build] Patching OTEL v2.x API: LoggerProvider constructor-based processors..."
  # 2c. LoggerProvider: move processor from addLogRecordProcessor() to constructor
  python3 -c "
import sys
with open('$OTEL_SERVICE', 'r') as f:
    content = f.read()
old = '''        logProvider = new LoggerProvider({ resource });
        logProvider.addLogRecordProcessor(
          new BatchLogRecordProcessor(
            logExporter,
            typeof otel.flushIntervalMs === \"number\"
              ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
              : {},
          ),
        );'''
new = '''        logProvider = new LoggerProvider({
          resource,
          logRecordProcessors: [
            new BatchLogRecordProcessor(
              logExporter,
              typeof otel.flushIntervalMs === \"number\"
                ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
                : {},
            ),
          ],
        });'''
if old in content:
    content = content.replace(old, new)
    with open('$OTEL_SERVICE', 'w') as f:
        f.write(content)
    print('[build] LoggerProvider patch applied')
else:
    print('[build] WARNING: LoggerProvider pattern not found (upstream may have changed)')
    sys.exit(1)
"
else
  echo "[build] OTEL LoggerProvider patch not needed (upstream fixed or already patched)"
fi

# ── 3. Patch diagnostic events for shared listener Set (dual-bundle fix) ──
DIAG_EVENTS="src/infra/diagnostic-events.ts"
if grep -q "^const listeners = new Set" "$DIAG_EVENTS" 2>/dev/null; then
  echo "[build] Patching diagnostic-events.ts for shared globalThis listener Set..."
  sed -i 's/^const listeners = new Set<(evt: DiagnosticEventPayload) => void>();/const listeners = ((globalThis as any).__OPENCLAW_DIAG_LISTENERS__ ??= new Set<(evt: DiagnosticEventPayload) => void>()) as Set<(evt: DiagnosticEventPayload) => void>;/' "$DIAG_EVENTS"
else
  echo "[build] Diagnostic events patch not needed (upstream fixed or already patched)"
fi

# ── 4. Patch Dockerfile to install Claude Code CLI ────────────────────
if ! grep -q "@anthropic-ai/claude-code" Dockerfile; then
  echo "[build] Patching Dockerfile to install Claude Code CLI..."
  # Insert before USER (not CMD) so npm install runs as root
  sed -i '/^USER /i RUN npm install -g @anthropic-ai/claude-code' Dockerfile
else
  echo "[build] Claude Code CLI already in Dockerfile (already patched)"
fi

# ── 5. Patch Dockerfile to install Docker + gosu (nested Docker for sandboxes) ──
# docker.io includes: docker CLI, dockerd, containerd, runc
# gosu: drop-in replacement for su/sudo that doesn't spawn subshell (proper PID 1 signal handling)
# usermod: add node user to docker group for socket access after privilege drop
if ! grep -q "docker.io" Dockerfile; then
  echo "[build] Patching Dockerfile to install Docker + gosu..."
  # Insert before USER node so it runs as root
  # Single line to avoid sed multiline continuation issues in Dockerfile
  sed -i '/^USER /i RUN apt-get update && apt-get install -y --no-install-recommends docker.io gosu && usermod -aG docker node && rm -rf /var/lib/apt/lists/*' Dockerfile
else
  echo "[build] Docker already in Dockerfile (already patched)"
fi

# ── 6. Build image ───────────────────────────────────────────────────
echo "[build] Building openclaw:local..."
docker build \
  ${OPENCLAW_DOCKER_APT_PACKAGES:+--build-arg OPENCLAW_DOCKER_APT_PACKAGES="$OPENCLAW_DOCKER_APT_PACKAGES"} \
  -t openclaw:local .

# ── 7. Restore patched files (keep git working tree clean) ───────────
git checkout -- Dockerfile extensions/ src/infra/diagnostic-events.ts 2>/dev/null || true

echo "[build] Done. Run: docker compose up -d openclaw-gateway"
