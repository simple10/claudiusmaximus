# Changelog

This is a summary log of major changes and the plans they implemented.

---

## OTEL Patches

Plan: otel-tracing.md
Date: Feb 6, 2026

It took hours of trial and error modifications to get OTEL patches to work.
Traces are now being sent to Tempo. The root issue is related to several
open issues with upstream openclaw.

The current patch implementation should be removed as soon as openclaw fixes
the upstream issues. See comments in patches/

Traces still do not include full conversation history. Only the token metrics
and metadata.

Claude Summary:

  1. Traces confirmed working - The globalThis dual-bundle fix works. Before the per-signal routing change, Tempo received 6
  traces (openclaw.message.processed and openclaw.model.usage) from webchat messages.
  2. Per-signal routing configured - Changed from single endpoint (all→Tempo) to per-signal env vars:
    - Traces → Tempo (4318)
    - Metrics → Prometheus (9090)
    - Logs → Loki (3100)
  3. Files updated locally:
    - playbooks/04-vps1-openclaw.md — Updated build script with patch #3 (diagnostic events), fixed OTEL env vars in override,
  updated patch reference docs
    - patches/otel-v2-compat.patch — Updated reference doc with all 3 patches
    - MEMORY.md — Updated OTEL routing and traces status
  4. Files updated on VPS-1:
    - docker-compose.override.yml — Per-signal OTEL env vars, removed OTEL_LOG_LEVEL=DEBUG
    - openclaw.json — Removed endpoint field from diagnostics.otel

  What needs verification — Send a webchat message so we can confirm all three signals (traces→Tempo, metrics→Prometheus,
  logs→Loki) work with the per-signal routing.
