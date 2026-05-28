# Polaris Grafana dashboard

`polaris-monitoring-dashboard.json` is the Grafana dashboard for the Prometheus metrics Polaris exposes at `/metrics`. It covers:

- **Fleet overview** — monitored asset count, status breakdown (up / down / unknown), probe success rate, probe rate per second
- **Cadence health** — monitor pass duration p50/p95/p99, queue depth by cadence, work outcome rates
- **Probe latency by transport** — p95 by `monitorType` (fortimanager / fortigate / snmp / winrm / ssh / icmp / activedirectory) plus per-transport rate split by outcome
- **Process health** — Node.js event-loop lag (p99 + mean), RSS / heap memory, CPU usage
- **Capacity & growth** — overall capacity severity pill, DB pool (current / peak / capacity / max), DB pool % utilization with thresholds, current DB size vs projected steady-state, disk free ratio per volume, dead-tuple ratio per sample table
- **Throughput & queue health** — pg-boss oldest job age per queue, sample-write p95 per table, discovery duration p95 by integration type, discovery rate by integration + outcome
- **HTTP latency** — p95 by route (top 10), in-flight gauge, request rate by status class
- **Job health** — duration p95 per scheduled job, failure rate per job
- **Monitor work duration** — p95 sliced by cadence, by transport, and by cadence × asset_type (same histogram the Capacity Advisor reads to recommend worker counts)
- **FMG worker** — per-integration queue depth, proxy-lane inflight (the strict-concurrency=1 lane), native-lane inflight (CMDB / dvmdb / auth)
- **Write buffers & rollups** — pg-boss queue jobs by queue × state, sample rollup p95 by tier × table, sample buffer depth per table, probe-patch buffer depth + write p95
- **Discovery phases** — per-phase p95 wall-clock by integration type × phase (top 20)
- **Boot-time config snapshot** — queue mode (cursor vs pgboss), DB connection mode (direct vs pgbouncer), workers per cadence queue, DB pool role capacity by `POLARIS_ROLE`

## Prerequisites

1. Polaris running with the metrics endpoint reachable. By default `/metrics` is open; if you've set `METRICS_TOKEN` in `.env`, your Prometheus scrape config needs a matching `Authorization: Bearer <token>` header.
2. A Prometheus instance scraping Polaris.

A minimal Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: polaris
    metrics_path: /metrics
    static_configs:
      - targets: ['polaris.example.com:3000']
    # Uncomment if METRICS_TOKEN is set:
    # bearer_token: '<your-METRICS_TOKEN-value>'
```

## Importing

In Grafana → **Dashboards → New → Import**:

1. Click **Upload JSON file** and pick `polaris-monitoring-dashboard.json`
2. When prompted, select your Prometheus datasource for the `DS_PROMETHEUS` variable
3. Click **Import**

## Customizing

- **Refresh interval** — default 30 s. Change in the dashboard time-picker if you want faster or slower updates.
- **Time range** — default last 1 hour. Set to "last 24h" if you're investigating a longer-running pattern.
- **Thresholds** — the event-loop lag panel marks 50 ms as yellow and 100 ms as orange. These match the operational ranges Polaris is tuned for (15 ms p99 measured on the Rogers Group production fleet of 1,844 monitored assets). Adjust for your environment if needed.

## Reading the dashboard

The single most important panel for cadence health is **Monitor pass duration** (p99 line specifically). If it's hovering well below your configured `monitor.intervalSeconds` (default 60 s), the worker pool has headroom. If p99 is climbing toward — or past — the cadence interval, the publisher is producing work faster than the pool can drain it; expect cadence drift and consider raising worker concurrency (`POLARIS_PROBE_CONCURRENCY` / `POLARIS_HEAVY_CONCURRENCY`) or switching to the pg-boss queue (Maintenance tab → recommendation alert).

For per-transport investigation, the **Probe duration p95 by transport** panel separates the fortinet / snmp / winrm / ssh / icmp paths so you can see if one specific integration is slow without it polluting the overall probe-duration line.

For bottleneck spotting at scale, the four most actionable panels are:

1. **DB pool utilization** (peak / capacity) under "Capacity & growth" — when the line approaches 1, the app is about to stall at pool acquisition. Crank `DATABASE_POOL_SIZE` / `POLARIS_PGBOSS_POOL_SIZE` (within the `polaris_db_pool_max` ceiling) before the next monitor pass tries to grab a connection.
2. **Pg-boss oldest job age** under "Throughput & queue health" — pg-boss-only. A queue with depth > 0 AND age climbing past 60 s = stalled worker. The watchdog auto-recovers within a minute, but the gauge confirms it happened.
3. **HTTP p95 by route (top 10)** under "HTTP latency" — climbing across all 10 ≈ DB pool exhausted (cross-check panel 1); climbing on one route = that handler is hanging on a slow downstream.
4. **Sample-write p95 by table** under "Throughput & queue health" — splits DB-write cost out of monitor work duration. If `asset_interface_samples` or `asset_lldp_neighbors` p95 is climbing, autovacuum is falling behind your insert rate; the dead-tuple-ratio panel confirms it.

For capacity planning, watch the gap between **current DB size** and **projected steady-state** (under "Capacity & growth") — that's your remaining growth runway at the current cadences and retention.

## Keeping the dashboard in sync with `/metrics`

The dashboard is intended to cover every `polaris_*` metric Polaris emits. When a metric is added, renamed, gains a label, or is removed, this JSON has to be updated in the same change — Prometheus itself picks up the new/dropped series automatically, but Grafana panel queries pin specific metric names and labels and will quietly go blank or break otherwise. The contract is encoded in [TOUCHES.md → cross-cutting/observability-metrics](../../TOUCHES.md#cross-cuttingobservability-metrics) under "When changing this."

The full list of Polaris-emitted metric names lives in [src/metrics.ts](../../src/metrics.ts); the helpers there also document what's recorded where.

## Adding more panels (out-of-process sources)

For data Polaris doesn't proxy — Postgres internals, host-level disk/CPU/memory beyond what `prom-client` defaults emit, network — point Prometheus at `postgres_exporter` / `node_exporter` and import a community Grafana dashboard alongside this one. There is no separate pg-boss dashboard: pg-boss has no built-in exporter, and the app-side view (`polaris_pgboss_queue_jobs`, `polaris_pgboss_oldest_job_age_seconds`) lives in the **Write buffers & rollups** + **Throughput & queue health** rows above.
