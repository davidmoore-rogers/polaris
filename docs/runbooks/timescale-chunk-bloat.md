# Runbook: TimescaleDB compressed-chunk decompress-on-DELETE bloat

**Symptom:** The DB data volume is filling rapidly; `chunk_compression_stats` shows compressed chunks whose on-disk size is many times their compressed bytes (low-density heap), with few or zero live tuples. Prod incident 2026-06-08: `asset_interface_samples` reached 114 GB total, including a single ~63 GB uncompressed chunk and several compressed chunks at 0 live tuples / ~10 GB on disk holding only ~350 MB of real columnstore data.

This is the canonical TimescaleDB failure mode behind the FK-less sample tables. Read it before manually deleting or vacuuming anything in the sample tables.

---

## Background — why this happens

Polaris stores its monitoring time-series in TimescaleDB hypertables (`asset_*_samples`, plus their `*_hourly` / `*_daily` rollups). Old chunks are compressed (columnstore) per the `TIMESCALE_COMPRESS_AFTER_DAYS` window (default 7).

The selection-aware detail tables — `asset_interface_samples`, `asset_storage_samples`, `asset_ipsec_tunnel_samples` — carry a mix of operator-selected (`cadence="fast"`, full retention) and unselected (`cadence="slow"` / legacy NULL) rows. Unselected rows are pruned at 24h via a row-level `deleteMany`.

The trap: **a row-level `DELETE` (or `UPDATE`, or a cascade `DELETE`) that matches even one row inside a COMPRESSED chunk forces TimescaleDB to decompress the entire chunk into its rowstore heap to perform the operation.** Autovacuum then reclaims the dead tuples to the free-space map but never returns the pages to the OS. The result is a multi-GB low-density heap that `compress_chunk` refuses to touch (it reports "already columnstore"), so only a relation rewrite (`VACUUM FULL`) reclaims it.

`asset_interface_samples` is the canonical victim: ~64M rows/day written, nearly all unselected and DELETEd at 24h. If those deletes ever reach a compressed chunk, the chunk bloats and never shrinks.

The two fixes already in the codebase:
- **Prevention:** the slow/unselected prune lower-bounds its delete window at the compressed-chunk frontier so it never touches a compressed chunk — `src/services/sampleRetentionService.ts -> unselectedSlowPruneWindow()`, which floors at `src/services/timescaleService.ts -> getEffectiveCompressAfterDays()`.
- **Self-heal:** a nightly safety net VACUUM-FULLs already-bloated compressed chunks — `src/jobs/reclaimBloatedChunks.ts -> findBloatedChunks()` / `reclaim()`.

---

## Diagnose

### 1. Confirm the volume is filling and find the table

Maintenance tab → Database card shows per-filesystem volume bars; the boot-time `src/utils/startupDiskCheck.ts -> runStartupDiskCheck()` also logs per-volume free space. To find the offending hypertable:

```sql
SELECT hypertable_name,
       pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)) AS total
  FROM timescaledb_information.hypertables
 ORDER BY hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass) DESC;
```

The selection-aware detail tables (`asset_interface_samples` first) are the expected offenders.

### 2. Find the bloated compressed chunks

This is the exact scan `reclaimBloatedChunks` runs (`src/jobs/reclaimBloatedChunks.ts -> findBloatedChunks()`). Run it per suspect table — a chunk is bloated when its on-disk size dwarfs its compressed bytes:

```sql
SELECT format('%I.%I', s.chunk_schema, s.chunk_name)                                          AS chunk,
       pg_size_pretty(pg_total_relation_size(format('%I.%I', s.chunk_schema, s.chunk_name)::regclass)) AS on_disk,
       pg_size_pretty(s.after_compression_total_bytes)                                          AS compressed
  FROM chunk_compression_stats('asset_interface_samples') s
 WHERE s.compression_status = 'Compressed'
 ORDER BY pg_total_relation_size(format('%I.%I', s.chunk_schema, s.chunk_name)::regclass) DESC;
```

A chunk counts as bloat in the job when `on_disk >= 256 MB` AND `on_disk > 3 × compressed` (`MIN_BLOAT_BYTES` / `BLOAT_RATIO`). Confirm the chunk has few/zero live tuples:

```sql
SELECT n_live_tup, n_dead_tup, pg_size_pretty(pg_total_relation_size('_timescaledb_internal._hyper_X_YYY_chunk'::regclass))
  FROM pg_stat_user_tables
 WHERE relname = '_hyper_X_YYY_chunk';
```

### 3. Find UNCOMPRESSED chunks that should have been compressed

A large uncompressed recent chunk (the 63 GB chunk in the incident) means the compression policy isn't firing — usually because the host restarts more often than the policy's 12h schedule (in-app updates cycle `polaris.target`), so the policy keeps resetting its `next_start`. See `src/services/timescaleService.ts -> compressionPolicyMatches()` / `compressEligibleBacklog()`.

```sql
SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk,
       range_start, range_end, is_compressed
  FROM timescaledb_information.chunks
 WHERE hypertable_name = 'asset_interface_samples'
   AND is_compressed = false
 ORDER BY range_start ASC;
```

Any uncompressed chunk whose `range_end` is older than the effective compress-after window (≥ 2 days for selection-aware tables) is overdue.

---

## Recover

Recovery has two halves: get overdue chunks compressed, then reclaim the bloated heap.

### A. Let the application self-heal (preferred)

Both fixes run automatically on the scheduler role:
- At boot, `migrateToHypertables()` runs `compressEligibleBacklog()`, compressing up to 8 overdue chunks per table immediately (not waiting on the 12h policy).
- Every 6h (first run 10 min after boot), `reclaimBloatedChunks` scans for bloated compressed chunks and `VACUUM (FULL)`s up to 12 per run on a dedicated direct connection with a 5s `lock_timeout` (retried, so it slots into a read gap rather than blocking live writes).

If you have time and headroom, restart the scheduler/web process and watch the journal:

```bash
# RHEL/Ubuntu split-role layout
sudo journalctl -u polaris-web -u 'polaris-monitor@*' -f --no-pager | grep -Ei 'compress|reclaim|bloated|hypertable'
```

Look for `Compressed N backlog chunk(s)` and `Reclaimed bloated compressed chunk`.

### B. Manual recovery (volume critically full, can't wait)

Run on a **direct** psql connection (bypass PgBouncer — use `POLARIS_DB_DIRECT_URL` if set). Compress overdue chunks first so future deletes can't bloat them, then rewrite the bloated ones:

```sql
-- 1. Compress an overdue uncompressed chunk (shrinks the 63 GB-style chunk).
SELECT compress_chunk('_timescaledb_internal._hyper_X_YYY_chunk'::regclass);

-- 2. Rewrite a bloated compressed chunk to return pages to the OS.
--    Near-instant on a 0-live-tuple chunk. Set a short lock_timeout so you
--    don't block live monitoring writes; retry if it times out (55P03).
SET lock_timeout = '5s';
VACUUM (FULL) _timescaledb_internal._hyper_X_ZZZ_chunk;
```

Do NOT `DROP` or `TRUNCATE` chunks by hand and do NOT manually `DELETE` rows to "clean up" — a DELETE against a compressed chunk re-triggers the exact decompress-on-DELETE bloat you're recovering from. Whole-chunk retention is handled by `drop_chunks` (`src/services/timescaleService.ts -> dropChunks()`), which is decompression-free.

If the volume is so full that VACUUM FULL can't allocate its rewrite scratch, free a few hundred MB first (see `docs/INSTALL.md` → "Recovery: postgres crashes on a full /var"), then proceed.

---

## Prevent

1. **Never row-`DELETE` or `UPDATE` sample rows that could land in a compressed chunk.** This is a hard invariant. The slow/unselected prune is the only delete path against these tables and it is bounded off compressed chunks by `unselectedSlowPruneWindow()`. Any new code that touches sample rows must respect the same frontier.
2. **Never re-add a foreign key from a sample table to `Asset`.** The FK was cascade-dropped in migration `20260615000000` precisely because a cascade `DELETE` from deleting an Asset would decompress matching chunks. Deleting an Asset deliberately orphans its sample rows (queried only by `assetId`, never surfaced) to age out via `drop_chunks`.
3. **Keep compression actually running.** Don't set `TIMESCALE_COMPRESS_AFTER_DAYS=0` on a busy fleet — that disables compression entirely and lets uncompressed delete-churn heap grow unbounded. If chunks aren't compressing, check the policy schedule (`compressionPolicyMatches()`) and confirm the boot-time `compressEligibleBacklog()` pass is logging.
4. **Whole-chunk retention only.** Prune the selection-aware tables via `drop_chunks` at chunk granularity (1-day chunks for these tables) — never per-row across the compressed frontier.

---

## Related

- `CLAUDE.md` → Domain Model note on the eight sample tables ("These sample/rollup tables … carry `assetId` but NO foreign key to Asset … never row-DELETE/UPDATE sample rows that could sit in a compressed chunk").
- `CLAUDE.md` → Business Rules & Constraints; Environment Variables (`TIMESCALE_COMPRESS_AFTER_DAYS`, `POLARIS_DB_DIRECT_URL`).
- `TOUCHES.md` → `cross-cutting/tiered-sample-retention` and the `timescaleService.ts` per-service entry.
- `docs/INSTALL.md` → "Recovery: postgres crashes on a full /var".
- Code: `src/services/timescaleService.ts`, `src/services/sampleRetentionService.ts`, `src/jobs/reclaimBloatedChunks.ts`.
