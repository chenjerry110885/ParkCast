# SDD ledger — plan: tasks/todo.md (Plan 2 — Forecast Artifacts)
Task 1: complete (commits ed4e8ee..35fec53, review clean) — 98 tests
Task 1: minor FOLDED INTO TASK 2 (not deferred): _read_cold has no committed test; reviewer verified missing/empty/malformed dirs manually only. Runs in the live collector once Parquet exists.

=== FIRST LIVE DAY ROLLOVER 2026-09-05 00:01:39 — validates 3 final-review fixes in production ===
  C1 (cold store never produced): compacted 2026-09-04 -> 68,077 bytes. Without the fix this day would have been pruned at 48h.
  I4 (no per-lot coverage): report printed 'incomplete 60 lots missed at least one tick' — surfacing exactly the truncated ticks that were previously invisible.
  Task 9b (metadata frozen at day 1): 'metadata refreshed for 2026-09-05 (1756 lots)'.
  I1 (parquet dropped free_motor/observed_at): all six columns present; 467 lots carry motorcycle data (spec measured 466), lag median 210s = the designed poll offset.
  Ordering correct: compact -> report -> metadata refresh. Nulls preserved (222 of 288 slots), never interpolated.
Task 2: complete pending review (commits 35fec53..84bc3f2) — 108 tests; _read_cold coverage folded in and delivered
Task 2: fix round 1/5 (1 addressed, 0 open — fallback priority order now pinned; controller mutation-verified both order-swap and lot-tier-removal are caught; purely additive, logic untouched; commits 84bc3f2..d48f024)
Task 2: complete (commits 35fec53..d48f024, review clean) — 110 tests
Task 2: NOTE — the reviewer flagged a CLAUDE.md commit as implementer scope creep. It was the CONTROLLER's commit (f30faac), swept in by a badly-chosen review range. Not an implementer deviation. Build review ranges from the implementer's commits only.
Task 2: minor (deferred): 3 of the 4 _read_cold tests assert only by_lot == {}, so they'd pass against a wholly broken reader; the round-trip test is the one that genuinely covers the path.
Task 3: complete (commit 3a29ca0) — blend forecaster, 116 tests. Real-data check: blend decays 0.9147 (+5m) -> 0.8952 (+120m), converging on climatology 0.8938. Correct by construction.
Task 3b: complete (commit 4ea4ef0) — CONTROLLER-FOUND BUG via real-data check: load_history double-counted the hot/cold overlap because compact_day snaps timestamps to the slot grid while hot keeps true data_ts (18:33 vs 18:30), so duplicates carried different timestamps and were invisible to dedup. History read 145,430 where truth was 73,800; most recent 48h got double weight in the climatology baseline Plan 4 must beat. Fixed by snapping the earliest hot ts and taking cold strictly before it. Controller mutation-verified. 120 tests.
Task 4: complete (commit 4d2aecb) — grid builder, 127 tests. Real grid: 26,112 B, 1088 lots, correct horizon decay.
Task 5: complete (commit 88236bc) — artifact encode/publish, 135 tests. Real artifacts: grid.bin 26,129 B (gzip 1,912 B), lots.json 148,132 B (gzip 27,953 B) = 29 KB over the wire.
Task 6: complete (commits 97ac9f8, 4aa2761) — publish each tick, 140 tests.
Task 6: CONTROLLER-FOUND BUG (Important, fixed): publish_artifacts wrote an empty grid and {"lots":[]} over good artifacts when the lot list was empty. Reachable in production — the I3 startup tolerance deliberately starts with no lots on a metadata outage, so a container restart during one would blank the site citywide until the next day rollover. Now refuses to publish and keeps the stale-but-valid artifacts.
Task 6: minor (deferred): __main__._lots is module-level mutable state set as a side effect of build_capacities. Accepted: test_main asserts refresh_metadata is build_capacities by identity, which rules out wrapping; rewriting risks the contract for a stylistic gain.
Task 7: complete (commit 21caee3) — 141 tests; integration test PASSED against real data (not skipped).
PLAN 2 LIVE 2026-09-05 00:51 onward: three consecutive tick->publish cycles; grid.bin 26,129 B and lots.json 148,132 B republished every 5 min; 90,484 rows / 77 ticks intact through the restart; publish adds ~10s inside a 300s slot.
OPERATIONAL FINDING: 'docker compose up -d --build' can leave the OLD container running; --force-recreate is required. Earlier Plan 1 restarts did take effect (proven by the rollover compaction and metadata-refresh log lines), but this should be documented.

=== ALL 9 PLAN 2 TASKS COMPLETE. 141 tests. Artifacts publishing live. ===

=== PLAN 2 FINAL REVIEW: 2 Critical + 3 Important + minors. All fixed across two waves. Re-review verdict: MERGEABLE. 175 tests. ===
  C1 artifact pair had no shared identity -> stamped, then roster_id added (CRC32 of the ordered lot-id sequence) so lots.json stays cacheable across ticks. Header 17 -> 21 bytes; format frozen deliberately before merge.
  C2 load_history holds the whole corpus in memory, rebuilt each tick (67-108 B/obs -> ~1 GB by day 30, ~8-12 GB by day 365). NOT FIXED - structural, weeks of runway. MUST be scheduled before ~day 20.
  I3 redundant ORDER BY cost 11.19s vs 0.16s (70x, non-covering index). Removed; publish latency 11.4s -> 0.47s live.
  I4 climatology returned raw hits/total from ~6 samples: 96.1% of cells exactly 0/1, 79% of grid bytes 0 or 100. Hierarchical Beta shrinkage (bucket->lot->global, priors 8/20) + Jeffreys on the global tier: 0.0% degenerate.
  I5 no leak-free way to build a train-only History -> before_ts added, filtering hot and cold; then latest_ts/current derived from by_lot so a >48h backtest cutoff still has a Persistence baseline.
  MIN_SUPPORT removed deliberately: shrinkage is the continuous form of the same protection; a 0-observation bucket now evaluates to exactly the lot rate, so the chain has no cliff.
PARKED: roster_id is a CRC, not an integrity check. Plan 3 MUST compare roster_id (not generated_at) to decide whether to re-fetch lots.json, or the caching it enables is defeated.
PARKED: climatology hierarchy is untested AS a hierarchy - a mutation shrinking the bucket toward global instead of lot passes all tests. Needs a fixture where lot != global and the bucket is present.
