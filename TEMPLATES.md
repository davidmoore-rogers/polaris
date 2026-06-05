# Polaris — Primaries Index

A lookup index of **canonical implementations** to model new work after. Answers the question **"there are five places that already do this — which one is the reference?"**

This file complements [CLAUDE.md](CLAUDE.md) (narrative architecture) and [TOUCHES.md](TOUCHES.md) (cross-cutting writers/readers/invariants). Use `TEMPLATES.md` whenever you're about to build a new instance of a pattern that already exists somewhere — pick the canonical one and copy its shape.

## How to use

1. Find the pattern that matches what you're building (chart, modal, slide-over, sortable table, etc.).
2. Open the **Canonical implementation** file/line and read it.
3. Match its conventions — DOM structure, helper calls, persistence keys, refresh model.
4. Only diverge when the new surface genuinely needs something the canonical doesn't (note the divergence in your PR).
5. **Keep this file current.** Per CLAUDE.md's commit-review rule, every commit re-reads `TEMPLATES.md` for staleness — if your change replaced the canonical, moved its file, or invalidated a convention, fix it in the same commit.

## Format

Per-pattern sections:
- **What it is** — one-sentence scope
- **Canonical implementation** — entry-point `path/file.ts → symbolName()`
- **Key conventions** — DOM/data shape, helpers, persistence keys, refresh model
- **When adding a new instance** — checklist before merging

> **Reference convention:** code references are `path/file.ts → symbolName()` — line numbers are deliberately omitted (they drift). Grep the symbol name.

## Sections

- [Time-series chart (SVG)](#time-series-chart-svg)
- [Modal](#modal)
- [Slide-over panel](#slide-over-panel)
- [Sortable + filterable data table](#sortable--filterable-data-table)
- [Per-instance multi-lane worker (constrained + unconstrained endpoints)](#per-instance-multi-lane-worker-constrained--unconstrained-endpoints)
- [Cross-asset graph derivation + persisted DAG](#cross-asset-graph-derivation--persisted-dag)
- [Setting-backed admin CRUD with periodic + on-demand reconciler](#setting-backed-admin-crud-with-periodic--on-demand-reconciler)
- [Discovery-driven managed tag namespace](#discovery-driven-managed-tag-namespace)
- [Prometheus metric instrumentation](#prometheus-metric-instrumentation)
- [High-volume append-only time-series writes (batch-flush buffer)](#high-volume-append-only-time-series-writes-batch-flush-buffer)
- [Tiered time-series rollups (hourly + daily aggregates over detail samples)](#tiered-time-series-rollups-hourly--daily-aggregates-over-detail-samples)
- [Per-integration verbose debug logging](#per-integration-verbose-debug-logging)
- [Permission-gated route + dynamic-role function key](#permission-gated-route--dynamic-role-function-key)
- [Operator-customizable widget surface](#operator-customizable-widget-surface)
- [Queue-on-transient-failure with retry tick + recovery hook](#queue-on-transient-failure-with-retry-tick--recovery-hook)
- [Integration type (config + discovery + sync + frontend modal)](#integration-type-config--discovery--sync--frontend-modal)
- [Polling methods section (per-stream subtab strip)](#polling-methods-section-per-stream-subtab-strip)
- [Mobile bottom sheet](#mobile-bottom-sheet)
- [Mobile pull-to-refresh](#mobile-pull-to-refresh)

---

## Time-series chart (SVG)

**What it is:** A range-selectable SVG line chart driven by an API endpoint that returns `{ since, until, samples, stats }`. Used for response time, CPU+memory, interface throughput/errors, IPsec bytes, storage usage, sensor temperatures.

**Canonical implementation:** Asset Details → System → **Response Time** graph.
- Loader: `_loadMonitorHistoryFor()` in `public/js/assets.js` — fetches history + polling-method transitions, calls renderer, schedules auto-refresh.
- Renderer: `_renderMonitorChart()` in `public/js/assets.js` — builds the SVG; uses `_chartTimeBounds()` to align to `since`/`until` so empty regions stay visible.
- Range buttons: `_chartRangeBtnsHTML()` in `public/js/assets.js` — produces the `1h / 24h / 7d / 30d / Custom` toolbar.
- Persistence: `_getChartRangePref(key, fallback)` / `_setChartRangePref(key, range)` in `public/js/assets.js` — per-user `localStorage.polaris-prefs-charts-<username>` JSON map keyed by chart id (`assetMonitor`, `assetSystem`, `assetSensor`, `assetInterface`, `assetIpsec`, `assetStorage`).
- Tooltip: `_wireChartTooltip(container, formatHTML)` in `public/js/assets.js` — single shared hover handler all charts use.
- Resize: `_observeChartResize(container, rerender)` — re-renders on container resize via ResizeObserver.
- Stats line: `_renderChartStats(container, count, parts)` — single helper every chart calls; produces the canonical `<count> samples · <Label>: <value> · …` shape and writes a plaintext fallback to `container.dataset.summary` for screenshots/tooltips.
- Polling-method badge: `_streamSourceBadgeHTML(asset, stream)` (sync first paint) + `_updateStreamSourceBadgesFromEffective(assetId, asset)` (async overwrite from `/effective-monitor-settings`). Renders `<method> (<details>) · every <interval> · <tier>`.
- Lookback overflow: route helper `extendSinceForLookback(since, bucketSeconds)` in `src/api/routes/assets.ts` + optional `fetchSince` parameter on every `read*History` service in `src/services/sampleHistoryService.ts` + frontend helpers `_chartClipId(prefix)` / `_chartClipDefs(id, padL, padT, innerW, innerH)` / `_chartClipAttr(id)` near the chart-prefs block in `public/js/assets.js`.

**Key conventions:**
- **Lookback overflow + clip-path.** Each history endpoint extends the data query backwards by one bucket of overflow (`fetchSince = since − 5min` on detail tier, `since − 1 bucket` on hourly/daily) via `extendSinceForLookback` in the route handler. The service uses `fetchSince` for the WHERE clause but filters stats to `timestamp >= since` so operator-visible counts and averages match the visible window. The response keeps `since` / `until` at the visible bounds. The frontend chart renderers wrap the data layer (polyline / dots / failure lines / hit targets) in `<g clip-path="url(#chart-clip-…)">` whose `<rect>` matches the inner plot area exactly — `_chartClipId(prefix)` generates a unique id per chart instance, `_chartClipDefs(id, padL, padT, innerW, innerH)` emits the `<defs><clipPath>` block, `_chartClipAttr(id)` returns the matching attribute. Axis ticks / grid lines / legend / stale banner stay OUTSIDE the clipped group so they render normally. The pattern keeps the operator-visible window literal (X-axis still spans `[since, until]`) while letting the polyline enter the chart from the left edge with continuous data instead of starting partway through.
- API returns `{ range, since, until, samples[], stats }`. Custom ranges return `range: "custom"`.
- Loader writes the active selection onto the SVG container's `dataset.range` (or `dataset.from` + `dataset.to`) so probe-now / silent ticks can refetch the same view.
- "Custom" ranges do **not** auto-refresh; preset ranges do, on the resolved monitor interval (`_refreshIntervalMs`).
- Silent refresh ticks capture/restore `panelBody.scrollTop` around the swap so the slide-over doesn't jump.
- Range selection is persisted; "Custom" from/to inputs intentionally are not.
- **Stats line:** call `_renderChartStats(container, count, [{label, value}, …])`. Leading `<strong>{count}</strong> samples` span, then one `<span><strong>{Label}:</strong> {value}</span>` per metric, joined by flex gap. **No** "current/as-of" prose inside the stats line — current readings go in the Status block above the charts, modeled on `Last Response Time` / `Last Poll`. **Each chart owns its own stats line** (don't share one stats container across two charts — see Interface throughput vs errors).
- **Polling-method badge:** every chart's section header carries one. Sync render uses the per-asset override only as a coarse first guess; the async path overwrites with the authoritative resolved value (covers class / integration / manual tiers). Cadence in the badge comes from the same resolved settings as the polling method, NOT a separate lookup.
- **Stale-data banner:** sections rendering `lastTelemetryAt` / `lastSystemInfoAt` / `lastTemperatureAt`-driven data prepend `_staleBannerHTML(assetId, asset, streamKey, lastAt)` (in `public/js/assets.js`). `streamKey` is `"telemetry"` (CPU / memory / temps) or `"systemInfo"` (interfaces / storage / IPsec / LLDP). Banner appears only when `lastAt` is older than 3× the resolved polling interval. Resolution priority: `_effectiveResolvedByAssetId` (full `/effective-monitor-settings` walk — covers per-asset / class override / integration / manual tiers) → per-asset override → manual tier from `_monitorSettingsCache` → hardcoded floor (60s telemetry / 600s systemInfo). Output is a `.asset-stale-banner-slot` wrapper so `_updateStaleBannersFromEffective(assetId, asset)` can re-evaluate after the eff fetch lands — the sync first paint can't see a class override, the async pass picks it up. The two `effectiveMonitorSettings()` callers (`_populateAssetMonitorTierBadges`, `_updateStreamSourceBadgesFromEffective`) plus the response-time chart loader all populate the cache + fire the re-evaluator on success.
- **Temperatures exception (header-stamp absorbs the banner):** the Temperatures section does NOT prepend `_staleBannerHTML`. Its table-specific timestamp (`si.lastTemperatureAt`) can diverge from the telemetry-pass timestamp (`a.lastTelemetryAt`) whenever the CPU/memory pull succeeds but the sensor pull fails — rendering both a "updated 22s ago" header stamp (from telemetry) and a "last updated 15h ago" banner (from temperature) at the same time confused operators. Instead the section header carries an id'd slot (`#asset-system-temps-updated`) that `_updateTemperatureUpdatedStamp(asset, si)` rewrites in both the empty-data and rows branches of `_renderTemperatures`. Slot reads `si.lastTemperatureAt || si.lastTelemetryAt || asset.lastTelemetryAt` and flips amber + prefixes "⚠ last successful update …" when older than 3× the resolved telemetry cadence; otherwise renders the normal tertiary-color "updated …". Other sections keep the banner because their table-specific timestamp matches the asset-level `last*At` (interfaces / storage / LLDP all ride `lastSystemInfoAt`).

**When adding a new instance:**
- Pick a unique chart id and add it to the prefs key list above.
- Reuse `_chartRangeBtnsHTML` for the toolbar — don't roll your own.
- Wire `_wireChartTooltip` and `_observeChartResize` — every existing chart does, and skipping breaks behavior parity.
- Attach the loader's persisted range to the container dataset so silent refresh and probe-now refetch the same window.
- Use `_renderChartStats` for the stats line. If your chart has additional "current" readings worth showing, put them in the Status block (or a sibling section that mirrors Status), not inline in the stats line.
- Stats values must come from `data.stats` server-side or be derived once from the same samples the chart renders — don't duplicate aggregation logic.
- Add a polling-method badge to the section header via `_streamSourceBadgeHTML` whenever the chart's data is delivered by a configurable polling stream (response-time / telemetry / interfaces / lldp).
- If the data is unsupported on some monitor transports (e.g. ICMP/SSH), render an empty-state message — don't show an empty chart.
- Prepend `_staleBannerHTML(assetId, asset, streamKey, lastAt)` whenever the section renders sample data driven by a `last*At` timestamp. Use `streamKey: "telemetry"` for CPU / memory / temperature surfaces and `streamKey: "systemInfo"` for interface / storage / IPsec / LLDP surfaces. The slot wrapper auto-rehydrates when `/effective-monitor-settings` resolves — no manual await needed.
- **Apply lookback overflow + clip-path.** In the route handler, call `extendSinceForLookback(since, pick.bucketSeconds)` and pass the result to the history service as `fetchSince`. In the service, default `fetchSince` to `since`, use it for the WHERE clause, and gate stats accumulation on `r.timestamp.getTime() >= since.getTime()` so overflow rows drive line continuity without inflating counts. In the renderer, allocate one clip id with `_chartClipId("<chartName>")`, emit `_chartClipDefs(id, padL, padT, innerW, innerH)` inside the SVG, and wrap every data-drawing element (polyline + dots + failure lines + hit targets) in `<g ' + _chartClipAttr(id) + '>…</g>`. Leave axis ticks, grid lines, legends, and the stale banner OUTSIDE the clipped group — they need to render in the y-axis label gutter where pre-since samples must be hidden.

---

## Modal

**What it is:** A centered, draggable modal dialog with header / body / footer, used for forms, confirmations, and inline detail editors.

**Canonical implementation:** `openModal(title, bodyHTML, footerHTML, options)` in `public/js/app.js`. Companion: `closeModal()` at `public/js/app.js`, `showConfirm(message)` at `public/js/app.js`.

**Key conventions:**
- Single shared `#modal-overlay` element appended to `document.body` on first call; reused across opens.
- DOM shape: `.modal-overlay > .modal > [.modal-header, .modal-body, .modal-footer]`.
- Width variants: `options.wide` adds `.modal-wide`; `options.xl` adds `.modal-xl`. Default is the standard width.
- Sticky inner tab strip: when a modal body uses `.page-tabs` as a direct child (e.g. integration edit), the strip is auto-pinned to the top of the scrolling `.modal-body` via the `.modal-body > .page-tabs` rule in `styles.css`. Don't roll your own sticky positioning. Nested sub-tab strips (deeper than direct child) are intentionally not sticky.
- Header is the drag handle (mousedown anywhere outside `.modal-close`).
- Backdrop click flashes the close button instead of dismissing — explicit close only, to protect in-progress edits.
- Confirms use `showConfirm()`, which returns a Promise — never use `window.confirm()` (won't render in some browser/embed contexts).
- Z-index layering: `.modal-overlay` is 1000 by default; if `openModal` detects an open `.slideover-overlay` (1050), it adds the `.above-slideover` class to bump the modal to 1075. Lets modals opened from inside a slide-in (e.g. Reserve IP from the IP panel) render in front. `closeModal` clears the class.

**When adding a new instance:**
- Call `openModal(title, bodyHTML, footerHTML, options)` — do not hand-roll a new overlay element.
- Footer buttons close via explicit `closeModal()` calls bound after open.
- For destructive actions, wrap with `await showConfirm(...)` first.
- For wide forms (multi-column / tabbed), pass `{ wide: true }`; reserve `{ xl: true }` for genuinely dense UIs (allocation preview, etc.).
- Re-bind any DOM listeners after each open — the body HTML is replaced wholesale.

---

## Slide-over panel

**What it is:** A right-edge resizable detail panel for entity views (asset details, network/IP details, block details, lease lookups). Distinct from a modal: persistent header + scrollable body, can stay open while the user interacts with the underlying page.

**Canonical implementation:** Asset Details panel built by `_ensureAssetPanelDOM()` in `public/js/assets.js`; opened by `openViewModal(id)` at `public/js/assets.js`.

**Key conventions:**
- Single overlay per page, lazily created on first open and reused.
- DOM shape:
  ```
  .slideover-overlay > .slideover >
    .slideover-resize-handle
    .slideover-header > [.slideover-header-top (h3 + close), .slideover-meta]
    .slideover-body
    .slideover-footer
  ```
- Width persistence: call `initSlideoverResize(panelEl, "polaris.panel.width.<name>")` from `public/js/app.js`. Each surface uses its own localStorage key.
- Backdrop click closes (target equality check on `.slideover-overlay`).
- Open animation: append/build, then `requestAnimationFrame(() => overlay.classList.add("open"))` on the next frame to trigger the CSS transition.
- Auto-refresh timers (e.g. monitor chart, system tab) gate on `_isOverlayOpen("<panel-overlay>")` and `_isCurrentAsset(id)` — close cancels pending ticks via `_clearAssetRefreshTimers()` so a closed panel never fires API requests.
- Nested slide-overs (interface / storage / sensor / IPsec drilldowns) layer on top of the asset panel and only the topmost closes on the close button — see the interface slide-over pattern in assets.js for the layering rules.

**When adding a new instance:**
- Reuse the `slideover-*` CSS classes; do not invent new container styles.
- Wire `initSlideoverResize` with a unique localStorage key.
- All async data loaders gate on the overlay being open (and on the entity being current) before writing into the body — defends against late responses landing after the user navigated away.
- Cancel any timers in the panel's `close*()` function.
- Silent refresh ticks must capture/restore `panelBody.scrollTop` around the swap (see `_loadMonitorHistoryFor` and `_loadSystemTabFor`).

---

## Sortable + filterable data table

**What it is:** A `<table>` with per-column sort, inline filter, and (optionally) multi-select dropdown filters. Used for the assets, subnets, blocks, reservations, integrations, events, users, MIBs, and credentials lists.

**Canonical implementation:** `TableSF` in `public/js/table-sf.js`. Used by every list page; the assets table at `public/assets.html` + `public/js/assets.js` is the most feature-complete example.

**Key conventions:**
- Mark sortable/filterable columns on `<th>` with:
  - `data-sf-key="<dotted.path>"` — supports nested keys (`block.name`, `_count.subnets`).
  - `data-sf-type="string|number|date|ip|array"` — defaults to `string`.
  - `data-sf-options="value1|value2=Label2|value3"` — when present, renders a multi-select checkbox popover instead of a free-text input.
- Construct once after rendering the static `<thead>`: `var sf = new TableSF("<tbody-id>", onChange);`.
- Pipe raw rows through `sf.apply(rawData)` before rendering — sort + filters are applied there.
- The `onChange` callback re-runs the row renderer; never mutate `rawData` in place.
- Multi-select filters store an **array** of values matched case-insensitively against the row value via exact equality.
- Status / type / monitored-state pills used as cells should remain plain DOM (not React/components) so `data-sf-key` reads them via the underlying value, not display HTML.

**When adding a new instance:**
- Use `TableSF` — do not hand-roll sort/filter logic per page.
- For enum-style columns (status, role, type), prefer `data-sf-options` over a free-text input — operators almost always want exact-match.
- For columns whose displayed text differs from the underlying value (badges, formatted dates), pull the raw value from the row and stash it as the display source — never let the `data-sf-key` resolution diverge from what the user sees.
- Pagination, if needed, lives **outside** `TableSF` (apply pagination after `sf.apply()`).
- Always wire `onChange` to the render function so filter/sort updates live-refresh.

**Server-side mode (for high-volume tables).** When the table is too large to ship to the browser (Events at 235k–350k rows in a 7-day window is the canonical case; future telemetry/sample admin views would qualify too), keep using `TableSF` for its header UI but route every filter + sort + page operation through the API. The mode is a consumer convention — no changes to `public/js/table-sf.js` are needed. Canonical implementation: [public/js/events.js](public/js/events.js) + [public/events.html](public/events.html).

- Instantiate once: `_sf = new TableSF("<tbody-id>", onChange)`. **Never call `sf.apply()`** — every row that reaches the tbody came from the server already filtered + sorted.
- The `onChange` callback reads `sf._sortKey`, `sf._sortDir`, `sf._filters` directly, resets offset to 0, and re-fetches. Translate state into API params:
  - Multi-select checkbox arrays (`sf._filters.<key> = [val1, val2]`) → CSV (`?<key>=val1,val2`); the backend treats >1 entry as Prisma `{ in: [...] }` and 1 entry as `{ equals }` so single-value back-compat is preserved.
  - Text-column raw forms (`string` → contains; `{ op: "not-contains", q }` / `{ op: "empty" }` / `{ op: "notempty" }`) → `<field>` + `<field>Op` (the backend operator set is `contains | not_contains | empty | is_not_empty`).
  - Date-range filter `{ type: "date", from, to }` → `since` / `until`.
  - Sort state → `sortBy` / `sortDir`. The route must whitelist the column set and 400 on anything outside; Prisma `orderBy` never accepts user-supplied strings unvalidated. When sort semantics differ from string alpha order (e.g. severity), keep a numeric companion column (Event has `levelRank`) and dispatch the user-facing sort key onto it server-side.
- Dynamic multi-select options (operator-extensible enums like resourceType) — call `sf.setColumnOptions("<key>", values)` after each fetch. Pre-this-change checked values are preserved if they're still in the new option set.
- Persist filter + sort state in the page's `polaris-prefs-<scope>-<username>` localStorage blob alongside the column layout — match the other list pages. Restore via `sf._filters = saved.filters; sf._sortKey = saved.sort.key; sf._sortDir = saved.sort.dir; sf.restoreFilterUI();` before the first fetch.
- Offset-based pagination still lives outside `TableSF` — wire prev/next/page-buttons to bump a module-scope offset and call the same fetch helper.
- Any non-tbody consumer of filter state (PDF/CSV export's "All filtered results" path) must read from `sf._filters`, not the (now-deleted) DOM filter strip.

---

## Table column layout (resize + hover-gear chooser)

**What it is:** Drag-to-resize column widths plus a show/hide column chooser, opened by a gear icon that surfaces on `<thead>` hover at the right edge of the header. Replaces the older "Columns ▾" toolbar button — the gear is the only canonical affordance going forward. Pairs naturally with `TableSF` (same `data-sf-key` ids double as column ids) but works standalone on any `<table>` with a `<thead>`.

**Canonical implementations:**
- `setupColumnLayout(tableEl, options)` in [public/js/table-sf.js](public/js/table-sf.js) — the underlying widget. Injects a gear into the rightmost visible `<th>`, auto-relocates when columns hide. Used directly for the long-lived list-page tables (Assets, Blocks, Subnets, Events, IP panel, Users, Roles).
- `applyTableLayout(tableEl, typeKey)` in the same file — wrapper for tables that get **re-rendered on every refresh** (asset-detail System tab: Interfaces / Storage / Temperatures / LLDP / Wireless Stations; same shape works for any dynamic table). Persists widths + hidden columns under `polaris-table-layout-<typeKey>-<username>` so the same Interface widths apply to every asset and survive each rebuild. Safe to call after every `innerHTML` replacement.

**Key conventions:**
- Mark every `<th>` with a stable `data-col-id="<name>"`. Falls back to `data-sf-key`, then `__col<index>` if neither is present — but explicit ids survive column reordering, so always set them on dynamic-rendered tables.
- Mark "anchor" columns (the ones a sensible table must always show — usually the leftmost identity column plus any actions column) with `data-col-required="true"`. The gear will never anchor itself to a hideable column, and operators can't hide a required one via the chooser.
- Mark secondary columns that should ship **off by default** with `data-col-default-hidden="true"` — they appear unchecked in the chooser until an operator enables them. `getPrefs` persists an explicit `shown` snapshot (alongside `hidden`) so an operator's "turn it on" choice survives reloads, and `setPrefs` applies `shown` (un-hide) before `hidden` (hide). This is backward-compatible: older prefs blobs lacking `shown` leave default-hidden columns hidden and still honor previously-hidden columns. Used by the Assets table's inventory columns (Asset Tag, Manufacturer, Model, OS / Firmware, MAC Address, Assigned To, Purchase Order, DNS Name).
- For list pages using `setupColumnLayout` directly: persist via the page's own `polaris-prefs-<scope>-<username>` blob (call `layout.getPrefs()` in `_save…Prefs` and `layout.setPrefs(p.layout)` in `_restore…Prefs`). The standalone "Columns ▾" button is gone — the gear replaces it.
- For dynamic-rendered tables: use `applyTableLayout(table, typeKey)` instead. Persistence is by-table-type, NOT by-page or by-asset — operators want one set of widths for "Interfaces" everywhere, not per asset.
- Last column should remain present at all times in the header DOM even when hidden — the gear auto-relocates left to the next visible `<th>` via `positionGear()`.
- Drag-to-resize is **pair-adjacent** (spreadsheet-style): dragging a handle grows the column on its left by the delta and shrinks the next *visible, resizable* column on its right by the same amount, so the table's total width stays constant and no other column shifts. Both columns floor at 40px. The rightmost handle has no right neighbor and falls back to growing its own column alone.
- **Fixed utility columns** (`cb-col` checkbox / `fav-col` favorite-star) are non-resizable: they get no drag handle, are skipped when a neighboring drag picks the column to absorb its delta, and are pinned to a fixed 20px (`FIXED_COL_W`) so they never get distributed leftover space under `table-layout:fixed`. They're also always `required` (non-hideable).
- **Cell content truncates** with an ellipsis rather than wrapping. This only renders in `table-layout:fixed`, so `setupColumnLayout` **seeds fixed layout on first visible render** (`seedFixedLayout`): it measures each visible column's natural width and locks it in. It bails when any column measures 0 (table rendered off-screen in an inactive SPA section), leaving auto-layout intact until a later visible re-render or a `setPrefs` width restore. The truncation CSS is scoped to `table[data-sf-table-id]` and exempts `.actions` (button groups keep wrapping) and the cb/fav columns; the `.sf-label` header text ellipsizes too. Consequence: these tables no longer reflow to fill the container on window resize the way auto-layout did.

**When adding a new instance:**
- Long-lived static table on a list page → call `setupColumnLayout(tableEl, { onChange: _saveYourPagePrefs })` once after the `<thead>` is in the DOM; thread its `getPrefs/setPrefs` into the existing per-page prefs JSON.
- Dynamic table inside a modal or panel rebuilt on every refresh → call `applyTableLayout(container.querySelector("table"), "<stable-type-key>")` immediately after the `innerHTML` assignment. Choose a global, type-level key (e.g. `"asset-interfaces"`, `"server-mibs"`) — never include the asset id or page id in the key.
- Do NOT add a standalone "Columns" button to the toolbar — the gear is the only column-chooser entry point going forward.

---

## Per-instance multi-lane worker (constrained + unconstrained endpoints)

**What it is:** A per-instance worker that segregates traffic to a flaky external system by endpoint family — endpoints subject to the system's parallel-connection limit ride a strict single-consumer FIFO lane (concurrency=1); endpoints without that constraint ride an unbounded lane that just tracks inflight count for observability. Distinct from a single-cap worker pool: the value is *cross-feature serialization for the constrained endpoints only*, while letting unconstrained endpoints parallelize freely.

**Canonical implementation:** `FmgWorker` in [src/services/fmgWorker.ts](src/services/fmgWorker.ts). One `FmgWorker` per integration id; module-level `Map<integrationId, FmgWorker>` keyed off the integration row's id. Proxy lane (strict 1) carries `/sys/proxy/json` calls — FMG drops parallel calls past 1-2 there. Native lane (unbounded) carries every other call (`/pm/config/...`, `/dvmdb/...`, auth) — those hit FMG's own DB and have no parallel-call constraint.

**Key conventions:**
- Public API is two submit methods: `submitProxy<T>(label, task, signal): Promise<T>` (strict lane) and `submitNative<T>(label, task, signal): Promise<T>` (unbounded lane). Plus read-only `proxyQueueDepth` / `proxyInFlightLabel` / `nativeInFlightCount` for telemetry. Don't expose the queue itself.
- Lane dispatch lives at ONE call site — the shared low-level helper that every code path funnels through (in FmgWorker's case, `rpc()` in `fortimanagerService.ts`). The helper inspects the payload (e.g. URL pattern) and routes to the right lane. Callers above the helper don't pick the lane.
- Proxy lane: FIFO single-consumer drain loop owned by the class. AbortSignal pre-dispatch drops the entry and rejects with `AbortError(...)`. In-flight abort is the *task's* responsibility (via fetch signal threading) — the worker doesn't force-cancel.
- Native lane: no queue, no semaphore. `submitNative` just bumps an inflight counter, awaits the task, and decrements (in a finally so throws don't leak the counter). Pre-submit abort throws `AbortError` immediately; in-flight abort is the task's responsibility via the fetch signal.
- Lazy creation, never torn down. `getXxxWorker(id)` returns the existing worker or creates one. Workers leak on instance-delete; that's intentional (cheap; tearing down races with concurrent `getXxxWorker` callers).
- Telemetry: proxy lane publishes queue-depth gauge + 0/1 inflight gauge so operators can spot `queue_depth>0 AND inflight=1` as "constrained lane is the bottleneck." Native lane publishes a single inflight-count gauge — sustained high values indicate genuine parallelism (good), not a bottleneck.
- Test reset: provide a `__resetXxxWorkersForTests()` symbol so tests start with a clean registry.
- Label is a short string used for telemetry and audit logs. Format like `"fmg.<rpcMethod>:<resourceUrl>"` — derived from the inner task, not freeform.

**When adding a new instance:**
- Identify the shared low-level helper that all callers funnel through. The lane-dispatch predicate lives ONLY in that helper. Don't scatter `submitProxy` / `submitNative` calls across high-level entry points — the next contributor will forget one.
- Decide which endpoints belong in the constrained lane. Document the rule in the worker file's header so future code paths route correctly. For FmgWorker: `/sys/proxy/json` ⇒ proxy lane, everything else ⇒ native lane.
- Thread the keying id (typically integrationId) through every public function that ends up calling the helper. The id flows from the route handler → service → low-level helper.
- Public functions take the id as the LAST optional parameter so unsaved-state callers (e.g. pre-create test connection on a draft integration) can omit it; in that case the worker is bypassed and the call runs direct (no contention possible since there's no other code talking to this instance yet).
- Wire three gauges to `src/metrics.ts`: proxy-lane queue depth (count), proxy-lane inflight (0/1), native-lane inflight (count). Keep names parallel to FmgWorker's so dashboards generalize.
- Document the "load-bearing tests" for both lanes:
  - Proxy lane: one proxy task A in-flight, submit proxy task B from a different feature surface, confirm B waits until A completes. This is the cross-feature-serialization invariant the constrained lane exists to enforce.
  - Native lane: submit three native tasks simultaneously, confirm all three are started concurrently (not queued).
  - Cross-lane independence: a blocked proxy task does NOT block native tasks, and vice versa.

---

## Cross-asset graph derivation + persisted DAG

**What it is:** A dependency / topology graph derived from heterogeneous discovery signals (controller-stamped fields + interface-name inference + LLDP), persisted as parent→child edges with a per-node BFS layer, refreshed at end of every discovery cycle, and read by both runtime logic (e.g. monitoring suppression) and the topology UI. Distinct from a per-request topology computation — persisting the DAG gives runtime callers a single source of truth without re-walking signals on every probe.

**Canonical implementation:** `recomputeDependencyTree()` + `reconcileDependencySuppression()` + `propagateAfterStatusChange()` in [src/services/dependencyTreeService.ts](src/services/dependencyTreeService.ts), backed by the `AssetDependencyParent` model + `Asset.dependencyLayer` / `Asset.dependencySuppressed` columns.

**Key conventions:**
- **Pure helpers exported for tests.** `buildDependencyEdgesFromInputs(assets, interfaceEdges, lldpEdges)`, `assignLayers(assets, edges)`, `evaluateSuppression(states, parents)` are pure functions — no DB, no side effects. The DB-bound `recomputeDependencyTree` / `reconcileDependencySuppression` are thin wrappers that load inputs, call the pure helper, and write the diff. New tests cover the pure helpers; the wrappers are exercised via integration tests.
- **Signal precedence at edge-build time.** When the same parent→child pair surfaces from multiple signals, keep the strongest. Convention: controller (3) > interface (2) > lldp (1). Implemented as a `(child|parent) → {edge, strength}` map that tracks the winner.
- **BFS layer assignment from a known root set, with edge pruning.** Layer-1 nodes are assigned by domain rule (here: every FortiGate). BFS outward; a candidate edge is kept only when `layer[parent] + 1 === layer[child]`. Same-layer edges (siblings, MCLAG pairs) and reverse edges are dropped. Cycles can't form once layers are settled — disconnected components or chains through unmonitored intermediates surface as `unresolved`.
- **Persistence is replace-and-recreate per scope, not diff.** `recomputeDependencyTree(integrationId)` deletes computed rows for in-scope assets, re-inserts from `keptEdges`, updates `dependencyLayer` — all in one `prisma.$transaction`. Operator override rows (`source="override"`) are never touched. In-scope is the integration's discovered assets; out-of-scope rows are owned by another integration's recompute and left alone.
- **Override resolution at read time.** When loading effective parents, "if any override row exists for an asset, use the override set; else use the computed set." Empty override set = explicit "no parents" pin. Read-time resolution avoids any write coupling between operator edits and discovery cycles.
- **Reconciler is the source of truth for runtime state; event hook is a latency optimization.** The 60s `reconcileDependencySuppression()` walks every monitored asset in BFS layer order, computes desired suppression under the domain rule (here: all-down multi-parent), writes only diffs. The event hook (`propagateAfterStatusChange`) calls the same reconciler on every probe-result transition for sub-second propagation, but correctness never depends on it firing — server restart mid-transition / race / dropped event are all caught by the next periodic tick.
- **Discovery hook runs at the END of the discovery function**, after all asset writes and projection-apply phases — not interleaved. Gated on `mode in {full, finalize}` so per-device skip-deprecation passes don't trigger partial recomputes.
- **One-shot startup backfill** (`backfillDependencyTree.ts`) runs `recomputeDependencyTree()` 30 s after boot so existing installs see populated rows without waiting for the next scheduled discovery cycle.

**When adding a new instance:**
- Identify your domain's "layer-1 root rule" (here: assetType === "firewall"). Hardcoded in the BFS layer assigner; write tests that cover the orphan case (no path from any root → null layer).
- Define your edge-strength order over the available signals. Document it in the service header comment so future contributors don't re-litigate which signal wins.
- Pick the "in-scope" axis for incremental recompute (here: `discoveredByIntegrationId`). The full graph load is cheap; the per-scope writeback is what matters for keeping cycles isolated to the active integration's writes.
- Pure helpers go in the service file with explicit `export`. DB-bound wrappers stay in the same file but mark them clearly with a comment header so test contributors know which functions to mock vs which to call directly.
- Add a TOUCHES.md cross-cutting section on day one — runtime callers and UI surfaces will discover the DAG quickly and reach for it; the index keeps the writers/readers visible.

---

## Setting-backed admin CRUD with periodic + on-demand reconciler

**What it is:** A small, admin-managed collection of configuration objects (allocation templates, map regions, …) persisted as a JSON blob in the `Setting` table, with a CRUD API and an optional reconciler that propagates each object's effects through the rest of the system. The reconciler runs inline on every CRUD edit (so operators see immediate effect) AND on a periodic safety-net job (so anything the inline path missed gets caught — restart mid-edit, external state drift, etc.).

**Canonical implementations (parallel):**
- **No reconciler** (storage-only): `allocationTemplateService` in [src/services/allocationTemplateService.ts](src/services/allocationTemplateService.ts) + [src/api/routes/allocationTemplates.ts](src/api/routes/allocationTemplates.ts).
- **With reconciler** (storage + side effects on other entities): `mapRegionService` in [src/services/mapRegionService.ts](src/services/mapRegionService.ts) + [src/api/routes/mapRegions.ts](src/api/routes/mapRegions.ts) + [src/jobs/reconcileMapRegions.ts](src/jobs/reconcileMapRegions.ts).

**Key conventions:**
- **Storage shape.** Single `Setting` row keyed on a stable string (`"networkAllocationTemplates"`, `"mapRegions"`); the `value` JSON is an array of records each carrying its own UUID id (don't store as an object map keyed by id — operators reorder, services iterate, an array preserves intent). Helpers `loadAll()` / `persistAll()` go through `prisma.setting.upsert`.
- **Validation lives in the service, not the route.** Route uses a Zod schema for shape + obvious bounds; service re-validates and throws `AppError(400 | 404 | 409)` for semantic rules (uniqueness, cross-record consistency). The service is the source of truth so non-route callers (jobs, other services) get the same protection.
- **Uniqueness on user-visible names is case-insensitive.** Block renames onto another record's name with a 409. Don't rely on Postgres uniqueness — the Setting JSON has none.
- **Reconciler is additive when possible.** Inline reconciler runs after every create/update/delete (await before responding so the operator sees consistent state on the next page load). Periodic job calls the same reconciler add-only; explicit cleanup (rename, delete) is owned by the route handler so the periodic tick has nothing stale to clean up. See `mapRegionService` for the full pattern: rename = strip-old + add-new, delete = strip, periodic = add-only.
- **Audit trail.** Each CRUD route writes a `<resource>.<verb>` Event via `logEvent()` (`region.created` / `region.updated` / `region.deleted`); the reconciler writes a separate `<resource>.tags_reconciled`-style event when something actually changed (don't spam events on no-op cycles). Inline reconcile events are children of the CRUD event; periodic ones stand alone.
- **Auth gate.** `requireNetworkAdmin` (or `requireAdmin` for a more sensitive surface) at the route mount — pick the gate that matches the audience that should be able to see + edit. If the surface only renders while editing (e.g. map regions), gate read access too so non-editors never need the data.
- **Tag registry mirror (when applicable).** If the reconciled effect is "stamp a tag onto assets," upsert a corresponding `Tag` registry row on create, rotate it on rename, delete it on delete. Operators expect managed tags to appear in the same picker as manual tags.

**When adding a new instance:**
- Pick a unique `Setting` key. Document it in CLAUDE.md's Setting "Notable keys" list.
- Mirror the public service API to `allocationTemplateService` (storage-only) or `mapRegionService` (with reconciler) — pick the closer one and copy its shape verbatim.
- Service-level uniqueness validation must run before persistence. Tests cover the create-create / update-rename collision.
- If you have a reconciler: provide three entry points — `applyOne(record)` (used inline by create / polygon-only update), `applyRename(record, previousName)` (rename branch), `applyDelete(record)` (delete branch), and `reconcileAll()` (periodic + discovery hook). Periodic job uses the additive `reconcileAll()`; never call the rename/delete helpers from there (those are CRUD-only).
- Add a TOUCHES.md `services/<feature>.ts` section for the service AND a cross-cutting section if your reconciler writes to a shared namespace (e.g. asset tags). The index keeps the additive vs authoritative writer split visible.

---

## Discovery-driven managed tag namespace

**What it is:** A breadcrumb tag prefix (`firewall:`, future analogues) stamped on assets purely from data already written by FMG / FortiGate discovery. No operator CRUD, no Setting blob — every input that drives the tag set comes from discovery itself, so end-of-discovery is the natural and only reconciliation point. Distinct from the **Setting-backed admin CRUD with reconciler** pattern above, which has operator-edited inputs (polygons, names) and therefore needs a periodic safety net to catch out-of-band edits.

**Canonical implementation:** `firewallTagService` in [src/services/firewallTagService.ts](src/services/firewallTagService.ts), wired into [src/api/routes/integrations.ts](src/api/routes/integrations.ts) at Phase 2a (decommission strip), Phase 3 firewall create (registry seed), Phase 3 firewall update (rename rotation), and Phase 13.5 (end-of-sync reconciler). No periodic job.

**Key conventions:**
- **Single owner per prefix.** Document the prefix in [TOUCHES.md](TOUCHES.md) under the cross-cutting "Asset.tags writers" section. Don't add a second writer to `firewall:*` (or whatever your prefix is) — pick a different prefix.
- **Strip allowlist scoped to the integration's owned set.** The reconciler computes "tags I'm allowed to remove" as `firewall:<hostname>` for every active firewall this integration discovered. Tags pointing at FortiGates owned by other integrations or operator-typed `firewall:fake` survive every pass. Without this scoping, two integrations would fight over the same asset's tags.
- **Self-attribution skip.** A FortiGate firewall asset never gets its own `firewall:<own-hostname>` tag. Bake the skip into the membership compute.
- **Per-asset diff write.** Read current `Asset.tags`, compute expected, walk both sets to build the next array (carry non-`firewall:*` tags through; keep allowlist-external `firewall:*` tags; add expected; drop allowlist-internal expected-misses). Update only when the array actually differs — most reconciler ticks should be no-ops on healthy fleets.
- **Inline lifecycle hooks.** The four Phase wiring points cover the cases the periodic reconciler can't reach in time:
  - Phase 2a — `applyDecommission(hostname)` strips the tag everywhere + drops the registry row, so a removed FortiGate stops being a filterable option immediately.
  - Phase 3 create — `seedRegistry(hostname)` upserts the registry row so the tag picker carries the entry from day one.
  - Phase 3 update — `applyRename(old, new)` rotates the tag on every dependent asset + the registry row when the projected hostname differs from the existing value.
  - Phase 13.5 — full reconcile after Phase 13 (map-region pass), gated `mode in {"full", "finalize"}`.
- **No periodic safety-net job.** If every input is discovery-written, there's nothing for a periodic tick to catch that the next discovery won't. Don't copy the `reconcileMapRegions.ts` job pattern — it exists because polygon edits and firewall lat/lng updates are operator-driven outside discovery, which doesn't apply here.
- **Tag registry mirror.** Upsert a `Tag` row at `<prefix><value>` under a category that names the namespace (e.g. `"FortiGate"`) so operators see the managed tags in the same picker as manual tags. Idempotent re-upserts in the reconciler keep the registry intact even after manual deletions.
- **Best-effort everywhere.** Wrap every Phase hook + the reconciler call in try/catch and `syncLog("error", ...)` so a tag failure never blocks the sync return. Tags are derived state — losing a write means at most one cycle of stale tags.

**When adding a new instance:**
- Pick a unique tag prefix and a registry category. Document both in [TOUCHES.md](TOUCHES.md) under the "Asset.tags writers" cross-cutting entry.
- Define the membership rule explicitly: which assets get the tag, sourced from which fields / tables. Pure functions over inputs already written by discovery.
- Define the strip allowlist: which tags THIS reconciler is allowed to remove (always scoped to "things owned by the current integration").
- Wire the four lifecycle points. The reconciler is the source of truth; the inline hooks are latency optimizations + invariants on registry-row presence.
- Skip the periodic job unless you have an input that genuinely changes outside discovery — and if you do, you're probably in the **Setting-backed admin CRUD with reconciler** pattern instead.

---

## Prometheus metric instrumentation

**What it is:** Adding a new metric (counter / gauge / histogram) or instrumenting a new code path with an existing one. Single Registry singleton + helper functions per metric — callers never import metric objects directly. Default Node.js metrics from `prom-client.collectDefaultMetrics` are registered alongside Polaris-specific ones, all under one `/metrics` endpoint.

**Canonical implementation:** [src/metrics.ts](src/metrics.ts) — every metric is defined here with its labels, buckets (for histograms), and a typed helper export (e.g. `recordProbe`, `setDbPoolGauges`, `startSampleWriteTimer`). Mounted at `/metrics` in [src/app.ts](src/app.ts) with optional `METRICS_TOKEN` Bearer-token auth. For periodic-job timing, [src/jobs/_metrics.ts](src/jobs/_metrics.ts) exports `runInstrumentedJob(name, fn)` — every job in `src/jobs/` wraps its tick body in this helper.

**Key conventions:**
- **One Registry singleton.** `registry = new Registry()` at module top; `collectDefaultMetrics({ register: registry })` runs at module load. Never create a second registry — `prom-client`'s global registry is intentionally not used.
- **Helpers, not raw metric objects.** Every metric gets a typed helper: `startXTimer()` / `recordX(...)` / `setX(...)`. Callers never `import { someHistogram }` — they import the helper. This localizes label changes / renames / bucket tweaks to one file. The metric object itself is module-private.
- **Cardinality discipline.** Only bounded label sets cross the boundary: `cadence` (4 values), `transport` (5), `outcome` (2-3), `status` (3), `queue` (4), `state` (3), `severity` (4), `mode` (2), `table` (~8), `route` (matched Express template, not URL), `status_class` (4), `job` (~25), `volume` + `roles` (per-host, ~4), `integration_type` (~6). The only intentionally-unbounded label is `integrationId` (counted in dozens, justified by per-integration FMG worker isolation).
- **Histogram buckets are explicit, not default.** Pick buckets that span the actual operation's latency range — defaults from `prom-client` (0.005 .. 10) waste resolution on most Polaris operations. Pass-duration buckets go up to 900 s; probe buckets go down to 0.01 s; HTTP buckets fit between.
- **Cursor/pg-boss mode mutual-exclusion is explicit.** Mode-specific metrics (`polaris_monitor_queue_depth` cursor-only, `polaris_pgboss_*` pg-boss-only) keep emitting in the inactive mode but stay at 0. Use `polaris_monitor_queue_mode{mode}` to pick which family is authoritative.
- **`.reset()` before re-stamping volatile label sets.** When the set of label values is computed each tick (volumes from statfs, sample tables from pg_class), call `metric.reset()` first so dropped values don't leave orphan series. Don't `.reset()` for stable label sets (cadences, transports, queues).
- **Histograms observe successful work only.** Failures / aborts / errors increment a counter (`polaris_*_total{outcome}`) without polluting the latency distribution. Achieved by structuring the helper as `startTimer() ... await op() ... stop()` — a throw before `stop()` drops the observation.
- **HTTP middleware uses `req.route?.path` at finish time.** Captured in `res.once("finish", ...)` so the Express router has had a chance to match. Unmatched paths roll up to `"unmatched"`. Combine with `req.baseUrl` for routers mounted on a sub-path. `/metrics` and `/health` are explicitly skipped so scrape requests don't show up as application traffic.
- **`runInstrumentedJob(name, fn)` for periodic jobs.** Wraps the tick body without changing existing error semantics — thrown errors propagate to the caller's existing try/catch. Job names are stable, machine-readable identifiers; multi-tick modules use `<module>.<loop>` (e.g. `monitorAssets.probe` / `monitorAssets.heavy`).
- **Documentation in two places.** Every new metric family gets a one-paragraph entry in CLAUDE.md's Observability section AND a writers/readers/invariants entry in `TOUCHES.md`'s `cross-cutting/observability-metrics`.

**When adding a new metric:**
- Define the metric object + helpers in `src/metrics.ts`. Helpers go right after the definitions, in the existing `// ─── Helpers ───` block.
- Decide on histogram buckets by walking through the actual range the operation can take. Powers-of-10 spaced for >1s metrics, 0.005/0.025/0.1/0.5/1/5 for HTTP-class metrics, 0.01..15 for probe-class.
- Consider cardinality before adding a label. If the value is per-asset / per-row / per-UUID, push it into the histogram buckets or aggregate it by class instead.
- Wire the helper into the call site. ONE call site per metric family if possible — the FMG worker's queue-depth gauge is updated only inside `FmgWorker`, not elsewhere; the discovery duration histogram fires only at the `recordSample()` callsite.
- Add the documentation entries (CLAUDE.md Observability + TOUCHES.md cross-cutting/observability-metrics) in the same commit.

**When instrumenting a new job:**
- Wrap the tick body in `runInstrumentedJob("name", async () => { ... })`. Keep the existing outer try/catch for error logging — the helper's catch re-throws so log paths are preserved.
- Pick a stable, machine-readable name (no spaces, no version suffixes, no UUIDs). One-shot startup migrations use the module basename; multi-tick modules use `<module>.<loop>`.
- If the new job ships with the same commit that adds an unrelated capability, the metric label is one observation that confirms the job is actually firing on a real install — useful smoke check during the first deploy.

---

## High-volume append-only time-series writes (batch-flush buffer)

**What it is:** Persistent time-series tables that receive many small writes from a hot loop. Per-row `prisma.<table>.create()` calls each consume one Prisma pool connection, and at high concurrency the pool fills before the operation matters. The canonical fix is an in-memory per-table buffer with a periodic flush — accumulate rows, then issue one `createMany` per N-second window.

**Canonical implementation:** [src/services/sampleWriteBuffer.ts](src/services/sampleWriteBuffer.ts) — handles the eight monitor sample tables (`asset_monitor_samples`, `asset_telemetry_samples`, `asset_temperature_samples`, `asset_interface_samples`, `asset_storage_samples`, `asset_ipsec_tunnel_samples`, `asset_perf_sla_samples`, `asset_sdwan_rule_samples`). Boot wiring in [src/app.ts](src/app.ts) — `startSampleWriteBuffer()` after queue init, `shutdownFlushSampleBuffers()` awaited in the SIGTERM/SIGINT hook. The two SD-WAN streams (added 2026-06) are the most recent end-to-end worked example — see `TOUCHES.md → SD-WAN stream change-checklist`.

**Key conventions:**
- **Append-only tables only.** Conflict-handling, dedupe, and per-asset replace semantics break the model. If you need to overwrite or delete prior rows, do that synchronously in the caller before the enqueue (cf. `recordSystemInfoResult`, which keeps the `$transaction` for `assetAssociatedIp` and the per-asset replace in `persistLldpNeighbors` synchronous).
- **Buffer is sync to enqueue, async to flush.** The hot loop calls `enqueue*(row)` and returns immediately — no await on the buffer. The flush is fire-and-forget, driven by `setInterval` and a per-table size threshold (5,000 rows in this implementation).
- **Snapshot the array up front.** `flushTable` splices the buffer into a local snapshot before the `await prisma.<table>.createMany` so concurrent enqueues during the awaited write land in a fresh array. On retry-exhausted failure, re-prepend the snapshot for the next tick.
- **Per-table flush guard.** A `flushing[key]` boolean prevents re-entry on the same table — a 2 s tick that fires while a slow flush is still mid-write becomes a no-op for that table.
- **Use `retryOnDeadlock` from `src/utils/dbRetry.ts`.** Postgres deadlocks (SQLSTATE 40P01) on bulk insert are rare but real; the retry helper covers them with jittered backoff.
- **Trade-off documented in code:** up to one flush-interval of data is lost on hard crash. For STATE writes (per-asset replace, last-write-wins, threshold counters that need read-your-writes) use the parallel pattern in [src/services/probePatchBuffer.ts](src/services/probePatchBuffer.ts) instead — same `setInterval` shape, but a `Map<id, patch>` instead of an array, merge-on-enqueue, and one `UPDATE … FROM (VALUES …)` per flush instead of `createMany`. The two buffers are intentionally separate because the contracts are incompatible: append-only forbids dedupe, replace requires it.
- **Instrument both flush duration and depth.** `polaris_sample_write_duration_seconds{table}` (histogram) wrapping each flush + `polaris_sample_buffer_depth{table}` (gauge) updated on every enqueue and flush — the pair distinguishes "flush is slow" from "enqueue rate exceeds flush throughput".
- **SIGTERM-safe.** Exported `shutdown*` function clears the timer and runs one final `flushAllSampleBuffers()`. Awaited from the graceful-shutdown hook in `app.ts` so a restart doesn't drop the in-flight buffer.
- **Test hooks under `__test__`.** Expose `getBufferDepth(key)` and `reset()` so unit tests can verify buffer state without exposing the buffers themselves to production callers.

**When adding a new table:**
- Append a `BufferKey`, a `TABLE_LABEL` entry, an `enqueueXxx` helper, and a `writeBatch` switch arm — five touch points in one file. Tests mirror the same shape.
- Confirm the new table is append-only with no FK on `(assetId, ...)` that requires per-row uniqueness mid-flush; if it does, you probably want synchronous semantics (LLDP-style) instead.
- Update `TOUCHES.md`'s `services/sampleWriteBuffer.ts` entry's Writers list to name the new caller.

---

## Tiered time-series rollups (hourly + daily aggregates over detail samples)

**What it is:** Long-range chart queries that would otherwise scan millions of detail rows are served from hourly + daily aggregate tables. Detail keeps recent (7 days default), hourly keeps medium (30 days), daily keeps long (1 year). The same query API returns same-shape responses on every tier — only sample count and granularity differ. SolarWinds-style storage policy adapted to Polaris's monitor sample tables.

**Canonical implementation:** [src/services/sampleRollupService.ts](src/services/sampleRollupService.ts) (writer) + [src/services/sampleHistoryService.ts](src/services/sampleHistoryService.ts) (reader) + [src/services/sampleQueryRouter.ts](src/services/sampleQueryRouter.ts) (tier picker) + [src/jobs/runSampleRollup.ts](src/jobs/runSampleRollup.ts) (periodic driver). Retention policy backed by [src/services/sampleRetentionService.ts](src/services/sampleRetentionService.ts) and `Setting("sampleRetention")`, edited from the Maintenance card.

**Key conventions:**
- **Upsert writes, not append-only.** Rollup buckets MUST be rewritten in place on re-runs (handles late-arriving samples after a flush window crosses an hour rollover). The detail-tier `sampleWriteBuffer` pattern is the WRONG canonical here — rollup writes need INSERT...ON CONFLICT DO UPDATE semantics, which the append-only buffer intentionally rejects.
- **One SQL statement per (table, tier).** Each rollup is a single `INSERT INTO <table>_<tier> SELECT date_trunc('<unit>', timestamp) ... GROUP BY ... ON CONFLICT (bucketStart, assetId[, extraKey]) DO UPDATE SET ...`. Portable across Timescale and plain Postgres via `date_trunc` (not `time_bucket` which is Timescale-only).
- **Daily reads from hourly, NOT detail.** At scale (2000+ assets) a daily tick that re-scanned detail would be untenable. Layering daily on hourly keeps the daily tick bounded.
- **Aggregation shape:** Gauge tables (monitor, telemetry, temperature, storage) carry `sampleCount + avg/min/max` per bucket. Counter tables (interface, ipsec) carry `first/last` counter endpoints + `lastBucketSampleAt` so the read layer derives rate as `(last - first) / (lastBucketSampleAt - bucketStart in seconds)`, dropping negative deltas as counter resets. IPsec additionally counts per-status sample occurrences within each bucket.
- **Per-tier composite uniqueness.** `@@unique([bucketStart, assetId, <extraKey>?])` enforces one row per (asset, bucket, extra-key) so the rollup's ON CONFLICT clause has a target. Composite PK `(id, bucketStart)` separately so Timescale's "all PK columns must include the partitioning column" rule is satisfied without breaking the upsert semantics.
- **Tier-routed reads use the same shape across tiers.** The reader translates rollup aggregate columns back to the source-table field names so chart renderers don't branch on tier — they get smoother values with smaller `sampleCount` per point. Counter charts get an explicit branch via `bucketSeconds > 0` because their semantic genuinely changes (cumulative counter vs pre-computed rate). The response carries `tier` + `bucketSeconds` discriminator fields the frontend uses for a "Hourly avg" / "Daily avg" stats-line badge.
- **Two ticking loops, independent guards.** Hourly tick every 30 min, daily tick at 02:30 UTC. Each has its own `running` boolean so a slow tier can't block the other. Lookback windows (2 h hourly, 2 d daily) cover late-arriving samples without redoing the whole table.
- **Stamp lastSuccess per tick.** `Setting("sampleRollup.<tier>.lastSuccess")` updated on every successful run; capacityService consumes for a `sample_rollup_lagging` watch reason that catches stuck rollups before long-range charts silently fall back to detail-table scans.
- **Instrument writer + reader paths separately.** `polaris_sample_rollup_duration_seconds{tier,table}` (histogram, per INSERT) + the existing `polaris_job_duration_seconds{job="sampleRollup.<tier>"}` / `polaris_job_total{job, outcome}` from `runInstrumentedJob`. The HTTP histogram already times reads.

**When adding a new aggregate column:**
- Add the column to BOTH `*_hourly` and `*_daily` schema definitions.
- Update both branches of the SQL builder in `sampleRollupService.ts` (hourly aggregation from detail; daily aggregation from hourly with weighted averages and first/last propagation).
- Update the matching reader translation in `sampleHistoryService.ts` so the rollup row maps back to the chart-consumable shape.
- Update `capacityService.DEFAULT_BYTES_PER_ROW` for the new rollup row size.
- Tests mirror the same shape; commit the Prisma migration generated from `migrate diff`.

**When adding a new sample stream:**
- New `RetentionStream` enum value in `sampleRetentionService.ts` + matching default tier in `defaultSampleRetention()`.
- New source + hourly + daily schema models. Add all three to `timescaleService.ROLLUP_TABLES` (and `SAMPLE_TABLES` for the source).
- New SQL builders in `sampleRollupService.ts` (a hourly and a daily entry).
- New reader in `sampleHistoryService.ts` matching the source's shape.
- New prune helper in `monitoringService.ts` that calls `pruneOneTable` per (table × tier).
- Capacity SAMPLE_TABLES enumeration in `capacityService.ts` gets three new entries (detail / hourly / daily).
- Maintenance UI card gets a new stream row in `SAMPLE_RETENTION_STREAMS`.
- Update `TOUCHES.md`'s cross-cutting/tiered-sample-retention section's Writers list to name the new caller.

**When changing retention defaults:**
- Update `DEFAULT_DETAIL_DAYS` / `DEFAULT_HOURLY_DAYS` / `DEFAULT_DAILY_DAYS` in `sampleRetentionService.ts`.
- The migration job `consolidateSampleRetention.ts` reads these constants for fresh-install seeding; no separate update.
- Existing installs are unaffected — their stored `Setting("sampleRetention")` keeps whatever the operator set.

---

## Per-integration verbose debug logging

**What it is:** Operator flips one checkbox on an integration's edit modal and gets step-by-step structured logs of that integration's discovery + sync + monitor-worker activity. Off by default; logs emit at pino info level (tagged `verbose: true`) so journalctl shows them immediately — no `LOG_LEVEL=debug` restart dance. Reused across discovery, sync, and per-job worker pickup/finish so an operator never has to wonder "which knob lights this up."

**Canonical implementation:** Four touchpoints, all consistent on the same payload shape:
- **Config flag:** `verboseLogging: z.boolean().optional().default(false)` on every integration's Zod schema in [src/api/routes/integrations.ts](src/api/routes/integrations.ts) (mirrors the `useProxy` / `pushReservations` / `pushQuarantine` pattern).
- **Discovery → pino:** the `onProgress` closure reads `integration.config.verboseLogging` once at run start and `logger.info({ verbose: true, integrationId, integrationName, step, level, device }, message)` for each callback.
- **Sync phases → pino:** `phaseMark(name)` cursor in `syncDhcpSubnets`. Each call logs the elapsed time of the previous phase; final `phaseMark("__end__")` closes the last one.
- **Worker pickup/finish → pino:** the publisher in `monitorAssets.publishDueWork` reads `discoveredByIntegration.config.verboseLogging` and stamps `verboseDebug: true` on the job payload; `runDedicatedWorker` / `dispatchFloatingJob` in `queueService.ts` read it back and emit lines with the worker slot id.

**Key conventions:**
- **One structured-payload shape** for all four surfaces: `verbose: true`, optional `integrationId` + `integrationName`, plus surface-specific fields (`step` or `phase`, or `workerSlot` + `jobId` + `cadence` + `assetId`, plus `elapsedMs` and `outcome` where measured). Don't invent a parallel shape for new debug surfaces — operators rely on `jq 'select(.verbose==true)'` working uniformly.
- **Off by default everywhere.** New integration types must default to `false`; new debug surfaces must read a config flag (per-integration) or env var (global) before emitting at info level. No always-on debug noise.
- **Pino, not Events.** Verbose lines never write to the `Event` table — that's reserved for the existing audit surface. Events table inflation from a 1000-FortiGate discovery would balloon retention.
- **Stable worker slot ids** via [src/utils/workerSlotPool.ts](src/utils/workerSlotPool.ts). Acquired on entry, released on exit (try/finally). Reused across jobs so an operator can follow one slot through journalctl.
- **No restart needed** to flip the toggle. The discovery `onProgress` and the publisher both read the current config at runtime; the next discovery cycle / next monitor tick picks up the change.
- **UI shape:** appended to every integration's General tab as a uniform "Debug" section via `verboseLoggingFormHTML(defaults)` in [public/js/integrations.js](public/js/integrations.js). Same checkbox id (`f-verboseLogging`) across types so `readVerboseLoggingFromForm()` works without per-type branching.

**When adding a new integration type:**
- Schema gets `verboseLogging: z.boolean().optional().default(false)`.
- Frontend form helper appends `verboseLoggingFormHTML(d)` at the bottom of its return value.
- Reader (`getXxxFormConfig`) adds `verboseLogging: readVerboseLoggingFromForm()` to the returned config.

**When adding a new pg-boss queue:**
- Allocate a slot pool in `slotPools` with the matching size.
- Use `runDedicatedWorker(cadence, job, exec)` for the handler; verbose pickup/finish logs land automatically when `job.data.verboseDebug` is true.

**When adding a new sync phase:**
- Insert `phaseMark("X")` right under the `// Phase X — ...` comment. The previous phase's elapsed time is logged at the next phaseMark call; the final phase is closed by `phaseMark("__end__")` at the bottom of `syncDhcpSubnets`.

---

## Permission-gated route + dynamic-role function key

**What it is:** A new functional area that needs its own dimension in the per-role permission matrix. Every route gate is `requirePermission(functionKey, level)` from `src/api/middleware/permissions.ts`; bearer-token surfaces use `requireSessionOrTokenPermission(functionKey, level, scope)` instead. The function-key catalogue is the single source of truth that the matrix UI consumes via `GET /api/v1/roles/functions`.

**Canonical implementation:**
- Middleware: `src/api/middleware/permissions.ts` (`requirePermission` / `requireOwnership` / `hasPermission` / `requireSessionOrTokenPermission`).
- Function-key catalogue: `FUNCTION_KEYS` constant in `permissions.ts`.
- CRUD service template: `src/services/roleService.ts` (built-in protection + cache-version bump + per-field diff Event).
- Route layer template: `src/api/routes/roles.ts` (per-method `requirePermission` gates; Zod schema for permission shape).
- Frontend matrix consumer: `public/js/users.js` `openRoleSlideover` + `regionPickerHtml`.

**Key conventions:**
- Reads + writes are gated per-route, not per-mount. Reads use `requirePermission(key, "read")`; writes use `requirePermission(key, "write")`. Mount-level guards exist only where a coarser gate is correct (the legacy `/server-settings` blanket is the last hold-out).
- Ownership-dimensioned functions (today: `subnets`, `reservations`) use `requireOwnership(key)` which is `requirePermission(key, "write")` + sets `req.permissionLevel` for the handler to branch on (`if (req.permissionLevel !== "fullwrite" && row.createdBy !== req.session?.username) ...`).
- Every Role write calls `bumpRoleVersion(roleId, updatedAt)` from `permissions.ts` so live session snapshots refresh on the next request without sweeping the session store.
- Built-in roles carry `isBuiltIn=true`; the two undeletable+unrenameable ones (admin + readonly) additionally carry `isProtected=true`. Service-layer write paths enforce both invariants — never trust the frontend's hidden state.
- Frontend capability checks go through `permAtLeast(functionKey, level)` from `public/js/app.js`; legacy `isAdmin()` / `canManageNetworks()` / `canManageAssets()` shims have been rewritten to consult the matrix, but new call sites should use `permAtLeast` directly so the code is self-documenting at a grep.

**When adding a new function key:**
- Append the row to `FUNCTION_KEYS` in `permissions.ts`. Pick a stable camelCase `key`; set `hasOwnershipDimension: true` only when "Read-Write" really means "edit own only."
- Write a migration that adds the new key to every existing `Role.permissions` JSON (admin → fullwrite, readonly → read for readable-by-non-admin surfaces else none, the three editable built-ins → match the closest existing routes' behavior).
- Wire the route layer guards using `requirePermission(newKey, level)`.
- Add a CLAUDE.md "Function-key catalogue" entry. The frontend matrix UI picks the new row up automatically via `GET /roles/functions`.

**When adding a new region-scoped column:**
- Mirror the existing `Role.regionTags` / `User.regionTags` shape: `String[] @default([])` + comment `Empty = unrestricted`.
- Validation lives in the service layer (`normalizeRegionTags` in `roleService.ts` is the template): trim, drop empties, dedupe case-insensitively, cap length + count.
- The consumer (filter / list scoping) consults `auth.me.regionTags.effective` from the frontend or `req.session.roleSnapshot` + `req.session.userId → user.regionTags` on the backend — never branch on role NAME for region semantics.

---

## Operator-customizable widget surface

**What it is:** A page where the operator chooses which cards (widgets) appear, drags them onto a snap-to-grid canvas, resizes them, and configures per-widget options via a gear popover. Layout persists server-side per user. Empty state on a fresh sign-in with a prompt to open a slide-in widget library showing real rendered mini-previews. The Dashboard home page is the first instance; future operator-customizable surfaces should match this shape.

**Canonical implementation:** Dashboard home page — entry point is `public/js/dashboard.js` (orchestrator), backed by:
- HTML: `public/index.html` — `#dashboard-empty-state`, `#dashboard-canvas`, `#dashboard-add-widget` button, and the `#widget-library-overlay` slide-in.
- CSS: `public/css/styles.css` — `.dashboard-canvas` (12-col CSS grid, row height 280px), `.dashboard-widget*`, `.widget-library-*`, `.widget-config-popover`.
- Widget modules: `public/js/widgets/*.js` — each self-registers via `PolarisWidgets.register({...})` (registry in `public/js/widgets/index.js`).
- Slide-in: `public/js/widget-library.js` — `WidgetLibrary.open(onAdd)` / `WidgetLibrary.close()` / `isOpen()`.
- Persistence: `UserDashboard` Prisma model + `src/services/userDashboardService.ts` + `src/api/routes/userDashboard.ts` (GET/PUT `/me/dashboard`); client at `api.me.dashboard.{get,put}`.

**Key conventions:**
- **Grid model.** 12 columns × N rows. Widget widths ∈ `{3, 4, 6, 12}`, heights ∈ `{1, 2}`. Row height in pixels is fixed at the canvas-CSS layer (`grid-auto-rows`); widget `width`/`height` are grid-cell spans, never pixels.
- **Order-based layout.** The widget array IS the layout — `col` and `row` are derived. Every state mutation (add / move / remove / resize) reflows via `reflow(widgets)`: row-major packer, leftmost-topmost free slot wins. Drop position in the canvas is translated to an *insertion index* in the ordered array (`insertIndexFromCursor()`), never to absolute coordinates. This is why "drop in front of a widget shifts the others over" falls out naturally — the reflow handles it after every insertion.
- **Module shape.** A widget exports `{ type, label, description, defaultSize, minSize?, defaultConfig?, requiredPermission?, fetchData?, renderInstance(el, config, data, ctx), renderPreview(el), renderConfig?(el, config, onChange), onMount?, onUnmount? }`. `ctx.onUnmount(fn)` is how a widget registers cleanup for its own timers / observers; the orchestrator runs them when the widget is removed or re-rendered.
- **Mini-previews are real renders, not screenshots.** Each widget's `renderPreview(el)` calls the same DOM-emitting code as `renderInstance`, just with module-local mock data. Keeps the library card honest about how the widget actually looks.
- **Shared data fetch.** Built-in widgets that read `/dashboard/summary` accept the summary via the `summary` arg on `fetchData(config, summary)` — the orchestrator fetches once per canvas render and passes the slice. Independent widgets own their own fetch and just ignore the arg.
- **Role gating.** A widget's `requiredPermission: { key, level }` is checked client-side against the cached `polaris-user` permission matrix (`permAtLeast(key, level)` in app.js). The library card is hidden when the user lacks the permission; the underlying API call would also fail, so this is convenience, not security.
- **Persistence is cross-device.** Layouts live in the `UserDashboard` Prisma model (per-user JSON blob). PUT is debounced 800ms in the orchestrator so a flurry of drags/resizes is one save. Validation lives at the route layer via Zod (`LayoutSchema` in `userDashboard.ts`) — the service round-trips the blob untouched. Do NOT pivot to localStorage for this pattern — operator switching between desk and laptop is the explicit user expectation.

**When adding a new operator-customizable surface (or a new widget to the existing Dashboard):**
- **New widget on the existing Dashboard:** add `public/js/widgets/<type>.js`; self-register via `PolarisWidgets.register`; include a `renderPreview` with mock data; add the `<script src>` line to `public/index.html`. Wire `requiredPermission` if the widget reads a permission-gated endpoint. No backend or registry changes needed.
- **New customizable surface elsewhere:** model the canvas + slide-in + per-user storage after this Dashboard. Use a sibling `UserSurfacePreference`-style table keyed on `(userId, surfaceKey)` rather than overloading `UserDashboard`. Reuse `PolarisWidgets.register` for that surface's widgets — the registry is global by design so cross-surface widget reuse is one-line.
- **Don't bake widget positions into seeded defaults** unless you genuinely want every user to see the same starting view — the precedent here is "empty = invitation to customize." Operators have explicitly told us they prefer a clean slate.
- **Don't add a Save button.** Debounced auto-save is what makes the drag/resize/gear interactions feel responsive; a confirm step kills the loop.

---

## Queue-on-transient-failure with retry tick + recovery hook

**What it is:** A pattern for outbound device-side writes (push a DHCP reservation to a FortiGate, push a quarantine MAC, etc.) where the operator's intent must survive a transient outage on the target. Instead of failing-atomic on every error, the service **classifies** errors into permanent (operator action required — roll back) vs transient (retry-eligible — keep the Polaris row in a `"pending"` state) and a 60s periodic reconciler drives pending rows to success once the target is reachable. An event-driven recovery hook (target's `monitorStatus` flips to `up`) fires the same reconciler for sub-cadence latency.

**Canonical implementation:** Queued DHCP reservation push — `reservationService.retryPendingReservations()` + `attemptQueuedPush()` (internal helper) + `retryReservationNow()` (operator-triggered) + `triggerRetryAfterStatusChange(assetId)` (recovery hook) in [src/services/reservationService.ts](src/services/reservationService.ts). Error classification: `classifyPushError(err)` in [src/services/reservationPushService.ts](src/services/reservationPushService.ts). Periodic job: [src/jobs/retryQueuedReservationPushes.ts](src/jobs/retryQueuedReservationPushes.ts). Recovery-hook call site: [src/services/monitoringService.ts](src/services/monitoringService.ts) (around line 5381, gated on `nextStatus === "up"`).

**Key conventions:**
- **Single source of truth for permanent vs transient.** `classifyPushError(err) → "permanent" | "transient"` lives in the SERVICE that owns the device transport (not the orchestrator) and is consumed by BOTH the create-time path and the retry path. Returning "transient" by default for unknown shapes keeps the operator's claim alive across error types nobody enumerated yet — a multi-day outage is worse than a few extra retries on a permanent error that will repeat.
- **Persist on transient at create time, abort-and-rollback on permanent.** The create path's try/catch branches on `classifyPushError`: transient → stamp `pushStatus="pending"` + `pushQueuedAt=now` + `pushAttempts=1` + `pushError=<message>`, emit `<feature>.push.queued` (info) Event, return the row; permanent → existing delete-Polaris-row + emit `.push.failed` (warning) + throw.
- **Pre-flight skip when the gate is known down.** Before the transport attempt, a cheap `Asset.findFirst` on the target's firewall asset (joined on `hostname=fortigateDevice + discoveredByIntegrationId`) — if `monitored=true AND monitorStatus="down"`, skip the transport entirely and queue immediately (saves the 15-30s transport timeout on the operator's UI thread).
- **Retry tick gates in order: eligibility → discovery-supersede → readiness.**
  1. Eligibility re-check (subnet deprecated, integration deleted / disabled, push toggle flipped off, target hostname cleared) → `pushStatus=null` + `.cancelled` Event. Cancellation never deletes the Polaris row — operator's claim stands; they just won't get a device push.
  2. Discovery-supersede (another active row at same key now) → `pushStatus="failed_permanent"` + `.collided` Event. Discovery is authoritative.
  3. Readiness gates: monitored target with `monitorStatus !== "up"` → skip without incrementing attempts. Unmonitored target → exponential backoff `min(60 * 2^(attempts-1), 1800)`s keyed on `pushAttempts` + `pushLastAttemptAt`.
- **State machine values on the existing status column.** Don't add a separate `queued` boolean. Extend the existing status enum (`pushStatus`) with `"pending"` and `"failed_permanent"` so callers reading the field already handle the new values via the enum-comprehension default ("anything not 'synced' is not yet on the device"). `sourceType` stays at its create-time value (`"manual"`) until the push verifies — only successful push flips it to the device-aware enum value.
- **Recovery hook is a latency optimization; reconciler is correctness.** The recovery hook (`triggerRetryAfterStatusChange`) fires inside `recordProbeResult` only on the up edge of `monitor.status_changed`. It count-gates on pending rows (`prisma.<table>.count(...)`) — zero pending → early return — so most up-transitions cost one indexed COUNT(\*). When non-zero, fire-and-forget kicks the reconciler. Correctness never depends on the hook firing; the 60s tick catches every case the hook misses (server restart, race, count-gate cold cache).
- **Edit / release on a pending row skip device contact entirely.** The update path early-branches on `pushStatus === "pending"` to just rewrite the queued payload (no device call); the release path skips both unpush AND lease-release for pending rows (nothing on the device). Cleaner audit Event (`.queued.released` info) than the `.unpush.failed` warning the regular release would log.
- **Operator override: `retry-now` bypasses readiness gates only.** `POST /<resource>/:id/retry-push` (ownership-gated — own rows for `write`, all for `fullwrite`) flips `failed_permanent` rows back to `pending` first so the retry path treats them uniformly, then runs `attemptQueuedPush` with `bypassReadinessGates: true`. Eligibility re-check and discovery-supersede still apply.
- **Discovery collision handling on the device-state-read path.** When discovery ingests a fresh row at a key matching a pending Polaris row: (a) **fast-path adopt** if the natural-identity field matches (same MAC for DHCP reservations) — promote in place to `synced` with device-side pointers stamped from the discovered entry, emit `.queued.adopted`; (b) **hard collision** otherwise — flip pending to `failed_permanent` + skip the discovery insert at this key (the unique-on-active constraint would block it anyway), emit `.queued.collided`. To enable (a) without a second REST roundtrip, the discovery-output shape carries device-side pointers at extraction time.
- **Events — info for routine, warning for action-required.** `.queued`, `.queued.succeeded`, `.queued.retry_failed`, `.queued.released`, `.queued.adopted`, `.queued.cancelled`, `.queued.retry_manual` — info. `.queued.failed_permanent`, `.queued.collided` — warning. The retry_failed deliberately is info, NOT warning, so a multi-day outage doesn't generate one warning every 60s.
- **No TTL by default.** Per operator decision: pending rows live forever until success, release, or operator-triggered retry-now. Add a TTL only when the operational cost of forgotten queued rows actually shows up; otherwise the "give up" decision is the operator's, not Polaris's.

**When adding a new instance:**
- Identify the device transport that already classifies errors (or write a `classifyXError` exporter on the service that owns it). Mirror the AppError-status-aware shape — `400/404/409 → permanent`, `502` with specific permanent wording → permanent, everything else → transient.
- Extend the existing status column with `"pending"` and `"failed_permanent"`. Add three migration-additive columns: `<X>QueuedAt`, `<X>Attempts`, `<X>LastAttemptAt`. Index on `(<status column>, <queuedAt>)` for the retry-tick scan.
- Write the service helpers: `retryPending<X>s()` (batch tick entry), `retry<X>Now(id, actor)` (operator-triggered single row), `trigger<X>RetryAfterStatusChange(assetId)` (recovery hook). Factor a private `attemptQueued<X>(row, opts)` helper both call paths share.
- Add a 60s job file modeled on `src/jobs/retryQueuedReservationPushes.ts`. Import it from `src/app.ts` next to the other job imports.
- Fire `triggerXRetryAfterStatusChange` from `monitoringService.recordProbeResult` only on the up edge. Count-gate inside the helper, don't try to filter at the call site.
- Add a TOUCHES.md cross-cutting section covering the writers (create-time queue branch, retry tick, operator retry, edit/release no-op branches, discovery adopt/collide) and the readers (list/count endpoints, UI badges, success-toast suffix, sidebar dot).
- Surface the queue under the existing Reservations alerts UI pattern — new filter option on the same panel rather than a separate page; combine the count into the existing sidebar dot rather than minting a second indicator.

---

## Integration type (config + discovery + sync + frontend modal)

**What it is:** A new external system that Polaris talks to: a firewall family (FortiGate, Palo Alto), a manager (FortiManager, Panorama), an identity provider (Entra ID, Active Directory), or a DHCP server (Windows Server). Adding a new integration type touches a ~30-callsite catalogue across backend dispatch, frontend modal tabs, polling-method compatibility, asset projection, and source-default polling. Without a single reference shape, each new type drifts on tab layout, config-blob keys, transport dispatch, and projection priority — operators see five different UIs for what should feel like the same thing.

**Canonical implementations (parallel):**
- **Directly-talked-to device** (no manager in front): standalone FortiGate. Service [src/services/fortigateService.ts](src/services/fortigateService.ts). Config schema `FortiGateConfigSchema` in [src/api/routes/integrations.ts](src/api/routes/integrations.ts). Frontend form helpers `fortiGateGeneralHTML` / `fortiGateFiltersHTML` / `fortiGateFormHTML` / `getFgtFormConfig` in [public/js/integrations.js](public/js/integrations.js). **Use this when** the new type is a single device with its own REST/SSH API (Palo Alto firewall, Cisco ASA, future on-prem appliances).
- **Manager that fronts many devices**: FortiManager. Service [src/services/fortimanagerService.ts](src/services/fortimanagerService.ts) + per-integration [src/services/fmgWorker.ts](src/services/fmgWorker.ts). Config schema `FortiManagerConfigSchema` in [src/api/routes/integrations.ts](src/api/routes/integrations.ts). **Use this when** the new type aggregates / proxies multiple devices (Panorama, Meraki Dashboard, future SDN controllers). The multi-lane worker pattern applies — see the [Per-instance multi-lane worker](#per-instance-multi-lane-worker-constrained--unconstrained-endpoints) entry.
- **Asset-only discovery (no subnets/reservations)**: Entra ID / Active Directory / Windows Server. Services [src/services/entraIdService.ts](src/services/entraIdService.ts), [src/services/activeDirectoryService.ts](src/services/activeDirectoryService.ts), [src/services/windowsServerService.ts](src/services/windowsServerService.ts). Use a dedicated `syncXxxDevices` path in `integrations.ts` rather than the shared `syncDhcpSubnets`. **Use this when** the new type produces assets only — no DHCP scopes, no reservations, no NAT/VIP.

**Key conventions:**
- **Single `DiscoveryResult` shape across all device-and-network integrations.** Defined in `fortimanagerService.ts` (lines ~834–900) and re-exported / re-used by `fortigateService.ts`. New device-and-network types must produce this exact shape so `syncDhcpSubnets` in `integrations.ts` consumes them identically. Fields the discovery service doesn't populate stay as empty arrays — never as undefined, never as null. Per-query success flags (`switchInventoriedDevices`, `vipInventoriedDevices`, `dhcpReservationsInventoriedDevices`, `dhcpLeasesInventoriedDevices`, etc.) are required because Phase 5b sweeps consult them to scope stale-row deprecation. If the new type genuinely doesn't have a concept (Palo Alto has no FortiSwitch/FortiAP analog), return `[]` for those arrays AND leave the success flag empty — `syncDhcpSubnets` then skips the corresponding sweep.
- **Config JSON shape.** Top-level fields callers and the frontend modal share verbatim across types: `host`, `port`, `verifySsl`, `verboseLogging`, `monitorSettings`, `deviceInclude`, `deviceExclude`, `interfaceInclude`, `interfaceExclude`. Type-specific credentials (`apiUser` + `apiToken` for Fortinet REST, `bindDn` + `bindPassword` for AD, `clientId` + `clientSecret` + `tenantId` for Entra) live alongside. Push toggles (`pushReservations`, `pushQuarantine`, `useProxy`) only exist on types that genuinely support them; the frontend tab visibility flips on `isFmg || isFgt || isPalo` (extend the predicate).
- **Per-class monitor block (asset-only types).** AD/Entra carry `workstationMonitor` / `serverMonitor` (`WorkstationServerClassMonitorSchema` in `integrations.ts`): `addAsMonitored` (monitored-sweep, honored by `monitorOverrideService`), `autoMonitorInterfaces` + `autoMonitorStorage` (post-sync auto-monitor pins — canonical resolvers `autoMonitorInterfacesService.ts` / `autoMonitorStorageService.ts`, applied by `applyWorkstationServerAutoMonitor` in `runDiscovery`), `agentDeploy` (opt-in agent auto-deploy — `agentAutoDeployService.ts`). When adding a per-stream auto-monitor for a new dimension, **mirror `autoMonitorStorageService.ts`** (pure resolver + 72h-bounded latest-sample loader + chunked additive apply); it's the smallest canonical. Agent auto-deploy reuses the manual `/agent/install` row-creation + `startInstall` contract — don't fork it.
- **Discriminated Zod union.** `CreateIntegrationSchema` in `integrations.ts` (line ~438) uses `z.discriminatedUnion("type", [...])`. Add one branch per new type with a `z.literal("<type>")` and the type-specific config schema. The type string in `Integration.type` (Postgres column) is the same literal.
- **Three route dispatchers in `integrations.ts`.** All three switch on `integration.type` and need a parallel branch: (1) **testConnection** (line ~920) — call `xService.testConnection(config)`. (2) **discover** (line ~710) — call `xService.discoverDhcpSubnets(...)` (or `xService.syncXxxDevices(...)` for asset-only) and pass to `syncDhcpSubnets(input.type, result, ...)`. (3) **manual /query proxy** (line ~1030) — call `xService.proxyQuery(...)`. The `integrationLabel` ternary inside `syncDhcpSubnets` (line ~2291) also needs the new label.
- **Discovery scheduler.** `discoveryScheduler.ts` invokes the same per-type dispatch as the manual discover route (line ~1538). Add the new type next to the others.
- **Polling compatibility + source-default.** `src/utils/pollingCompatibility.ts` carries `AssetSourceKind` union + `COMPATIBILITY` matrix + `assetSourceKindFromIntegrationType`. Add `"<type>-firewall"` (or appropriate source kind) and an entry mapping which of the five polling methods (`rest_api`, `snmp`, `winrm`, `ssh`, `icmp`) the new source can drive. `defaultPollingForSource` in `monitoringService.ts` (line ~595) needs the per-stream source defaults — REST-capable appliances default to `rest_api` on probe/telemetry/interfaces and `disabled` on LLDP (mirrors FortiGate); identity sources default to `icmp` on probe and `not_delivered` on the heavy streams.
- **AssetSource projection.** New firewall types get a new `AssetSource.sourceKind` literal. `src/utils/assetProjection.ts` carries per-field priority arrays (`HOSTNAME_RULES`, `SERIAL_RULES`, `MANUFACTURER_RULES`, `MODEL_RULES`, `OS_VERSION_RULES`, `IP_ADDRESS_RULES`, `LATITUDE_RULES` / `LONGITUDE_RULES`). Add the new source kind to every list at the position that matches its trustworthiness (firewalls usually slot in next to `fortigate-firewall`). Manufacturer entries that pick from a constant (`"Palo Alto Networks"`, `"Fortinet"`) deliberately ignore the observed blob — keeps drift from a misreported field from polluting the asset.
- **Frontend modal — parallel form helpers.** Every type has the same trio: `<type>GeneralHTML(d)`, `<type>FiltersHTML(d)` (when applicable), `<type>FormHTML(d)` combining them, plus a `get<Type>FormConfig()` reader. Tab visibility logic (`isFmg || isFgt`, `isAd || isEntra || isWin`) flips on a per-type boolean stamped at modal open. Pickup buttons (`pick-fmg`, `pick-fgt`, `pick-palo`) live in the type-list grid; their listeners call `openCreateModal("<type>")`. Type-label ternaries (`type === "fortigate" ? "FortiGate" : ...`) appear in **at least two places** — the integrations list display and the modal title; add the new label to both.
- **Verbose debug logging is uniform.** Every type carries `verboseLogging` in its config schema (defaults to `false`), every form helper appends `verboseLoggingFormHTML(d)` at the bottom of its General tab, every reader includes `verboseLogging: readVerboseLoggingFromForm()`. See the [Per-integration verbose debug logging](#per-integration-verbose-debug-logging) section for the full pattern.
- **Search hits the asset inventory, not the integration.** The new type doesn't need a `searchService.ts` branch unless it owns a UI surface the global search should pivot into. Firewall asset entries surface naturally through `searchAssets` once they have `assetType="firewall"` + an `AssetSource` row.
- **Monitor settings hierarchy applies uniformly.** Tier-3 integration settings live at `Integration.config.monitorSettings` (eight fields: intervalSeconds, failureThreshold, probeTimeoutMs + telemetry/systemInfo timeouts, three cadences, three retentions). The resolver in `monitoringService.ts` walks per-asset → class-override → integration → manual without branching on type. New types inherit the four-tier resolver for free; what they need is the Zod schema accepting the `monitorSettings` object on the new type's `config` schema (already present in `FortiGateConfigSchema` / `FortiManagerConfigSchema` — copy the field).

**When adding a new integration type:**
1. **Pick the canonical to mirror** (standalone-device vs manager-fronted vs asset-only) and copy its service file verbatim as your starting point. Rename functions; replace the FortiOS REST endpoints with the new system's; keep the `DiscoveryResult` return shape exact.
2. **Add the Zod config schema** to `integrations.ts` and a discriminated-union branch in `CreateIntegrationSchema`. Include `verboseLogging`, `monitorSettings`, and (when applicable) `deviceInclude` / `deviceExclude` / `interfaceInclude` / `interfaceExclude` so the four uniform top-level fields stay parallel.
3. **Wire the three route dispatchers** (testConnection, discover, /query) and the `integrationLabel` ternary in `syncDhcpSubnets`. Wire the discovery scheduler dispatch alongside.
4. **Add the source kind** to `pollingCompatibility.ts` and the per-field rules in `assetProjection.ts`. Add the per-stream source defaults to `defaultPollingForSource` in `monitoringService.ts`.
5. **Build the frontend modal** — `<type>GeneralHTML`, `<type>FiltersHTML`, `<type>FormHTML`, `get<Type>FormConfig`, picker button + listener, type-label ternaries (at least two), tab-visibility predicate updates (`isFmg || isFgt || isPalo` style). Append `verboseLoggingFormHTML(d)` to the General tab.
6. **Run the cross-cutting checklist** in [TOUCHES.md](TOUCHES.md)'s `cross-cutting/integration-type-onboarding` section — that's the authoritative list of every callsite. If you discover a callsite this TEMPLATES.md entry didn't mention, add it to TOUCHES.md in the same commit.
7. **Test discovery → sync → asset write** end-to-end with the new type: create the integration via UI, hit Test Connection, hit Discover, verify `DiscoveryResult` round-trips through `syncDhcpSubnets`, verify projected Asset fields look right, verify the integration shows up on the assets list filter. Cover the asset-only path if applicable.
8. **Write a one-shot startup migration job** if the new type retroactively claims assets that existed before (e.g. `backfillPaloAltoFirewallAssetSources`) — mirrors `backfillFortigateEndpointSources.ts`. Idempotent, marker-keyed, fires once at boot.

---

## Polling methods section (per-stream subtab strip)

**What it is:** A configuration surface that exposes per-stream monitoring settings — polling method (dropdown), credential picker, MIB picker (when polling resolves to SNMP), interval, timeout, and failure threshold (Response Time only). Used inside the integration edit modal (per-class × per-stream), the Assets-page Monitoring Settings modal (Manual Monitoring section), and the asset edit modal's Monitoring tab. Without one canonical layout, three near-identical surfaces drift on label text, sub-row visibility rules, "Inherit" labelling, and DOM id conventions — making the resolver hierarchy harder to read at the UI.

**Canonical implementation:** `_classStreamSubtabHTML(idPrefix, sourceKind, klass, stream, settings, credentials, isPrimary, opts)` in [public/js/integrations.js](public/js/integrations.js). Companion helpers (all in `integrations.js`):
- `_polarisPollingDropdownHTML(id, source, stream, currentValue, opts)` (line 85) — emits the polling-method `<select>`. Honors `opts.showInherit` (default `true`; pass `false` at the bottom of the resolver hierarchy where there's nothing to inherit from) and `opts.fmgDirectMode` (drives the "FortiGate Direct" vs "FortiManager Proxy" label for FMG sources).
- `_polarisSourceDefaultPolling(source, stream)` (line 41) — mirrors `defaultPollingForSource()` in `monitoringService.ts`; returns the per-source-kind per-stream default Polaris would resolve to. Used to label the "Inherit" option.
- `_polarisSourceLabel(source, opts)` (line 63) — the per-source-kind name table: FortiGate Direct / FortiManager Proxy / Active Directory / Entra ID / Windows Server / Manual.
- `_streamsForClass(klass)` (line 877) — returns the per-class stream list. FortiAP omits Storage (APs have no mountable storage); every other class gets all six streams.
- `_intRenderTabbedBody(prefix, tabs)` + `_intWireModalTabs(prefix)` — the tab-strip + body-swap helpers reused for stream subtabs.

**Consumers (parallel surfaces):**
- **Integration edit modal** — class-subtab strip (FortiGates / FortiSwitches / FortiAPs for FMG+FGT; Workstations / Servers for AD/Entra/WinSrv) → stream-subtab strip per class. Uses `_classStreamSubtabHTML(..., isPrimary=true)` for the primary class (FortiGate / Workstations — legacy DOM ids `f-mon-tier-<pollField>`) and `isPrimary=false` with namespaced `f-mon-classecho-<klass>-` prefix for the other class subtabs. **Phase 2 save handler**: each class subtab's stream values serialize independently into `Integration.config.<klass>Monitor.streams.<stream>` via `_readClassStreamSubtabs(klass, isPrimary, includeStorage)` — secondary subtabs no longer echo the primary; each class's own input values are persisted. **Phase 2 load handler**: `_classStreamsBlockFor(klass, opts)` picks the matching `<klass>Monitor.streams` block; `_classSettingsOverlay(flatSettings, classStreams)` overlays the per-stream values onto the flat baseline before passing to each stream subtab so each class renders its own saved settings. `showInherit: true`, `showMib: true` (defaults).
- **Assets page → Monitoring Settings modal → Manual Monitoring section** — no class strip (Manual is class-agnostic). DOM id prefix `f-manual-mon-`. Passes `showInherit: false` (bottom of resolver — nothing to inherit) and `showMib: false` (Manual tier doesn't expose per-stream MIB in this iteration). Renderer at `_monsetManualSectionHTML()` in [public/js/assets.js](public/js/assets.js).
- **Assets page → Monitoring Settings modal → Class Overrides editor (Add / Edit)** — no class strip (manual-scope only, per the Phase 1 narrowing). DOM id prefix `monset-ov-`. Passes `showInherit: true` (class overrides legitimately defer to the integration / manual tier below) and `showMib: true` (per-stream MIB pickers are meaningful here). Renderer at `_monsetOpenOverrideEditor()` in [public/js/assets.js](public/js/assets.js). Sub-row visibility is wired locally — `_refreshOvStreamSubRows()` toggles the per-credtype credential rows (`<pollId>-credrow-snmp` / `-ssh` / `-winrm`) and the MIB row (`<prefix>tier-<mibStreamKey>-mib-wrap`) based on each stream's polling-method pick. Per-stream credential save: the helper renders one select per (stream × credtype); the override save handler picks the select matching the chosen polling method and stores it in the per-stream column (`responseTimeCredentialId` / `cpuMemoryCredentialId` / …) the backend expects. Source kind is hardcoded to `"manual"` for the Inherit-option label.
- **Asset edit modal → Monitoring tab** — no class strip (single asset's overrides). DOES NOT use `_classStreamSubtabHTML` because its DOM id conventions diverge from the asset modal's legacy `f-responseTimePolling` / `f-cpuMemoryPolling` / `f-monitorInterval` / etc. ids that `extractAssetEditData()` reads on save. Instead the renderer in `assetMonitoringFormHTML()` ([public/js/assets.js](public/js/assets.js)) builds per-stream subtab bodies inline using the same visual shape (polling-method `<select>` → cred sub-row → MIB sub-row → cadence + timeout → failure threshold on Response Time only) and wraps them with `_intRenderTabbedBody("asset-mon-streams", streamTabs)`. `showInherit: true` (the Inherit option here legitimately defers to the class / integration / manual tier above the asset). MIB pickers visible per stream. LLDP + Storage subtabs share the system-info cadence with Interfaces (Asset row carries only 4 cadence columns: `monitorIntervalSec`, `cpuMemoryIntervalSec`, `temperatureIntervalSec`, `systemInfoIntervalSec`) — those two subtabs render a "shared with Interfaces" hint instead of duplicating the inputs.

**Key conventions:**
- **Stream list and order:** Response Time → CPU/Memory → Temperature → Interfaces → LLDP → Storage. FortiAP omits Storage (handled by `_streamsForClass("fortiap")`).
- **Per-stream subtab body shape:** polling-method dropdown → credential sub-row (visible when polling needs auth — `snmp`/`winrm`/`ssh`/`rest_api`) → MIB sub-row (visible when polling = `snmp` AND `showMib !== false`) → interval input → timeout input (+ failure threshold on Response Time only).
- **Inherit-option visibility:** `showInherit: true` is the default everywhere EXCEPT the bottom of the resolver hierarchy (Manual Monitoring section). When false, the `<select>` simply lacks the empty-value option; the first concrete method becomes the default. Routes still accept `null` / empty body fields as "no override"; the UI just doesn't offer it.
- **Inherit-option label format:** `Inherit (Source <SourceLabel>: <ResolvedMethod>)` or `Inherit (Source <SourceLabel>: not delivered)` when the source doesn't deliver that stream by default. The asset edit modal's `_populateAssetMonitorTierBadges` overwrites this with the actual resolved value from `/effective-monitor-settings` (e.g. `Inherit (class override: SNMP)`) once the response lands.
- **ICMP filtering:** `_polarisPollingDropdownHTML` filters ICMP out of every stream except `responseTime` — telemetry / interfaces / LLDP / storage all need a real protocol. The backend `validateStreamPollingMethod()` applies the same filter on writes.
- **Source-kind defaults:** `_polarisSourceDefaultPolling` returns `rest_api` for fortimanager/fortigate on CPU/mem/interfaces/temperature, `icmp` for responseTime, `disabled` for LLDP + Storage. AD/Entra/Win/Manual default `icmp` on responseTime, `null` (= "not delivered") elsewhere.
- **DOM id discipline:** stream-subtab inputs use the prefix the consumer's save reader expects. The integration modal's primary subtab uses legacy `f-mon-tier-<pollField>` so `_polarisReadPollingFourStream("f-mon-tier-")` finds them; secondary class subtabs use namespaced `f-mon-classecho-<klass>-` ids that are rendered but never read on save. Manual Monitoring uses `f-manual-mon-tier-` (read by `_polarisReadPollingFourStream("f-manual-mon-tier-")`). Asset edit modal uses bare `f-<pollField>` (read by `_polarisReadPollingFourStream("f-")`).
- **Storage stream MIB:** Storage has no per-stream MIB column on Asset or MonitorClassOverride — `HOST-RESOURCES-MIB` + the vendor disk fallback in `pickVendorProfileMerged` covers it without operator input. The helper skips the MIB sub-row for the storage stream regardless of `showMib`.
- **LLDP + Storage cadence at the asset tier (Phase 2):** the Asset row gains its own `lldpIntervalSec` / `storageIntervalSec` cadence columns and `lastLldpAt` / `lastStorageAt` last-touched stamps alongside `lldpPolling` / `storagePolling`. Each rides its own pg-boss queue (`polaris-monitor-lldp` / `polaris-monitor-storage`) on independent cadences resolved from the per-class streams blocks; the publisher in `monitorAssets.ts` checks `last*At + *IntervalSeconds` to decide when to fire. The legacy `collectSystemInfo` still walks both as session-coalesced side effects on a shared SNMP session — `persistLldpNeighbors` (full-replace + 48 h stickiness) and `enqueueStorageSamples` are idempotent against the dedicated queues' double-walks. Cursor mode keeps both on the systemInfo cadence — the dedicated queues are pg-boss-only.

**When introducing a new polling-method surface:**
- **Reuse `_classStreamSubtabHTML`** — don't fork the helper. Pass the right `idPrefix` and `isPrimary` flag so your save reader can find the inputs.
- **Pick the right `showInherit` flag:** `true` everywhere except the very bottom of the resolver hierarchy (where Inherit would be a misleading no-op).
- **Pick the right `showMib` flag:** default `true` works for every tier above Manual today; pass `false` only when the tier deliberately doesn't expose per-stream MIB picking.
- **Pass the correct `source`** so the Inherit label names the actual source ("FortiGate Direct", "FortiManager Proxy", "Active Directory", "Entra ID", "Windows Server", "Manual"). FMG additionally needs `opts.fmgDirectMode` flipped to match the integration's current Direct Polling toggle state.
- **Use `_streamsForClass(klass)`** to enumerate the streams — never hardcode the six names. FortiAP-specific surfaces will automatically drop Storage.
- **Wrap with `_intRenderTabbedBody(prefix, streamTabs)`** and call `_intWireModalTabs(prefix)` after mounting so the tab strip actually swaps bodies on click. Pick a prefix that doesn't collide with other tab strips on the same page.
- **If your surface diverges in DOM id conventions** (the asset edit modal does), build the per-stream body HTML inline using the same visual shape — polling dropdown + cred sub-row + MIB sub-row + interval + timeout — and reuse `_polarisPollingDropdownHTML` for the dropdown itself so the Inherit-label semantics stay consistent.

---

## Mobile bottom sheet

**What it is:** A modal slide-up panel anchored to the bottom of the viewport on the mobile SPA. Dismissed by tapping the scrim, tapping the X button, or swiping the sheet down. Used for the Device Map site detail, asset interface drilldown, reservation edit + create-by-IP, subnet reserve, topology node detail, and the full asset detail screen.

**Canonical implementation:** `openSiteSheet()` in [public/js/mobile/map-tab.js](public/js/mobile/map-tab.js) + matching `closeSiteSheet()` — use this for the common two-state (open/dismiss) sheet.

**Three-state minimizable variant:** the asset detail sheet (`PolarisAssetDetail.open(id)` in [public/js/mobile/asset-detail.js](public/js/mobile/asset-detail.js)) extends the pattern with a **peek** state for content-heavy sheets the operator wants to keep open while using the page behind. Scrim tap → minimize (slides the sheet down to its header band, measured into `--asset-peek-y`, and hides the scrim so the searchbar is reachable); peek-bar tap → expand; close button → dismiss. **Two-stage swipe-down:** the first swipe-down from expanded snaps to peek, the second swipe-down from peek dismisses. **Swipe-up from peek re-expands** (in expanded state baseline is 0, so upward gestures fall through to native scroll). Wired through `attachSwipeToDismiss`'s `onSwipeDown` / `onSwipeUp` opts (override the default translate-100% animation and the default release-for-native-scroll respectively) plus `baselineTranslate` opt (so drags from a peeked position continue from the peek offset instead of jumping back to natural). Minimize never tears down the DOM, so charts/scroll/per-feature state survive. Capped at 80vh (vs. the generic `.sheet`'s 90vh) and anchored at `bottom: var(--navbar-h) + safe-area` so both expanded and peek states stop at the navbar's top edge instead of covering it. The bottom nav (`.m3-navbar`, z-index 950) sits above the asset sheet (901) and its scrim (900) — so the navbar stays visible + tappable while the asset is open — but below the generic `.scrim`/`.sheet` (1000/1001), so deep drilldowns still take the full screen. Model new minimizable sheets on this; keep simple sheets on `openSiteSheet`.

**Key conventions:**
- DOM shape: one `.scrim` and one `.sheet` element, both appended to `document.body` with unique IDs (`<feature>-sheet-scrim` + `<feature>-sheet`). Close = `remove()` both.
- The sheet's first child is `<div class="sheet-handle"></div>` — the small grabber bar that both signals draggability and is the always-on swipe-dismiss start zone.
- Next comes a `display:flex` header row with the title block on the left and an icon `<button class="icon-btn" id="<feature>-sheet-close" aria-label="Close">` carrying `<svg><use href="#i-close"/></svg>` on the right.
- Three close paths, all calling the same close function: `scrim.addEventListener("click", closeXxx)`, the close button click, and `PolarisTabs.attachSwipeToDismiss(sheet, closeXxx)`. The swipe helper lives in [public/js/mobile/tabs.js](public/js/mobile/tabs.js).
- CSS comes from [public/css/mobile.css](public/css/mobile.css) — the `.scrim`, `.sheet`, `.sheet-handle`, `.sheet-title` rules. Don't invent new container classes; reuse these so the swipe helper's transform composes correctly with the `sheet-in` open keyframe.
- Forms inside the sheet keep their native gesture handling — the swipe helper opts out of `input`, `textarea`, `select`, and `[contenteditable=true]` so iOS text-cursor drag and selection handles work.

**When adding a new instance:**
- Mirror the DOM shape — `.sheet-handle` first, header row with `icon-btn` close button second.
- Wire all three close paths: scrim click, close-button click, and `PolarisTabs.attachSwipeToDismiss(sheet, closeXxx)`.
- The close function `remove()`s both the scrim and the sheet by ID; idempotent so double-fire from a swipe finishing while the user also taps scrim is safe.
- If the sheet is scrollable, the swipe-dismiss helper handles "scroll first, dismiss only when at top" automatically — no extra wiring needed.

---

## Mobile pull-to-refresh

**What it is:** Touch-pull-down on a mobile tab or detail page to re-fetch its data. MD3-style: only a small circular puck moves, body content stays put. The puck rotates with pull progress, flips primary-tinted past the trigger threshold, spins while the caller's onRefresh promise is in flight.

**Canonical implementation:** `PolarisTabs.installPullRefresh(scrollEl, onRefresh)` in [public/js/mobile/tabs.js](public/js/mobile/tabs.js). Wired into the route lifecycle by `installPtrForSpec(spec, ctx)` in [public/js/mobile/app.js](public/js/mobile/app.js) — every route change releases the prior handle + installs a fresh one if the new spec has `onPullToRefresh`.

**Key conventions:**
- Tab specs and detail specs opt in by exposing `onPullToRefresh(ctx)` that returns a Promise. The PTR puck spins until the promise settles; sync returns / non-promises get a 600 ms held-puck fallback.
- Optional `enablesPullToRefresh(ctx)` predicate disables install entirely for one route within a multi-page spec (the More tab uses this to skip its static root menu while still PTR-ing the blocks / subnets / events sub-pages).
- Only tracks a gesture that starts with `scrollEl.scrollTop === 0` — pulling from mid-scroll is left to the browser as normal scroll behavior.
- Form controls (`input`, `textarea`, `select`, `[contenteditable=true]`) opt out so iOS text-cursor drag still works inside any forms on the page.
- Click suppression is left to the browser: a touchmove past ~10 px already cancels the underlying button's `click`, so no `preventDefault` is needed — listeners stay `passive: true`.
- `.app-body` carries `overscroll-behavior-y: contain` so iOS rubber-band doesn't compete with the pull gesture.
- CSS (`.ptr-indicator`, `.ptr-circle`, `.ptr-svg`, `.ptr-indicator.ready`, `.ptr-indicator.refreshing`) lives in [public/css/mobile.css](public/css/mobile.css).
- Skipped on routes where it makes no sense or where touch is owned by another library: Map tab (Leaflet captures touch), Topology tab (Cytoscape captures touch), Site detail (delegates to Map), Search tab (results are query-driven), More root menu (static), Block detail (placeholder), Login.

**When adding a new instance:**
- Define `onPullToRefresh(ctx)` on the tab or detail spec. Return the Promise from the same data-load function the topbar Refresh button uses (or equivalent) — don't fork a separate refresh path.
- The spec's render-time DOM must still be present when the promise resolves; loaders that target `getElementById` should be safe because the user can't navigate away during the PTR gesture without releasing first.
- Whenever the refresh action has variant behavior depending on user role / route parts (e.g. subnet detail's gate-side refresh vs. plain re-pull, or More's per-sub-page dispatch), branch inside `onPullToRefresh` rather than inside the install wiring. Use `enablesPullToRefresh` only for "no PTR at all on this route."
