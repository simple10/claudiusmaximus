# OpenTelemetry Traces Not Exporting - Investigation Findings

**Date:** 2026-02-06
**Status:** Root cause identified - requires upstream fix

## Update 2026-02-06

OTEL was successfully implemented after hours of trial and error patching.
However, the traces (Tempo) are being captured by OTEL do not include message history by design.

If trace logs are enabled, the conversation history is captured in Loki.

With the data currently being captured, there's no way in Grafana to replicate
at LiteLLM style conversation trace.

```text
openclaw.message.processed — channel, outcome, sessionKey, sessionId, chatId, messageId, duration

openclaw.model.usage — channel, provider, model, sessionKey, sessionId, token counts
(input/output/cache_read/cache_write/total), duration

Metrics (counters/histograms, not traces) — token usage, cost (USD), run duration, context window usage, queue depth/wait,
webhook counts, session state transitions
```

---

## Previous Summary Analysis

OpenClaw's `diagnostics-otel` plugin successfully exports **logs** and **metrics** to their respective backends (Loki and Prometheus), but **trace spans are not being exported** to Tempo. Traces reach Tempo but are empty (`inspected_spans=0`).

## What Works ✅

1. **OTEL Logs**: Successfully exported to Loki via OTLP
   - Log exporter initializes correctly
   - Logs appear in Loki with proper attributes
   - Uses `registerLogTransport` to capture all gateway logs

2. **OTEL Metrics**: Successfully exported to Prometheus via OTLP
   - Metrics recorded via counters and histograms
   - Periodic export works (configured flush interval respected)
   - All diagnostic events generate metrics

3. **Infrastructure**: All components working correctly
   - ✅ WireGuard tunnel between VPS-1 and VPS-2
   - ✅ Tempo OTLP receiver listening on `10.0.0.2:4318`
   - ✅ Network connectivity confirmed (manual OTLP POST succeeds)
   - ✅ Configuration: `diagnostics.otel.endpoint = "http://10.0.0.2:4318"`
   - ✅ Plugin loads without errors

## What Doesn't Work ❌

**Trace spans are not exported to Tempo.**

Evidence:

- Tempo logs show: `inspected_traces=1 inspected_spans=0`
- Traces reach Tempo (confirmed via API and logs)
- Traces are empty - contain no span data
- Grafana Explore shows no traces when querying Tempo

## Root Cause Analysis

### The Issue

The `diagnostics-otel` plugin in `extensions/diagnostics-otel/src/service.ts` creates spans manually for diagnostic events (e.g., `message.processed`, `model.usage`, `webhook.processed`), but these spans are **not being captured** by the OpenTelemetry BatchSpanProcessor.

### Technical Details

**Current Implementation:**

```typescript
// Plugin creates NodeSDK with trace exporter
sdk = new NodeSDK({
  resource,
  ...(traceExporter ? { traceExporter } : {}),
  ...(metricReader ? { metricReader } : {}),
  ...(sampler ? { sampler } : {}),
});
sdk.start();

// Later, spans are created manually
const tracer = trace.getTracer("openclaw");
const span = tracer.startSpan("openclaw.message.processed", { attributes });
span.end();
```

**The Problem:**

1. `NodeSDK` is designed for **automatic instrumentation** of HTTP libraries, databases, etc.
2. When you pass a `traceExporter` to NodeSDK, it creates an internal TracerProvider with a BatchSpanProcessor
3. `NodeSDK.start()` registers this TracerProvider globally
4. BUT: The manual spans created via `trace.getTracer()` are **not being associated** with the TracerProvider that has the BatchSpanProcessor attached
5. Result: Spans are created but never reach the processor, so they're never exported

**Why Logs and Metrics Work:**

- **Logs**: Uses `LoggerProvider` with `BatchLogRecordProcessor` directly (not via NodeSDK)
  - `registerLogTransport` captures log output
  - Logs are emitted directly to the LoggerProvider
  - Works perfectly ✅

- **Metrics**: Uses `PeriodicExportingMetricReader` with direct meter access
  - Counters and histograms record directly to the MeterProvider
  - Reader periodically exports metrics
  - Works perfectly ✅

- **Traces**: Relies on NodeSDK's internal TracerProvider registration
  - Manual span creation via API doesn't integrate properly
  - BatchSpanProcessor never sees the spans
  - Broken ❌

## Investigation Timeline

### Initial Hypothesis

Suspected missing API key or incorrect endpoint configuration.

**Result:** API key was configured, endpoint configuration was correct (after adding `diagnostics.otel.endpoint`).

### Network Connectivity Tests

- ✅ Verified WireGuard tunnel: `ping 10.0.0.2` succeeds
- ✅ Verified OTLP endpoint: `curl http://10.0.0.2:4318/` returns 404 (expected)
- ✅ Verified Tempo receives OTLP: Manual trace POST accepted with 200 OK

### Configuration Fixes Applied

1. **Added base endpoint to config** (per OpenClaw's suggestion):

   ```json
   {
     "diagnostics": {
       "otel": {
         "endpoint": "http://10.0.0.2:4318",
         "traces": true,
         "metrics": true,
         "logs": true,
         "sampleRate": 1,
         "flushIntervalMs": 20000
       }
     }
   }
   ```

2. **Removed per-signal env vars** from `.env`:
   - Removed: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
   - Removed: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
   - Removed: `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
   - Reason: Config endpoint now used, SDK appends `/v1/traces`, `/v1/metrics`, `/v1/logs`

3. **Runtime patch applied** to check per-signal env var:

   ```typescript
   // Line 80 of patches-runtime/diagnostics-otel-service.ts
   const traceUrl = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
                    resolveOtelUrl(endpoint, "v1/traces");
   ```

### Attempted Fixes (Did Not Resolve Issue)

1. **Explicit BatchSpanProcessor creation**:

   ```typescript
   const spanProcessor = new BatchSpanProcessor(
     traceExporter,
     { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
   );
   sdk = new NodeSDK({
     resource,
     spanProcessor,  // Instead of traceExporter
     // ...
   });
   ```

   **Result:** Plugin failed to load due to missing `@opentelemetry/sdk-trace-node` package.

2. **Switched to BasicTracerProvider**:
   Attempted to replace NodeSDK with direct TracerProvider setup.
   **Result:** Introduced syntax errors, reverted.

3. **Debug logging**:
   Added console.log statements to verify span creation functions are called.
   **Result:** Syntax errors in patch file, OTEL plugin failed to load.

## Current State

- **Plugin loads successfully** with basic URL fix
- **Logs and metrics export normally**
- **Traces reach Tempo but contain zero spans**
- **Gateway operates normally** (chat, API calls, webhooks all work)

File: `/home/openclaw/openclaw/patches-runtime/diagnostics-otel-service.ts`
Config: `/home/node/.openclaw/openclaw.json` (inside container)

## Why Runtime Patches Have Limitations

The `patches-runtime` approach mounts TypeScript files over the extension source at runtime. While this works for simple fixes (like URL configuration), it has severe limitations for structural changes:

1. **Type safety**: No TypeScript compilation feedback
2. **Testing**: Can't validate changes before deployment
3. **Dependencies**: Can't add new package dependencies
4. **Complexity**: Multi-line regex replacements error-prone
5. **Debugging**: Syntax errors cause silent plugin load failures

## Recommendation: Upstream Fix Required

The `diagnostics-otel` plugin needs refactoring in the upstream OpenClaw repository:

### Issue to File with OpenClaw

**Title:** `diagnostics-otel` plugin: Traces reach OTLP backend but contain zero spans

**Description:**

The `diagnostics-otel` plugin successfully exports logs and metrics, but trace spans are not being exported. Traces reach the OTLP backend (confirmed via Tempo logs: `inspected_traces=1 inspected_spans=0`) but are empty.

**Environment:**

- OpenClaw version: `2026.2.4`
- OTEL exports: Logs ✅ Metrics ✅ Traces ❌
- Configuration:

  ```json
  {
    "diagnostics": {
      "otel": {
        "enabled": true,
        "endpoint": "http://10.0.0.2:4318",
        "traces": true,
        "metrics": true,
        "logs": true,
        "sampleRate": 1,
        "flushIntervalMs": 20000
      }
    }
  }
  ```

**Root Cause:**

The plugin uses `NodeSDK` with a `traceExporter`, but manual spans created via `trace.getTracer().startSpan()` in diagnostic event handlers (e.g., `recordMessageProcessed`, `recordModelUsage`) are not being captured by the BatchSpanProcessor.

**Proposed Fix:**

Create a `BasicTracerProvider` directly with `addSpanProcessor()`, then call `tracerProvider.register()` to set it as the global provider. This ensures manually created spans are captured by the span processor.

Example:

```typescript
const tracerProvider = new BasicTracerProvider({ resource, sampler });
tracerProvider.addSpanProcessor(
  new BatchSpanProcessor(traceExporter, { scheduledDelayMillis: flushIntervalMs })
);
tracerProvider.register();
```

### Alternative: Check Upstream for Existing Issues

Before filing, search the OpenClaw repository for existing issues related to:

- "diagnostics-otel traces"
- "OTLP trace export"
- "BatchSpanProcessor"
- "TracerProvider"

## Workarounds

### Option 1: Wait for Upstream Fix

Monitor OpenClaw releases for fixes to the `diagnostics-otel` plugin.

### Option 2: Fork and Patch Upstream

Fork the OpenClaw repository, apply the TracerProvider fix in `extensions/diagnostics-otel/src/service.ts`, and build a custom image.

**Pros:**

- Full control over the fix
- Proper TypeScript compilation
- Can run tests

**Cons:**

- Must maintain fork
- Must rebuild on upstream updates
- More complex deployment

### Option 3: Live Without Traces (Current State)

Continue using logs and metrics for observability. Diagnostic logs provide sufficient detail for most troubleshooting:

- Model usage logged: tokens, cost, duration
- Message processing logged: outcome, duration
- Session state transitions logged
- Queue depth and wait times logged

**Pros:**

- No additional work required
- Logs + metrics cover most use cases

**Cons:**

- No distributed tracing visualization
- Can't trace request flows across services
- Missing trace-to-logs correlation in Grafana

## Key Learnings

1. **OTEL plugin architecture matters**: Mixing NodeSDK (for auto-instrumentation) with manual span creation requires careful TracerProvider registration.

2. **Logs/Metrics ≠ Traces**: Just because logs and metrics work doesn't mean traces will work. They use different code paths.

3. **Runtime patches are limited**: For structural changes to plugin initialization, runtime TypeScript patches are too brittle. Upstream fixes or custom builds are better.

4. **Empty traces are valid OTLP**: Tempo accepts traces with zero spans as valid OTLP data. This can mask issues where span creation is broken.

5. **Per-signal env vars vs config endpoint**: The OTEL SDK supports both, but the diagnostics-otel plugin only checked the generic `OTEL_EXPORTER_OTLP_ENDPOINT` env var, not per-signal vars like `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`.

## Files Modified

### VPS-1: `/home/openclaw/openclaw/`

1. **`.env`**
   - Removed per-signal OTLP endpoint env vars
   - Added: `OTEL_LOG_LEVEL=DEBUG` (for debugging, can be removed)

2. **`patches-runtime/diagnostics-otel-service.ts`**
   - Line 80: Check per-signal env var first:

     ```typescript
     const traceUrl = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
                      resolveOtelUrl(endpoint, "v1/traces");
     ```

3. **Container config: `/home/node/.openclaw/openclaw.json`**

   ```json
   {
     "diagnostics": {
       "otel": {
         "enabled": true,
         "endpoint": "http://10.0.0.2:4318",
         "protocol": "http/protobuf",
         "serviceName": "openclaw-gateway",
         "traces": true,
         "metrics": true,
         "logs": true,
         "sampleRate": 1,
         "flushIntervalMs": 20000
       }
     }
   }
   ```

## Related Memory Notes

- **MEMORY.md**: Documents OTEL v2 compatibility patches, per-signal routing, and the fact that only "logs exporter enabled" message appears (traces/metrics exporters don't log initialization).

- **Upstream build simplification** (commit `7acc259`): Adds `scripts/build-openclaw.sh` and `patches/otel-v2-compat.patch` for build-time patching. Not yet deployed to VPS-1.

## Next Steps

1. ✅ Document findings (this file)
2. ⏳ File issue with OpenClaw upstream
3. ⏳ Monitor for upstream fix
4. ⏳ Consider fork + patch approach if upstream fix delayed
5. ⏳ Update MEMORY.md with reference to this investigation

## References

- OpenTelemetry JS SDK: <https://github.com/open-telemetry/opentelemetry-js>
- NodeSDK vs Manual Instrumentation: <https://opentelemetry.io/docs/instrumentation/js/manual/>
- BatchSpanProcessor configuration: <https://opentelemetry.io/docs/reference/specification/trace/sdk/#batching-processor>
- Tempo OTLP ingestion: <https://grafana.com/docs/tempo/latest/api_docs/#otlp>
