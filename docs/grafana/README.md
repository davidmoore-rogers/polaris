# Polaris Grafana dashboard

`polaris-monitoring-dashboard.json` is a starter Grafana dashboard for the Prometheus metrics Polaris exposes at `/metrics`. It covers:

- **Fleet overview** — monitored asset count, status breakdown (up / down / unknown), probe success rate, probe rate per second
- **Cadence health** — monitor pass duration p50/p95/p99, queue depth by cadence, work outcome rates
- **Probe latency by transport** — p95 by `monitorType` (fortimanager / fortigate / snmp / winrm / ssh / icmp / activedirectory) plus per-transport rate split by outcome
- **Process health** — Node.js event-loop lag (p99 + mean), RSS / heap memory, CPU usage

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

The single most important panel is **Monitor pass duration** (p99 line specifically). If it's hovering well below your configured `monitor.intervalSeconds` (default 60 s), the worker pool has headroom. If p99 is climbing toward — or past — the cadence interval, the publisher is producing work faster than the pool can drain it; expect cadence drift and consider raising worker concurrency (`POLARIS_PROBE_CONCURRENCY` / `POLARIS_HEAVY_CONCURRENCY`) or switching to the pg-boss queue (Maintenance tab → recommendation alert).

For per-transport investigation, the **Probe duration p95 by transport** panel separates the fortinet / snmp / winrm / ssh / icmp paths so you can see if one specific integration is slow without it polluting the overall probe-duration line.

## Adding more panels

The metric cardinality is intentionally small — the dashboard above uses every Polaris-specific metric Polaris emits. If you want to extend it (e.g. with Postgres or pg-boss metrics), point Prometheus at `pg_exporter` and `pg-boss`'s built-in metrics endpoint and add panels alongside.

The full list of Polaris-emitted metric names lives in `src/metrics.ts`; the helpers there also document what's recorded where.
