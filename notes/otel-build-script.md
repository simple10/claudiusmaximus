# How the build script works

  The script runs on VPS-1 inside the upstream OpenClaw git repo (/home/openclaw/openclaw). It:

  1. Patches source files in-place using sed/python3
  2. Builds the Docker image from the patched source (docker build -t openclaw:local .)
  3. Restores all patched files via git checkout so the working tree stays clean and future git pull won't conflict

  Every patch has a guard check — an if grep that tests whether the upstream code still has the bug. If upstream fixes the
  issue, the guard fails, the patch is skipped, and you see a "not needed" log line. No manual intervention required.

  ---
  Patch 1: Dockerfile extension deps (upstream #7201)

  What it solves: OpenClaw's Dockerfile has a two-phase copy strategy:

## Phase 1: copy package.json files, then install deps

  COPY package.json pnpm-lock.yaml ./
  COPY scripts ./scripts
  RUN pnpm install --frozen-lockfile

## Phase 2: copy all source code

  COPY . .

  Extensions live in extensions/diagnostics-otel/ and have their own package.json with dependencies (@opentelemetry/*
  packages). But the Dockerfile only copies the root package.json in phase 1 — the extension's package.json isn't there when
  pnpm install runs, so pnpm doesn't know about @opentelemetry/* deps and doesn't install them. The extension compiles fine
  (TypeScript can resolve types) but crashes at runtime with missing modules.

  What it does: Inserts one line after COPY scripts ./scripts:

  COPY extensions/diagnostics-otel/package.json ./extensions/diagnostics-otel/package.json

  Now pnpm sees the extension's dependencies during install.

  Guard check: grep -q "extensions/diagnostics-otel/package.json" Dockerfile — if the Dockerfile already mentions this file
  (upstream fixed it), the patch is skipped.

  When it's no longer needed: When upstream's Dockerfile copies extension package.json files before the pnpm install step. The
  guard detects this automatically.

  ---
  Patch 2a+2b: OTEL v2.x API changes (upstream #3201)

  What it solves: The diagnostics-otel extension was written against @opentelemetry/resources v1.x and @opentelemetry/sdk-logs
  < v0.211. The container ships newer versions that have breaking changes:

  2a — Resource class removed: @opentelemetry/resources v2.x removed the Resource class entirely. The replacement is a function
   resourceFromAttributes() that returns the same object.

  // Old (broken):
  import { Resource } from "@opentelemetry/resources";
  const resource = new Resource({ "service.name": "..." });

  // New (working):
  import { resourceFromAttributes } from "@opentelemetry/resources";
  const resource = resourceFromAttributes({ "service.name": "..." });

  The sed commands replace the import statement and the constructor call.

  2b — addLogRecordProcessor() removed: @opentelemetry/sdk-logs v0.211+ removed the method
  LoggerProvider.addLogRecordProcessor(). Processors must now be passed in the constructor:

  // Old (broken):
  logProvider = new LoggerProvider({ resource });
  logProvider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter, opts));

  // New (working):
  logProvider = new LoggerProvider({
    resource,
    logRecordProcessors: [new BatchLogRecordProcessor(exporter, opts)],
  });

  This is a multi-line replacement, so it uses a Python script that does exact string matching and replacement (sed can't
  reliably handle multi-line patterns).

  Guard checks:

- 2a: grep -q "new Resource(" "$OTEL_SERVICE" — skips when upstream stops using new Resource(
- 2b: grep -q "addLogRecordProcessor" "$OTEL_SERVICE" — skips when upstream stops using that method

  When they're no longer needed: When upstream updates the extension to use the v2.x API. There's already a PR (#4255) for
  this. Guards detect it automatically.

  ---
  Patch 3: Diagnostic events dual-bundle fix

  What it solves: This is the most subtle bug. OpenClaw's build system (likely Vite/Rollup) bundles the source into multiple
  output chunks:

- dist/loader-<hash>.js — the gateway core (message dispatch, session management, etc.)
- dist/plugin-sdk/index.js — the plugin runtime that extensions import from

  Both chunks include code from src/infra/diagnostic-events.ts, which has this module-level variable:

  const listeners = new Set<(evt: DiagnosticEventPayload) => void>();

  export function emitDiagnosticEvent(evt) { listeners.forEach(cb => cb(evt)); }
  export function onDiagnosticEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); }

  After bundling, the loader chunk gets its own copy (listeners$3 = new Set()) and the plugin-sdk gets a separate copy
  (listeners = new Set()). They are completely independent Sets in memory. When the gateway calls emitDiagnosticEvent(), it
  iterates the loader's Set. When the OTEL plugin calls onDiagnosticEvent(), it registers on the plugin-sdk's Set. Events never
   bridge the gap — the plugin callback is never invoked.

  This means zero traces, zero metrics, and zero OTEL logs from diagnostic events.

  What it does: Replaces the module-level Set with a globalThis-backed singleton:

  // Before:
  const listeners = new Set<(evt: DiagnosticEventPayload) => void>();

  // After:
  const listeners = ((globalThis as any).__OPENCLAW_DIAG_LISTENERS__ ??= new Set<(evt: DiagnosticEventPayload) => void>()) as
  Set<(evt: DiagnosticEventPayload) => void>;

  The ??= (nullish coalescing assignment) ensures the first chunk to execute creates the Set on globalThis, and the second
  chunk reuses it. Both bundles now share one Set, so events emitted by the gateway reach the plugin's listener.

  Guard check: grep -q "^const listeners = new Set" "$DIAG_EVENTS" — only patches if the line starts with the un-fixed pattern.

  When it's no longer needed: When upstream either:

- Uses globalThis (or a similar singleton pattern) for the listeners Set
- Restructures the build so diagnostic-events.ts isn't duplicated across chunks
- Moves to a different event dispatch mechanism (e.g., EventEmitter, or a shared module that isn't tree-shaken into both
  bundles)

  The guard detects all of these because the specific const listeners = new Set line at the start of the file would no longer
  exist.

  ---
  Detecting when patches are no longer needed

  The build script does this automatically at build time. After git pull, each guard check runs against the fresh upstream
  source. You'll see it in the build output:

## All patches still needed

  [build] Patching Dockerfile for extension deps (upstream #7201)...
  [build] Patching OTEL v2.x API: Resource -> resourceFromAttributes...
  [build] Patching OTEL v2.x API: LoggerProvider constructor-based processors...
  [build] Patching diagnostic-events.ts for shared globalThis listener Set...

## After upstream fixes #7201

  [build] Dockerfile already includes extension deps (upstream #7201 fixed or already patched)
  [build] Patching OTEL v2.x API: Resource -> resourceFromAttributes...
  ...

## After all fixes

  [build] Dockerfile already includes extension deps (upstream #7201 fixed or already patched)
  [build] OTEL Resource patch not needed (upstream fixed or already patched)
  [build] OTEL LoggerProvider patch not needed (upstream fixed or already patched)
  [build] Diagnostic events patch not needed (upstream fixed or already patched)

  When all four lines say "not needed", every patch has become a no-op. The build script itself is harmless to keep around (the
   guards make it safe), but at that point you could simplify to just docker build -t openclaw:local . directly.

  To manually check without building:

## SSH to VPS-1, pull latest

  sudo -u openclaw bash -c "cd /home/openclaw/openclaw && git pull"

## Check each guard

  grep -q "extensions/diagnostics-otel/package.json" /home/openclaw/openclaw/Dockerfile && echo "Patch 1: FIXED upstream" ||
  echo "Patch 1: still needed"
  grep -q "new Resource(" /home/openclaw/openclaw/extensions/diagnostics-otel/src/service.ts && echo "Patch 2a: still needed"
  || echo "Patch 2a: FIXED upstream"
  grep -q "addLogRecordProcessor" /home/openclaw/openclaw/extensions/diagnostics-otel/src/service.ts && echo "Patch 2b: still
  needed" || echo "Patch 2b: FIXED upstream"
  grep -q "^const listeners = new Set" /home/openclaw/openclaw/src/infra/diagnostic-events.ts && echo "Patch 3: still needed"
  || echo "Patch 3: FIXED upstream"

  Removal process once all patches are confirmed fixed upstream:

  1. Simplify build-openclaw.sh to just docker build -t openclaw:local . + remove the git checkout restore step
  2. Delete patches/otel-v2-compat.patch (reference doc)
  3. Update the playbook sections 4.8a and 4.8b
  4. The per-signal env vars and docker-compose.override.yml remain unchanged (those are our routing config, not patches)
