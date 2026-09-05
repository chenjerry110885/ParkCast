# SDD ledger — plan: tasks/todo.md (Plan 2b — Bounded History)

=== HOSTING DECISION 2026-09-05: keep the collector LOCAL until there is a working product. ===
  Rationale: user requires no cost and no new attack surface. Verified that GCP always-free e2-micro
  requires a billing account with a card, that budget alerts explicitly do NOT cap spending
  (Google's own wording), and that the external IPv4 charge question could not be resolved from
  official docs. Oracle always-free documents idle reclamation (all of CPU/network/memory under 20%
  over 7 days) which this workload trips on every criterion.
  Consequence accepted: the corpus will carry time-correlated gaps whenever the machine sleeps
  (2026-09-05 lost ~10.7h / ~129 ticks). This MUST be disclosed in the README and in Plan 4's
  evaluation - climatology buckets for unobserved hours will be thin or empty.
  Security posture verified: 64 commits scanned, no credential-shaped strings; 0 files tracked under
  data/; nothing binds a port; one outbound destination (the public Taipei feed).
Task 1: complete (commit daa0af2) - Counts accumulator, 180 tests
Task 2: complete (commit 55c220d) - ColdCountCache + date ownership, 190 tests. Deviations: brief's
  3-arg counts_through calls fixed to the specified 2-arg signature; cache holds counts per
  directory (a single global accumulator broke the brief's own survival test via the shared
  _COLD_CACHE); tests/test_scheduler.py isolated from the live data/cold, which it had been reading
  and which owns 2026-09-04 - the day those fixtures seed. Grid sha256 byte-identical on a live
  snapshot. NOTE: warm load_history is 0.14s -> 0.25s until Task 3 removes the now-redundant
  uncached _read_cold; the speedup lands with Task 3, so do not leave it long.
Task 3: complete (commit 898df5b) - History.recent bounded to config.HISTORY_TAIL=24 via a per-lot
  min-heap; Climatology reads history.counts; serving path no longer re-streams the cold corpus.
  199 tests. Deviations: min-heap not deque(maxlen) (the hot scan has no ORDER BY, so a deque keeps
  the last row to ARRIVE, not the newest - pinned by a new hostile-connection test);
  scheduler's row filter is history.counts.lot, not .recent (the filter asks a whole-corpus
  question, and .recent would drop every cold-only lot from the grid); six existing tests changed
  meaning, not just name, because they asserted corpus-wide facts through by_lot.
  CORRECTION to the Task 2 note: the 0.14 -> 0.25s regression was ~90% Counts.add on the hot stream
  (0.091s), NOT the redundant _read_cold (0.020s at one cold day). That counting used to happen in
  Climatology.__init__; it moved earlier so the observations can be dropped. Task 3 therefore only
  recovers 0.013s at today's corpus - the win is that the cost is now FLAT in corpus age:
  warm load_history 1.425s -> 0.293s at 30 cold days, 3.693s -> 0.320s at 90.
  Full publish tick (load+Blend+build_grid) at 30 cold days: 2.409s/252MB -> 0.330s/23MB.
  History resident 247.4MB -> 17.8MB at 30 days, and flat (bucket cells saturate at 7 days).
  Grid sha256 byte-identical on a live snapshot (1,089 lots x 24 horizons).
  FLAKE OBSERVED: test_end_to_end_over_real_observations failed once then passed 4x - it copies the
  live WAL-mode sqlite with shutil.copy while the collector writes. Pre-existing; use the backup API.
Task 2: complete (commit 55c220d) — cold-count cache + date ownership, 190 tests. Mutations verified: dropping _folded and restoring the sliding cutoff each caught. _snap_to_slot removed cleanly. Found and fixed a pre-existing leak: 8 scheduler tests were reading the LIVE data/cold.
Task 3: complete (commit 898df5b) — bounded recent tail + Climatology on counts, 199 tests.
  PLAN WAS WRONG TWICE, implementer caught both: (a) plan said deque(maxlen) but the hot scan has no ORDER BY, so a deque keeps the last row to ARRIVE not the newest — min-heap used instead, with a hostile-conn test; (b) scheduler must filter on counts.lot not recent, or cold-only lots vanish from the grid.
  Controller-verified on the real corpus: warm load 0.23-0.24s and IDENTICAL to hot-only (0.262s), so cold costs ~nothing per tick; memory 9.1 MB; worst per-lot tail exactly 24 = cap; counts span 210,200 observations = 8x what is retained.
  Agent-measured slope: 1/10/30/90 cold days was 0.232/0.614/1.425/3.693s, now 0.227/0.249/0.293/0.320s. Memory at 30 days 247.4 MB -> 17.8 MB, flat thereafter.
Task 4: complete (commit 27a66e2) — bound + latency guards, 201 tests. Also fixed the WAL torn-snapshot flake by using sqlite backup() instead of shutil.copy in both integration tests.
EQUIVALENCE PROVEN: controller ran a clean git worktree of main vs the branch against the SAME snapshot — both produced 1089 lots, sha256 cf7e1a3d153ed508. Plan 2b changed performance, not the model.

=== PLAN 2b FINAL REVIEW: 0 Critical, 2 Important, both fixed. Verdict: MERGEABLE. 206 tests. ===
  I1 a re-stamped Parquet file double-counted instead of replacing (reproduced with byte-identical content: [1445,1445] -> [2885,2885] after a simulated restore). Trigger is operational - a restore, rsync or volume migration. Docstring claimed the opposite and a test pinned the wrong behaviour. Fixed: re-fold on (mtime,size) change, with a warning; a vanished file resets too.
  I2 an all-NULL hot window published a grid stamped base_data_ts=0, bucketing every horizon at Thursday 08:05 Taipei 1970. main did NOT do this, so it violated the branch's own behaviour-must-not-change constraint. Fixed with a latest_ts==0 guard.
  Also pinned: hot and cold agree only because CLIMATOLOGY_BUCKET_MIN is a multiple of the 5-min slot. Now a comment and a test.
PARKED with rulings:
  P1 the backtest path makes two passes over the cold corpus (~1050s/cutoff at day 365 vs main's 525s). RULING: the serving path is what this branch fixed; Plan 4 calls it once per cutoff. Park.
  P2 recent interleaves duplicate readings on the backtest path. RULING: harmless - only current/latest_ts read it today. Park, but a future lag feature must not assume tail spacing.
  P3 a whole-directory re-fold is O(corpus) inside a tick (~526s/year). RULING: fires only when something rewrote data/cold; correctness beats latency there. Park.
  P4 a lot that stops reporting keeps a grid row forever via counts.lot. RULING: product decision, out of scope.
