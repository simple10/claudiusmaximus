# Observability & Monitoring Guide

This document explains how the OpenClaw observability stack works, how to access it, and how to use it for troubleshooting and monitoring.

## Overview

The observability stack runs on VPS-2 and collects three types of telemetry data from VPS-1 (where OpenClaw runs):

| Signal | What it captures | Storage | Retention |
|--------|-----------------|---------|-----------|
| **Metrics** | CPU, memory, disk, container stats, scrape targets | Prometheus | 30 days |
| **Logs** | Container stdout/stderr, system logs, OTEL application logs | Loki | 30 days |
| **Traces** | Distributed request traces (API calls, model invocations) | Tempo | Default (disk-based) |

All data is visualized through **Grafana**, accessible at:

https://<DOMAIN_GRAFANA>/_observe/grafana/

---

## Architecture Overview

This diagram shows a high level view of the observability system.
All services are running in Docker containers.

```text
┌─────────────────────────────────────────────────────────┐
│  docker-compose (host)                                  │
│                                                         │
│  ┌─────────────────────-─┐     ┌─────────────────────-┐ │
│  │  openclaw-gateway     │────▶│  otel-collector      │ │
│  │  (sysbox runtime)     │     │  (OTLP HTTP :4318)   │ │
│  │                       │     └──────┬───┬───┬───────┘ │
│  │  ┌─────────────────-┐ │            │   │   │         │
│  │  │ nested docker    │ │            │   │   │         │
│  │  │ (sandbox ctrs)   │ │            ▼   ▼   ▼         │
│  │  └─────────────────-┘ │     ┌─────┐ ┌───┐ ┌────┐     │
│  └─────────────────────-─┘     │Tempo│ │Pro│ │Loki│     │
│                                └──┬──┘ └─┬─┘ └──┬─┘     │
│                                   │      │      │       │
│                               ┌-──▼──────▼──────▼─-┐    │
│                               │     Grafana        │    │
│                               │     :3000          │    │
│                               └────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Architecture Details

```text
VPS-1 (OpenClaw)                          VPS-2 (Observability)
 10.0.0.1                                  10.0.0.2
┌────────────────────────┐                ┌────────────────────────────────┐
│                        │                │                                │
│  OpenClaw Gateway      │    traces      │  Tempo (:4318)                 │
│  ┌──────────────────┐  │──OTLP/HTTP────>│  └─ stores distributed traces  │
│  │ diagnostics-otel │  │                │                                │
│  │ plugin           │  │    metrics     │  Prometheus (:9090)            │
│  └──────────────────┘  │──OTLP/HTTP────>│  └─ stores time-series metrics │
│                        │                │                                │
│                        │     logs       │  Loki (:3100)                  │
│  Promtail              │──push────────> │  └─ stores log streams         │
│  └─ ships container    │                │                                │
│     logs to Loki       │                │  Alertmanager (:9093)          │
│                        │                │  └─ routes alert notifications │
│  Node Exporter (:9100) │                │                                │
│  └─ exposes system     │<──scrape───────│  Grafana (:3000)               │
│     metrics            │                │  └─ dashboards & exploration   │
│                        │                │                                │
└────────────────────────┘                │  Node Exporter (:9100)         │
         ▲                                │  cAdvisor (:8080)              │
         │                                │  └─ local system & container   │
     WireGuard Tunnel (encrypted)         │     metrics                    │
         │                                │                                │
         └────────────────────────────────└────────────────────────────────┘
```

### Data Flow Summary

```text
                    ┌─────────────┐
                    │  OpenClaw   │
                    │  Gateway    │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
         ┌─────────┐ ┌─────────┐ ┌─────────┐
         │  Tempo  │ │Promethe-│ │  Loki   │
         │ (traces)│ │us(metrics)│ │ (logs)│
         └────┬────┘ └────┬────┘ └────┬────┘
              │           │           │
              └───────────┼──-────────┘
                          │
                    ┌─────▼─────┐
                    │  Grafana  │
                    │ (explore  │
                    │  & dash-  │
                    │  boards)  │
                    └─────┬─────┘
                          │
                  ┌──--───▼──--──-─┐
                  │ Alertmanager   │
                  │(notifications) │
                  └-----───────────┘
```

### Two Sources of Logs

Loki receives logs from **two complementary sources**:

| Source | What it captures | Labels | Use case |
|--------|-----------------|--------|----------|
| **Promtail** | Raw container stdout/stderr, system logs | `host`, `job`, `filename` | Startup errors, crashes, system events |
| **OTEL** | Structured application logs with trace correlation | `service_name` | Application-level debugging with trace context |

This is intentional — Promtail catches everything (including crashes before the app starts), while OTEL logs provide richer structured context for application-level debugging.

---

## Accessing Grafana

1. Navigate to `https://<DOMAIN_GRAFANA>/_observe/grafana/`
2. Authenticate through Cloudflare Access (GitHub login)
3. Log in to Grafana (default user: `admin`)

### Navigating to Explore

The **Explore** page is where you run ad-hoc queries across all three datasources:

1. Click **Explore** in the left sidebar
2. Use the **datasource picker** (top-left, next to the datasource logo) to switch between:
   - **Loki** — for log queries
   - **Prometheus** — for metric queries
   - **Tempo** — for trace queries

---

## Logs (Loki)

### How to Query Logs

1. Go to **Explore** and select the **Loki** datasource
2. Switch to **Code** mode (top-right of the query editor) for full LogQL syntax
3. Enter a query and click **Run query** (or press `Shift+Enter`)

### LogQL Basics

LogQL queries start with a **stream selector** (labels in curly braces), optionally followed by **filters**:

```logql
{label="value"} |= "search text"
```

### Available Labels

| Label | Values | Description |
|-------|--------|-------------|
| `host` | `openclaw`, `observe` | Which VPS the log came from |
| `job` | `docker`, `varlogs` | Log source type |
| `filename` | `/var/log/...` | Source file path |
| `service_name` | `openclaw-gateway` | OTEL application logs only |

### Example Queries

#### All logs from OpenClaw VPS

```logql
{host="openclaw"}
```

#### Search for errors in gateway logs

```logql
{host="openclaw"} |= "error" != "UFW BLOCK"
```

#### Search for a specific connection ID

```logql
{host="openclaw"} |= "conn=abc12345"
```

#### WebSocket connection issues

```logql
{host="openclaw"} |= "[ws]" |= "unauthorized"
```

#### UFW firewall blocks (security audit)

```logql
{host="openclaw"} |= "UFW BLOCK"
```

#### OTEL application logs (structured, with trace context)

```logql
{service_name="openclaw-gateway"}
```

#### Logs from the last 15 minutes with severity filtering

```logql
{host="openclaw"} | logfmt | level = "error"
```

#### Count log lines per minute (for spotting spikes)

```logql
count_over_time({host="openclaw"}[1m])
```

#### Top error messages

```logql
{host="openclaw"} |= "error" | pattern "<_> <level> <msg>" | line_format "{{.msg}}" | topk(10, count_over_time({host="openclaw"} |= "error" [1h]))
```

### Tips

- Use the **Logs volume** histogram above the results to spot activity spikes
- Click any log line to expand it and see all labels
- Use the **Live** button (top-right) to tail logs in real-time
- The sidebar shows available fields — click a field to add it as a filter

---

## Metrics (Prometheus)

### How to Query Metrics

1. Go to **Explore** and select the **Prometheus** datasource
2. Switch to **Code** mode for full PromQL syntax
3. Enter a query and click **Run query**

### Scrape Targets

Prometheus scrapes these targets every 15 seconds:

| Job | Target | Host | What it monitors |
|-----|--------|------|-----------------|
| `prometheus` | `10.0.0.2:9090` | VPS-2 | Prometheus itself |
| `node-exporter-local` | `127.0.0.1:9100` | VPS-2 | VPS-2 system metrics |
| `node-exporter-openclaw` | `10.0.0.1:9100` | VPS-1 | VPS-1 system metrics (over WireGuard) |
| `cadvisor-local` | `127.0.0.1:8080` | VPS-2 | VPS-2 container metrics |

### Example Queries

#### Check all targets are healthy

```promql
up
```

Returns `1` for healthy, `0` for down. All four targets should show `1`.

#### CPU usage per VPS (percentage)

```promql
100 - (avg by(host) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
```

#### Memory usage per VPS (percentage)

```promql
(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100
```

#### Disk usage per VPS (percentage)

```promql
(1 - node_filesystem_avail_bytes{fstype!="tmpfs",mountpoint="/"} / node_filesystem_size_bytes{fstype!="tmpfs",mountpoint="/"}) * 100
```

#### Network traffic (bytes received per second)

```promql
irate(node_network_receive_bytes_total{device="ens3"}[5m])
```

#### Container memory usage (VPS-2 monitoring stack)

```promql
container_memory_usage_bytes{name=~".+"}
```

#### Container CPU usage (VPS-2 monitoring stack)

```promql
rate(container_cpu_usage_seconds_total{name=~".+"}[5m])
```

#### Prometheus storage size

```promql
prometheus_tsdb_storage_size_bytes
```

#### Check if any alerts are firing

```promql
ALERTS{alertstate="firing"}
```

### Tips

- Use the **Metrics browser** button to browse all available metric names
- Click the graph legend to isolate a single series
- Change the time range (top-right) to zoom in/out
- Use `rate()` for counters and `irate()` for instant rate

---

## Traces (Tempo)

### How to Query Traces

1. Go to **Explore** and select the **Tempo** datasource
2. Choose a query type:
   - **Search** — form-based search (easier for beginners)
   - **TraceQL** — query language (more powerful)
   - **Service Graph** — visual service dependency map
3. Enter a query and click **Run query**

### When Do Traces Appear?

Traces are generated when the OpenClaw gateway processes real user activity:

- API calls
- Model invocations
- Webhook processing
- Chat interactions

An idle gateway produces no traces. The `sampleRate` is set to `0.2` (20% of requests are traced) to minimize overhead.

### TraceQL Example Queries

#### All traces from OpenClaw

```traceql
{ resource.service.name = "openclaw-gateway" }
```

#### Traces longer than 5 seconds (slow requests)

```traceql
{ resource.service.name = "openclaw-gateway" && duration > 5s }
```

#### Traces with errors

```traceql
{ resource.service.name = "openclaw-gateway" && status = error }
```

#### Traces for a specific span name

```traceql
{ resource.service.name = "openclaw-gateway" && name = "HTTP GET" }
```

### Using Search Mode

If TraceQL feels complex, use the **Search** tab instead:

1. Select **Service Name**: `openclaw-gateway`
2. Optionally filter by **Span Name**, **Duration**, or **Status**
3. Click **Run query**

Results show a table of matching traces. Click any trace to see the full waterfall view with timing breakdown.

### Trace-to-Log Correlation

Tempo is configured with `tracesToLogsV2` linking to Loki. When viewing a trace:

1. Click on any span in the trace waterfall
2. Look for the **Logs** link/button
3. This jumps to Loki with the time range and trace ID pre-filled

This lets you see exactly what the application logged during that specific request.

---

## Alerting

### How Alerting Works

```
Prometheus                    Alertmanager              Notification
┌──────────────┐             ┌──────────────┐          ┌──────────────┐
│ Evaluates    │   fires     │ Groups &     │  sends   │ Slack,       │
│ alert rules  │────────────>│ deduplicates │─────────>│ Telegram,    │
│ every 15s    │             │ alerts       │          │ Email, etc.  │
└──────────────┘             └──────────────┘          └──────────────┘
                                                        (not yet
                                                         configured)
```

### Current Alert Rules

| Alert | Condition | Wait | Severity |
|-------|-----------|------|----------|
| **OpenClawHostDown** | VPS-1 node exporter unreachable | 2 min | critical |
| **TargetDown** | Any scrape target goes down | 1 min | critical |
| **HighMemoryUsage** | Memory usage > 90% | 5 min | warning |
| **HighDiskUsage** | Disk usage > 85% | 5 min | warning |
| **HighCPUUsage** | CPU usage > 80% | 10 min | warning |

### Checking Alert Status

#### In Grafana

Navigate to **Alerting** in the left sidebar to see all alert rules and their current state.

#### Via Prometheus Query

```promql
ALERTS
```

Shows all currently firing alerts. If empty, everything is healthy.

#### Via Alertmanager

Alertmanager UI is available internally at `http://localhost:9093` on VPS-2. It shows active alerts and silence configuration.

### Notification Destinations

Alertmanager currently has a `default` receiver with **no notification destination**. Alerts are tracked internally but not sent anywhere. To receive notifications, configure a receiver in `/home/openclaw/monitoring/alertmanager.yml` on VPS-2.

---

## Common Troubleshooting Scenarios

### "Is everything healthy?"

**Quick check** — run this Prometheus query:

```promql
up
```

All 4 targets should show value `1`. If any shows `0`, that service is down.

### "The gateway seems slow"

1. **Check CPU/memory** on VPS-1:

   ```promql
   100 - (avg by(host) (irate(node_cpu_seconds_total{mode="idle",host="openclaw"}[5m])) * 100)
   ```

2. **Check for slow traces** in Tempo:

   ```traceql
   { resource.service.name = "openclaw-gateway" && duration > 5s }
   ```

3. **Check gateway logs** for warnings:

   ```logql
   {host="openclaw"} |= "warn" != "UFW"
   ```

### "Users report errors"

1. **Search error logs**:

   ```logql
   {host="openclaw"} |= "error" != "UFW BLOCK"
   ```

2. **Check for error traces**:

   ```traceql
   { resource.service.name = "openclaw-gateway" && status = error }
   ```

3. **Check if any alerts are firing**:

   ```promql
   ALERTS{alertstate="firing"}
   ```

### "Is the server running out of disk?"

```promql
(1 - node_filesystem_avail_bytes{fstype!="tmpfs",mountpoint="/"} / node_filesystem_size_bytes{fstype!="tmpfs",mountpoint="/"}) * 100
```

Values above 85% will trigger the **HighDiskUsage** alert.

### "Is the WireGuard tunnel working?"

If the `node-exporter-openclaw` target is down:

```promql
up{job="node-exporter-openclaw"}
```

Value `0` likely means the WireGuard tunnel between VPS-1 and VPS-2 is down. SSH into each VPS and run `sudo wg show` to check.

### "What's hitting the firewall?"

```logql
{host="openclaw"} |= "UFW BLOCK" | pattern "<_> <_> kernel: [UFW BLOCK] <_> SRC=<src> DST=<dst> <_> DPT=<dport> <_>"
```

### "How much traffic is the gateway handling?"

Check WebSocket connection logs:

```logql
{host="openclaw"} |= "[ws]" |= "connect" != "closed before"
```

---

## Data Retention & Storage

| Component | Retention | Configured in |
|-----------|-----------|---------------|
| Prometheus | 30 days | `--storage.tsdb.retention.time=30d` |
| Loki | 30 days | `retention_period: 720h` in loki-config.yml |
| Tempo | Default (disk-based) | No explicit limit configured |

To check current storage usage, SSH into VPS-2 and run:

```bash
sudo docker system df -v | grep monitoring_
```

---

## OTEL Configuration

The OpenClaw gateway's OTEL settings are controlled via environment variables in `openclaw-config.env`:

| Setting | Default | Description |
|---------|---------|-------------|
| `OPENCLAW_OTEL_TRACES` | `true` | Enable trace export to Tempo |
| `OPENCLAW_OTEL_METRICS` | `true` | Enable metric export to Prometheus |
| `OPENCLAW_OTEL_LOGS` | `true` | Enable structured log export to Loki |
| `OPENCLAW_OTEL_SAMPLERATE` | `0.2` | Fraction of requests traced (0.0 to 1.0) |
| `OPENCLAW_OTEL_FLUSHINTERVAL` | `20000` | How often telemetry is flushed (ms) |

To adjust these settings, edit `openclaw-config.env` and restart the gateway on VPS-1:

```bash
cd /home/openclaw/openclaw
sudo -u openclaw docker compose up -d openclaw-gateway
```

### Disabling OTEL Entirely

Set all three signals to `false` in `openclaw-config.env`, then update `openclaw.json` on VPS-1:

```json
"diagnostics": {
  "enabled": false
}
```

Restart the gateway to apply.
