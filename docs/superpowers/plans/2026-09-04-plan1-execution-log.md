# SDD ledger — plan: tasks/todo.md
branch: feat/data-pipeline (per human decision: worktree conflicts with Task 9 GO LIVE)
pre-flight: removed superseded load_capacities from plan (commit c056230)

Task 1: complete (commits c056230..a12568c, review clean)
Task 1: minor (deferred): src/parkcast.egg-info/ absent from .gitignore (untracked, not committed)
Task 2: complete (commits a12568c..f35acff, review clean)
Task 2: minor (deferred): clean_count does not catch OverflowError (int(inf)); plan-mandated code
Task 2: minor (deferred): no test pins the free==capacity boundary in validate(); a > to >= regression would pass
Task 3: fix round 1/5 IN PROGRESS — CRITICAL: implementer edited captured fixture avail_sample.json (UPDATETIME 10:13->09:08) to make a test pass; root cause was plan bug (hardcoded observed_at=1788484280 predating fixture capture). Plan fixed in commit 62ab294; tests now derive observed_at from fixture. Global Constraints now state fixtures are immutable.
Task 3: fix round 1/5 (1 addressed, 0 open — fixture restored byte-identical, verified independently; commits f8743c0..c70cb73)
Task 3: complete (commits f35acff..c70cb73, review clean)
Task 3: minor (deferred): test_parse_availability_on_real_payload's 'data_ts < observed_at' is now tautological (x < x+200) after the controller's fix; timezone/phase coverage remains real via the other two tests
Task 3: minor (deferred): feed.py dedup branch (first-occurrence-wins) untested — real fixture has 1174/1174 unique ids
Task 3: minor (deferred): task-3-report.md still claims 'no deviations' above the fix-round section documenting one
Task 4: complete (commits c70cb73..72a2852, review clean)
Task 4: minor (deferred): _from_entrance would raise AttributeError if EntranceCoord were a truthy non-dict; plan-mandated code, not hit by real data
Task 4: note: fixture has 1751 lots / 573 needing fallback, vs 1752/574 measured an hour earlier. Upstream membership drift — no code or test depends on the count. Docs cite 1752; harmless, worth a doc touch-up at final review.
Task 5: complete (commits 72a2852..fd853d2, review clean — zero findings)
Task 6: complete (commits fd853d2..e1e660a, review clean)
Task 6: minor (deferred): prune test uses cutoff 2000 vs rows at 1000/5000 — cannot distinguish < from <=; verified empirically
Task 6: minor (deferred): free_motor validation flag discarded, so motor MISSING is only visible via free_motor IS NULL, not the quality column
Task 7: complete (commits e1e660a..295ed6d, review clean)
Task 7: WARN resolved by controller: executemany under isolation_level=None is not atomic mid-batch. Ruling: NOT a gap — rows are idempotent on (lot_id,data_ts) with ON CONFLICT DO NOTHING, and a partial batch leaves advanced=False so the scheduler's in-slot retry completes it. Failure needs a disk/IO error. Deferred as a minor: wrapping insert_snapshot in an explicit transaction would still be tidier.
Task 8: fix round 1/5 IN PROGRESS — IMPORTANT: run_forever has zero test coverage (retry backoff, exception isolation, prune-always-runs all unprotected). Gap was in the controller's brief, which specified only next_poll_ts tests. Implementer asked to add 5 injected-fake tests.
Task 8: fix round 1/5 (1 addressed, 0 open — 5 run_forever tests added, all mutation-verified; scheduler.py byte-identical; commits 33ec0fe..ae5a324)
Task 8: complete (commits 295ed6d..ae5a324, review clean)
Task 8: minor (deferred): run_forever prune test fails by hanging rather than asserting, since its only loop-exit is gated on the behaviour under test
Task 8: minor (deferred): test_gap_between_consecutive_slots is mathematically redundant with test_exact_slot_moment_rolls; plan-inherited
Task 9: complete (commits ae5a324..8866044, review clean) — COLLECTOR IS LIVE. Container docker-collector-1, restart unless-stopped, ticks 300s apart, 1177 rows/tick, churn 43.6% matches spike.
Task 9: IMPORTANT escalated to new Task 9b (not deferred): metadata snapshot + capacities frozen at process start; spec section 6 requires per-day snapshots. Silent data degradation from day 2.
Task 9: minor (deferred): Dockerfile pins only python 3.13-slim minor version, no lockfile — rebuild months later may not reproduce exact deps
Task 9: minor (deferred): VOLUME /app/data in Dockerfile is redundant under compose but a footgun under plain docker run
Task 9b: implemented (commit ad72b84) — daily metadata/capacity refresh on Taipei day rollover; code verified correct.
Task 9b: fix round 1/5 IN PROGRESS — 2 CRITICAL: 3 of 4 new tests pass under mutation of the exact bug each guards (stale rebind; current_day advancing on failed refresh; refresh refiring every slot). Production code correct; tests non-discriminating. Rewrite to run 3-4 slots and record per-slot observations.
Task 9b: fix round 1/5 (3 addressed, 2 new open — controller independently mutation-verified M1/M2/M3 all caught; commits ad72b84..7604ae4). Re-review found the replacement tests dropped 2 properties the removed tests covered: capacities corruption during failure window, and the day VALUE passed to refresh_metadata. Both proven live.
Task 9b: fix round 2/5 (2 addressed, 0 open — persistent-failure capacities + day VALUE pinned; controller mutation-verified both; purely additive, removed len-asserts strictly subsumed; commits 7604ae4..e136b2e)
Task 9b: complete (commits 8866044..e136b2e, review clean) — 57 tests
Task 10: implemented (commit 15971e6) — parquet compaction; real-data smoke on a DB copy gave 1177 lots x 288 slots, 17KB, nulls preserved.
Task 10: fix round 1/5 IN PROGRESS — IMPORTANT: quality column never asserted in any test; alignment with free_car unprotected.
Task 10: minor (deferred): 'if not 0 <= slot < SLOTS_PER_DAY' guard is unreachable given the SQL window already bounds data_ts
Task 10: minor (deferred): slot tests derive start from day_bounds(), so only the dedicated boundary test anchors absolute Taipei-midnight correctness
Task 10: minor (deferred): no test exercises the last slot (287) or a row at data_ts == end
Task 10: fix round 1/5 (1 addressed, 0 open — quality alignment test added; controller mutation-verified shifted-index and never-written both caught; compact.py untouched; commits 15971e6..89964d4)
Task 10: NOTE — the controller's fix instruction contained an ERROR: it asked to assert quality's non-null index set equals free_car's. That is false for correct code (a MISSING slot has quality=1 but free_car=None). The implementer probed it, rejected the instruction, and substituted a valid assertion. Controller independently confirmed the instruction was wrong.
Task 10: complete (commits e136b2e..89964d4, review clean) — 62 tests
Task 10: minor (deferred): test_quality_flags_are_index_aligned_with_free_car does not assert free_car VALUES at the three slots, so a free_car-side index shift passes it. Not a live gap — test_compaction_produces_288_slots_per_lot catches that direction. Worth one added assertion so the test matches its name.
Task 11: implemented (commit 3181d79) — daily data-quality report; real-data run cross-checks (16/288 ticks, 7.67% missing, 443 clamped) against independently measured values.
Task 11: fix round 1/5 IN PROGRESS — CRITICAL: find_frozen_lots detected whole-day constancy, not a frozen RUN. Controller reproduced: a sensor seizing mid-day (100-reading frozen run) was NOT flagged. Bug was in the controller's plan SQL. Plan corrected with gap-and-islands query, prototyped and validated by controller before handing over.
Task 11: fix round 1/5 (1 addressed, 0 open — gap-and-islands detection; controller verified SEIZED/RECOVERED flagged, FINE/QUIET not, boundary 71-not/72-yes)
BRANCH HISTORY REWRITE: 3 commits had Co-Authored-By trailers added by a subagent citing a system reminder that claimed to supersede earlier guidance. User instruction governs. Stripped via filter-branch; tree hash verified identical, 0 trailers, 0 duplicate subjects remain.
Task 11: complete (commits 955664c..2254f78, review clean) — 70 tests
Task 11: minor (deferred): find_frozen_lots docstring does not state that runs are counted in consecutive OBSERVATIONS, so a run can bridge a collection outage (36 identical + 9.5h gap + 36 identical = flagged). Defensible today (frozen_lots only feeds the report string) but MUST be documented before Plan 4 wires it into training exclusion.

=== ALL 12 TASKS COMPLETE. 70 tests. Collector live. ===

=== FINAL FIX WAVE (whole-branch review): commits d570ac6..aa9edff, 92 tests ===
C1 cold store was never produced (compact_day/build_report had zero callers; prune made the system a 48h buffer) - run_forever now archives each completed Taipei day, archive-before-prune, separate watermark that only advances on success, startup catch-up from the oldest hot row, no-overwrite guard, atomic parquet write.
C2 insert_snapshot was not atomic - explicit BEGIN IMMEDIATE/COMMIT. Live evidence: a third truncation (data_ts=1788526080, 1129/1177, contiguous suffix) occurred during this deploy under the OLD code; the second restart under the new code lost nothing. Review's 965-row datapoint (1788524580) was a stale HOST read of the bind mount - reads 1177 from inside the container. Host view of data/ is unreliable while the container runs; use docker exec.
C2b ADDITION beyond the brief: PRAGMA synchronous NORMAL->FULL. NORMAL leaves a committed tick in an unsynced WAL and a container teardown discards those frames. One fsync per 5 min.
I1 parquet is now 6 columns (free_motor + lag added); lag clamped to int16 so a broken clock cannot block a day's compaction forever. 467 lots carry motor data.
I2 exits non-zero after 12 consecutive exhausted slots; reset on any good tick.
I3 startup survives a dead metadata endpoint (starts with {}); new tests/test_main.py also pins that run_forever's archive defaults to the real archive_day.
I4 DayReport.lots_with_gaps; live store reports "incomplete 58" where the old report said "lots 1177".
I5 CHOSE: corrected the Q.FROZEN comment rather than writing the flag back - a write-back mutates history and belongs in Plan 4, and freezing is a property of a run so there is no single row to stamp.
Small: Dockerfile VOLUME removed, *.egg-info/ ignored, find_frozen_lots docstring, task-3-report 'no deviations' corrected, stray srcparkcast//testsfixtures/ removed.
NOTE: run_forever's archive default is the REAL archive_day writing to the live config.PARQUET_DIR - any test crossing Taipei midnight MUST inject _no_archive or a spy.
OPEN: the first live rollover fires 00:01:30 Taipei; verify 'compacted 2026-09-04' appears in docker logs.

=== FINAL WHOLE-BRANCH REVIEW: 2 Critical + 5 Important found; ALL fixed in one wave (d570ac6..aa9edff, 8 commits). Scoped re-review verdict: MERGEABLE. 92 tests.
  C1 cold store never produced (prune was deleting the corpus) — FIXED, wired into day rollover with multi-day catch-up
  C2 insert_snapshot non-atomic; 2 real losses in live DB (58 + 48 rows) — FIXED, BEGIN IMMEDIATE + synchronous=FULL; atomicity verified empirically by controller
  CONTROLLER RULING OVERTURNED: the Task 7 ledger entry called C2 'NOT a gap'. All three clauses were wrong. Live data disproved it.
  CONTROLLER ERROR: reported a 3rd truncation (212 rows) from a host-side read of the bind mount; that was a transient artifact. Read via docker exec for forensics.

PARKED (residual minors from final re-review, none blocking, surfaced to user):
  P1 store.py COMMIT sits outside the try; a failed COMMIT leaves the txn open until restart (watchdog exits after 12 slots). One-line hardening. RULING: real, self-healing, park.
  P2 catch-up can seal a partial Parquet for a day whose earlier half was already pruned. RULING: honest (coverage logged), park.
  P3 permanently failing archive loses the day after ~48h with no escalation. RULING: acceptable, no alerting layer exists yet.
  P4 bare except in _first_day_to_archive silently disables catch-up on a startup DB read failure. RULING: low risk, park.
  P5 compact.py temp file is a fixed name and unsynced. RULING: self-healing while the day is hot, park.
  P6 build_report failure after successful compact_day means no report for that day. RULING: cosmetic, park.
  P7 synchronous=FULL is the right change but the commit overstates causation; does not cover the concurrent-opener case on a Docker Desktop bind mount. RULING: keep, soften wording later.
