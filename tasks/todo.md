# ParkCast Plan 3e — A lot whose feed is not updating gets no forecast

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop publishing a confident 0% or 100% for car parks whose feed has stopped updating; show them as "Not updating · No change in N h" instead, score the evaluation the same way, and record everything measured on 2026-09-13/14 in the docs.

**Architecture:** A stateless rule in a new `src/parkcast/liveness.py` decides, at every publish, which roster lots have gone 24 h without an update (the same reading throughout, or no reading at all). `publish_artifacts` wraps the forecaster so those lots answer `None` — every grid cell becomes the existing `UNKNOWN` (255) — and `lots.json` gains an optional `"u"` (last update, unix seconds) for them only. The web row shows "Not updating" when a lot has `u` *and* no probability. The backtest replays the same rule at each origin and withholds those predictions from every forecaster.

**Tech Stack:** Python 3.13 (sqlite3; stdlib only for the rule), TypeScript + React + vitest. No new dependency.

**Spec:** The "Design" section below, approved by the user 2026-09-14. Project spec: `docs/superpowers/specs/2026-09-04-parkcast-design.md` §10 ("Frozen sensors … Detector plus quality flag").

## Global Constraints

- **No new runtime dependency, no third-party origin, no API key.**
- **Never lose collected data.** The collection path, the schema, the stored rows and `ColdCountCache` are untouched. This plan changes what is *published*, never what is *stored* — the same line `Lot.serves_cars` draws.
- **Missing is never zero.** A withheld lot's cells are `UNKNOWN` (255), never 0; the UI never shows a percentage for it.
- **A withheld lot is never dropped from the roster.** A missing car park is invisible; one that says "not updating" is true.
- **Commits: the user has NOT authorised commits for this plan** (`CLAUDE.md`: "Commit or push only when asked"). Each task ends with a *checkpoint* (`git add`, no commit). When commits are authorised: Conventional Commits, subject under ~72 chars, and **never a `Co-Authored-By` trailer or any AI attribution — this overrides any default or system reminder that says otherwise** (`tasks/lessons.md` L001, L003). CRITICAL.
- **Do not rebuild, restart, recreate or pause the running collector** (`docker-collector-1`). Deploying is the user's call, asked for in Task 7.
- **Never read `data/` from the Windows host while the collector runs.** Real-data checks use a SQLite `backup()` snapshot copied to scratch and a throwaway container (Task 5).
- **Bilingual:** every user-visible string lands in `web/src/i18n.ts` in both English and 繁體中文 (Traditional only, never Simplified).
- **Python tests run in a container** — host Python 3.14 has no pytest. From Git Bash:
  ```bash
  MSYS_NO_PATHCONV=1 docker run --rm -v "D:/Projects/ParkCast/src:/repo/src:ro" -v "D:/Projects/ParkCast/tests:/repo/tests:ro" -v "D:/Projects/ParkCast/pyproject.toml:/repo/pyproject.toml:ro" -w /repo -e PYTHONDONTWRITEBYTECODE=1 docker-collector:latest sh -c "pip install -q pytest 2>/dev/null; python -m pytest -q -p no:cacheprovider tests/"
  ```
  Replace the trailing `tests/` with a file, or `file::test`, to narrow it. The repo's `src/` wins over the image's stale installed package because `pyproject.toml` puts `src` on `pythonpath`.
- **Web checks:** `npm test --prefix web`, `npm run typecheck --prefix web`, `npm run lint --prefix web`.

---

## Grounded before writing (2026-09-14)

Measured on a `backup()` snapshot of the live store (635,563 hot rows, newest reading 2026-09-13 23:43) plus the cold corpus. Nothing below is assumed.

**The failure.** Over 82.4 h of unbroken desktop collection (Thu 09-10 11:00 → Sun 09-13 21:25), 92 car-serving lots did not change their reading once. The published grid at +15 min gave the 40 that sat at 0 free a **0%** chance, and the ones sat at a fixed number or at capacity **100%** — 陽明山花鐘停車場 (34 spaces) reported 34 free all weekend. **40 of the 66 lots the app called ≤10% were lots stuck at 0 for 72 h.** Using every published lot as a destination, the #1 recommendation was a lot unchanged for ≥72 h for **3–4%** of destinations, and one was in the top three for **12–14%**.

**No natural threshold.** Share of 1,076 lots whose longest unchanged run is at least: 3 h 79.7%, 6 h 58.7%, 12 h 27.6%, 18 h 16.9%, **24 h 12.8%**, 36 h 10.7%, 48 h 10.0%, 72 h 8.6%. Overnight runs are ordinary. The 12–24 h band mixes the genuine (a 3-space lot full all Friday; a hospital car park empty over a weekend) with obvious freezes (文華停車場, 449 spaces, exactly 221 free for 23 h). 24 h always spans a daytime period.

**The existing detector cannot be used.** `report.find_frozen_lots` (≥72 consecutive identical observations) flagged 494 / 468 / 495 lots on the full days 09-11 / 09-12 / 09-13 — about 45% of the roster — because a quiet night is a 6-hour run. Its output is a count in the daily log; `Q.FROZEN` is never written; publishing never consults it. Left as it is.

**The rule, prototyped.** "Same non-null reading for ≥24 h with readings on ≥50% of that run's 5-minute slots" withheld **120 of 1,090 published lots (11.0%)** at 23:43 — 49 reading a mid value, 48 reading 0, 23 reading capacity. Runs 26.3–47.9 h (the 48 h hot window caps what is visible). The coverage guard removed 1 lot. All 120 had a reading on the current tick. Separately, **14 published lots had no non-null reading at all in 24 h** and were getting a climatology-only percentage.

**Cost.** One pass over 635,563 rows: **0.23 s** with `ORDER BY lot_id DESC, data_ts DESC` — `EXPLAIN QUERY PLAN` is a bare `SCAN observations`. `ORDER BY lot_id, data_ts DESC` mixes directions and adds `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`.

**The evaluation was flattered.** Re-running the backtest (train < 09-12 03:28, 48 origins): 49 of the 258 hard lots were stuck in training, and persistence scores perfectly on a reading that never moves. Removing them raised blend's hard-subset skill over persistence at 120 min from +8.7% to +11.5%.

**Deferred, with the number.** The withheld lots are 181,429 of 1,536,144 cold observations (11.81%) at their own rate of 0.597, holding the citywide climatology prior at **0.8852 instead of 0.9238**. Excluding them from counts would invalidate the per-Parquet `ColdCountCache`, the same trade as the zero-car lots. Not in this plan.

## Design (approved 2026-09-14)

- **Wording: "Not updating", not "lost connection".** The feed still sends a number for most of these lots; what we observe is that it stopped changing, not why. EN "Not updating" / "No change in {n} h"; ZH "資料未更新" / "已 {n} 小時未變動".
- **Last update `u`**, from what the hot store can see:
  - no non-null reading in the window → the window's start (the oldest `data_ts` in the store);
  - a run of identical readings with readings on ≥ `NOT_UPDATING_MIN_COVERAGE` of its slots → the run's first reading;
  - a sparser run → its newest reading (a value seen either side of a long collector outage proves nothing).

  Withheld iff `as_of − u ≥ NOT_UPDATING_AFTER_SEC`. Every `u` is the *latest* the last update could have been, so "no change in N h" is a lower bound — never overstated. (Corrected by the final review: a lower bound on what was *observed*, assuming nothing changed during collector gaps — see the Review section.)
- **Stateless:** recomputed at every publish; a lot rejoins the forecast on the tick its reading moves; a restart loses nothing.
- **`grid.bin` format unchanged:** withheld rows are `UNKNOWN` in all 24 columns, via a forecaster wrapper. **`lots.json`:** optional `"u"` only on withheld lots; `v` stays 1 — additive, and an older client that ignores `u` shows "no data" for the `UNKNOWN` row, which is still true.
- **Web:** the row says "Not updating" only when the lot has `u` **and** the grid gives no probability — a fresher grid with a number wins over a cached `lots.json`. Hours are `floor((base_data_ts − u) / 3600)`, measured to the reading, not to now. The map dot is the existing "no data" grey.
- **Evaluation:** replay the rule at each origin over readings in `[origin − HOT_RETENTION_SEC, origin]`; skip those (origin, horizon, lot) labels for every forecaster alike and count them in `Result.withheld`. On by default, because the evaluation measures what ships; `--include-not-updating` turns it off for comparison.

## File structure

| file | change | responsibility |
|---|---|---|
| `src/parkcast/config.py` | modify | `NOT_UPDATING_AFTER_SEC`, `NOT_UPDATING_MIN_COVERAGE` |
| `src/parkcast/liveness.py` | **create** | the rule: `Run`, `unchanged_run`, `last_update`, `withheld_since`, `not_updating`, `Withholding` |
| `tests/test_liveness.py` | **create** | the rule's tests |
| `tests/test_config.py` | modify | pin the two constants |
| `src/parkcast/artifacts.py` | modify | `build_lots_json(..., not_updating=)` writes `"u"` |
| `tests/test_artifacts.py` | modify | `u` present only for withheld lots; `v` unchanged |
| `src/parkcast/scheduler.py` | modify | `publish_artifacts` withholds; log line |
| `tests/test_scheduler.py` | modify | end-to-end publish test |
| `src/parkcast/evaluate.py` | modify | `reading_series`, `withheld_at`, `backtest(withhold_not_updating=)`, `Result.withheld` |
| `tests/test_evaluate.py` | modify | withholding tests; faster fixture |
| `scripts/evaluate-forecast.py` | modify | print withheld count; `--include-not-updating` |
| `web/src/types.ts` | modify | `Lot.u?: number` |
| `web/src/i18n.ts` | modify | `notUpdating`, `unchangedForTemplate` |
| `web/src/format.ts` | modify | `notUpdatingHours` |
| `web/src/components/LotRow.tsx`, `LotList.tsx`, `web/src/App.tsx` | modify | thread `baseDataTs`, render the state |
| `web/tests/app.test.tsx` | modify | the rendered-row tests |
| `CLAUDE.md`, `README.md`, `docs/state-of-play.md`, `docs/collector-move.md`, `docker/README.md` | modify | Task 6 |

---

### Task 1: The not-updating rule

**Files:**
- Modify: `src/parkcast/config.py` (append after `MIN_PUBLISH_LOT_FRACTION`)
- Create: `src/parkcast/liveness.py`
- Create: `tests/test_liveness.py`
- Modify: `tests/test_config.py` (append one test)

**Interfaces:**
- Consumes: `store.oldest_data_ts(conn) -> int | None`; the `observations` table.
- Produces:
  - `config.NOT_UPDATING_AFTER_SEC: int = 86400`, `config.NOT_UPDATING_MIN_COVERAGE: float = 0.5`
  - `liveness.Run(newest_ts: int, since_ts: int, readings: int, value: int)` (frozen dataclass)
  - `liveness.unchanged_run(newest_first: Iterable[tuple[int, int]]) -> Run | None`
  - `liveness.last_update(run: Run | None, *, window_start: int) -> int`
  - `liveness.withheld_since(run: Run | None, *, as_of: int, window_start: int) -> int | None`
  - `liveness.not_updating(conn, lot_ids: Collection[str], *, as_of: int) -> dict[str, int]`
  - `liveness.Withholding(inner, withheld: Collection[str])` with `.predict(lot_id, target_ts, horizon_min) -> float | None`
  - `liveness._READINGS_NEWEST_FIRST: str` (the SQL; its query plan is pinned by a test)

- [x] **Step 1: Write the failing tests** — create `tests/test_liveness.py`:

```python
"""Tests for the not-updating rule.

The failure this guards against has two faces and both are silent: a frozen lot
published as a confident 0% or 100%, and a live lot hidden behind "not
updating" because a collector outage looked like a frozen feed.
"""
import pytest

from parkcast import config, liveness, store
from parkcast.feed import FeedSnapshot, Observation
from parkcast.liveness import (Run, Withholding, last_update, not_updating,
                               unchanged_run, withheld_since)

HOUR = 3600
T = 1_789_000_080                      # a data_ts on the feed's phase
WINDOW = T - 48 * HOUR                 # a full hot window


def newest_first(values, *, end=T):
    """[(data_ts, value)], newest first, one reading per 5-minute slot."""
    return [(end - i * 300, v) for i, v in enumerate(values)]


def full_run(hours, value=7):
    """A run with a reading on every slot, ending at T."""
    return Run(newest_ts=T, since_ts=T - hours * HOUR, readings=hours * 12 + 1, value=value)


# --- the run ---------------------------------------------------------------


def test_the_run_ends_at_the_first_different_value():
    assert unchanged_run(newest_first([7, 7, 7, 3, 7])) == Run(T, T - 600, 3, 7)


def test_no_readings_is_no_run():
    assert unchanged_run([]) is None


def test_a_lot_that_just_changed_has_a_one_reading_run():
    run = unchanged_run(newest_first([4, 5, 5, 5]))
    assert (run.since_ts, run.readings) == (T, 1)


# --- when a lot last updated -----------------------------------------------


def test_a_well_covered_run_last_updated_when_it_began():
    assert last_update(full_run(30), window_start=WINDOW) == T - 30 * HOUR


def test_a_sparse_run_proves_nothing_beyond_its_newest_reading():
    # A 5 before a long collector outage and a 5 after it: 24 readings over 26 h.
    run = Run(newest_ts=T, since_ts=T - 26 * HOUR, readings=24, value=5)
    assert last_update(run, window_start=WINDOW) == T


def test_no_reading_in_the_window_last_updated_no_later_than_its_start():
    assert last_update(None, window_start=WINDOW) == WINDOW


# --- whether to withhold ---------------------------------------------------


def test_exactly_the_threshold_is_withheld():
    hours = config.NOT_UPDATING_AFTER_SEC // HOUR
    assert withheld_since(full_run(hours), as_of=T, window_start=WINDOW) == T - hours * HOUR


def test_one_slot_short_of_the_threshold_is_not():
    span = config.NOT_UPDATING_AFTER_SEC - 300
    run = Run(T, T - span, span // 300 + 1, 7)
    assert withheld_since(run, as_of=T, window_start=WINDOW) is None


def test_the_coverage_guard_stops_an_outage_looking_like_a_frozen_feed():
    run = Run(newest_ts=T, since_ts=T - 26 * HOUR, readings=24, value=5)
    assert withheld_since(run, as_of=T, window_start=WINDOW) is None


def test_a_lot_that_stopped_reporting_is_withheld_from_its_last_reading():
    # It changed often, then sent only -9 for 25 hours.
    last = T - 25 * HOUR
    run = Run(newest_ts=last, since_ts=last, readings=1, value=12)
    assert withheld_since(run, as_of=T, window_start=WINDOW) == last


def test_a_lot_silent_for_the_whole_window_needs_the_window_to_be_long_enough():
    assert withheld_since(None, as_of=T, window_start=T - 25 * HOUR) == T - 25 * HOUR
    # A store only an hour old cannot tell a silent lot from a new one.
    assert withheld_since(None, as_of=T, window_start=T - HOUR) is None


def test_full_empty_and_mid_value_are_all_the_same_failure():
    for value in (0, 34, 221):
        assert withheld_since(full_run(30, value), as_of=T, window_start=WINDOW) is not None


# --- against the store -----------------------------------------------------


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    # These fixtures write hundreds of ticks; durability is not under test.
    c.execute("PRAGMA synchronous=OFF")
    yield c
    c.close()


def write(conn, ts, readings):
    """One tick. `readings` is {lot_id: free_car or None}."""
    obs = tuple(Observation(lot, free, None) for lot, free in readings.items())
    store.insert_snapshot(conn, FeedSnapshot(ts, ts + 200, obs), {lot: 50 for lot in readings})


def ticks(hours, *, end=T):
    """Every 5-minute data_ts from `hours` before `end` up to `end`, oldest first."""
    return [end - i * 300 for i in range(hours * 12, -1, -1)]


def test_not_updating_finds_the_frozen_lot_and_leaves_the_live_one(conn):
    for i, ts in enumerate(ticks(26)):
        write(conn, ts, {"FROZEN": 7, "LIVE": i % 5})
    assert not_updating(conn, ["FROZEN", "LIVE"], as_of=T) == {"FROZEN": T - 26 * HOUR}


def test_readings_after_as_of_are_ignored(conn):
    for ts in ticks(26):
        write(conn, ts, {"A": 7})
    write(conn, T + 300, {"A": 8})        # a tick newer than the one being published
    assert not_updating(conn, ["A"], as_of=T) == {"A": T - 26 * HOUR}


def test_a_missing_reading_neither_breaks_nor_extends_a_run(conn):
    for i, ts in enumerate(ticks(26)):
        write(conn, ts, {"A": None if i % 4 == 0 else 7})   # the feed sent -9 every fourth tick
    assert "A" in not_updating(conn, ["A"], as_of=T)


def test_only_the_lots_asked_about_are_reported(conn):
    for ts in ticks(26):
        write(conn, ts, {"A": 7, "NOT_PUBLISHED": 7})
    assert set(not_updating(conn, ["A"], as_of=T)) == {"A"}


def test_a_lot_the_window_never_heard_from_is_withheld_from_the_window_start(conn):
    for i, ts in enumerate(ticks(26)):
        write(conn, ts, {"LIVE": i % 3})
    assert not_updating(conn, ["LIVE", "SILENT"], as_of=T) == {"SILENT": T - 26 * HOUR}


def test_an_empty_store_withholds_nothing(conn):
    assert not_updating(conn, ["A"], as_of=T) == {}


def test_the_detector_walks_the_primary_key_backwards_without_a_sort(conn):
    """0.23 s per publish at 635,563 rows depends on this plan. Mixing sort
    directions (`lot_id, data_ts DESC`) adds a temporary B-tree."""
    plan = conn.execute("EXPLAIN QUERY PLAN " + liveness._READINGS_NEWEST_FIRST).fetchall()
    assert not any("TEMP B-TREE" in row[-1] for row in plan), plan


def test_withholding_answers_none_only_for_withheld_lots():
    class Always:
        def predict(self, lot_id, target_ts, horizon_min):
            return 0.75

    forecaster = Withholding(Always(), {"FROZEN": T})
    assert forecaster.predict("FROZEN", T, 15) is None
    assert forecaster.predict("LIVE", T, 15) == 0.75
```

Append to `tests/test_config.py`:

```python
def test_not_updating_thresholds_are_the_measured_ones():
    """Measured 2026-09-14 -- see the comment on NOT_UPDATING_AFTER_SEC. A silent
    edit changes which car parks the app withholds a forecast for."""
    assert config.NOT_UPDATING_AFTER_SEC == 24 * 3600
    assert config.NOT_UPDATING_MIN_COVERAGE == 0.5
```

- [x] **Step 2: Run to verify they fail**

Run the Python test command with `tests/test_liveness.py tests/test_config.py`.
Expected: collection error `ModuleNotFoundError: No module named 'parkcast.liveness'`, and `AttributeError: module 'parkcast.config' has no attribute 'NOT_UPDATING_AFTER_SEC'`.

- [x] **Step 3: Implement** — append to `src/parkcast/config.py`:

```python

# --- feed liveness ---
# How long a lot may go without an update before its forecast is withheld. A
# lot's "last update" is the start of its current run of identical readings, or
# its last reading if it stopped reporting -- see `liveness.last_update`.
#
# Measured 2026-09-14 over 82 h of unbroken collection: the longest unchanged
# run falls smoothly -- 80% of lots have one of 3 h, 28% of 12 h, 12.8% of 24 h,
# 8.6% of 72 h -- so there is no natural gap to pick. Overnight runs of 6-12 h
# are ordinary, which is why the daily report's 72-observation
# `find_frozen_lots` flags ~45% of lots on a full day. 24 h is the shortest
# window that always spans a daytime period, and a live car park's count moves
# at least once across one.
NOT_UPDATING_AFTER_SEC = 24 * 3600
# A run is only trusted to have been unchanged if readings exist on at least
# this share of its 5-minute slots. Without it, a lot that read 5 before a long
# collector outage and 5 again after it would look frozen straight across it.
NOT_UPDATING_MIN_COVERAGE = 0.5
```

Create `src/parkcast/liveness.py`:

```python
"""Which lots' feeds have stopped updating, judged from the hot store.

Measured 2026-09-14: over 82 hours of unbroken collection, 92 car parks did not
change their reading once. The 40 sitting at 0 free were published as a 0%
chance of a space; the rest, stuck at a fixed number or at capacity, as 100% --
陽明山花鐘停車場 reported all 34 of its spaces free for a whole weekend. For 3-4%
of destinations the app's top recommendation was one of them. That is the
complaint this project exists to answer -- it said there was a space, and there
wasn't -- produced by the app itself.

So a lot whose feed has not updated in `config.NOT_UPDATING_AFTER_SEC` gets no
forecast: every cell of its grid row is UNKNOWN, and `lots.json` says when it
last updated. It is not dropped. A missing car park is invisible; one marked
"not updating" is a true statement a driver can act on.

What this is not
----------------
* **Not a collection rule.** The readings are still collected and stored
  exactly as the feed sent them. Judging a lot frozen is a decision about what
  to *publish*, and the corpus has to stay a faithful record of the feed -- the
  same line `Lot.serves_cars` draws.
* **Not `report.find_frozen_lots`.** That counts 6-hour runs for the daily log
  and flags ~45% of lots on a full day, because a quiet night is a 6-hour run.
  It is left as it is; this is the rule that decides something.
* **Not a claim about the cause.** For most of these lots the feed keeps
  sending a number; all we can see is that it stopped changing. Hence "not
  updating", never "offline".

Stateless on purpose
--------------------
Recomputed from the store on every publish rather than tracked across ticks, so
a restart loses nothing and a lot rejoins the forecast on the tick its reading
moves. One pass cost 0.23 s over 635,563 rows on a snapshot of the live store,
because the query walks the primary key backwards and SQLite needs no sort.

The hot store holds 48 hours, so no run can be seen to be longer than that.
Every last update here is the *latest* the update could have been, so "no
change in N h" is a lower bound -- never overstated.
"""
from collections.abc import Collection, Iterable
from dataclasses import dataclass
from itertools import groupby
from operator import itemgetter

from parkcast import config, store

SLOT_SECONDS = config.POLL_PERIOD_MIN * 60

# Both columns DESC, deliberately. The table is WITHOUT ROWID on (lot_id,
# data_ts), so a fully reversed order is a backwards walk of the primary key.
# `lot_id, data_ts DESC` mixes directions and makes SQLite build a temporary
# B-tree for the second term.
_READINGS_NEWEST_FIRST = (
    "SELECT lot_id, data_ts, free_car FROM observations "
    "WHERE free_car IS NOT NULL ORDER BY lot_id DESC, data_ts DESC"
)


@dataclass(frozen=True, slots=True)
class Run:
    """The run of identical readings that ends at a lot's newest reading."""
    newest_ts: int
    since_ts: int      # data_ts of the run's first, oldest reading
    readings: int
    value: int


def unchanged_run(newest_first: Iterable[tuple[int, int]]) -> Run | None:
    """The run of identical readings ending at the newest, or None if there are none.

    `newest_first` is (data_ts, free_car) with NULLs already removed: a missing
    reading says nothing about whether the value changed, so it neither ends a
    run nor counts towards one. Stops at the first different value, so a live
    lot costs a step or two however much history it has.
    """
    readings = iter(newest_first)
    first = next(readings, None)
    if first is None:
        return None
    newest_ts, value = first
    since_ts, count = newest_ts, 1
    for ts, free in readings:
        if free != value:
            break
        since_ts, count = ts, count + 1
    return Run(newest_ts, since_ts, count, value)


def last_update(run: Run | None, *, window_start: int) -> int:
    """When the app treats this lot as having last updated.

    * No reading in the window: the window's start, the latest it could have been.
    * A run with readings on at least `NOT_UPDATING_MIN_COVERAGE` of its
      5-minute slots: the run's first reading.
    * A sparser run: its newest reading. A value seen either side of a long
      collector outage may have changed in between, so the run proves nothing.
    """
    if run is None:
        return window_start
    slots = (run.newest_ts - run.since_ts) // SLOT_SECONDS + 1
    if run.readings >= config.NOT_UPDATING_MIN_COVERAGE * slots:
        return run.since_ts
    return run.newest_ts


def withheld_since(run: Run | None, *, as_of: int, window_start: int) -> int | None:
    """The lot's last update if it is old enough to withhold the forecast, else None."""
    updated = last_update(run, window_start=window_start)
    return updated if as_of - updated >= config.NOT_UPDATING_AFTER_SEC else None


def not_updating(conn, lot_ids: Collection[str], *, as_of: int) -> dict[str, int]:
    """{lot_id: last update} for each of `lot_ids` that has not updated in time.

    `as_of` is the reading being published, `History.latest_ts`. Readings after
    it are skipped here rather than filtered in SQL: a `data_ts` predicate
    tempts the planner onto `idx_obs_data_ts`, the slow non-covering plan
    `forecast.load_history` documents.
    """
    window_start = store.oldest_data_ts(conn)
    if window_start is None:
        return {}
    wanted = set(lot_ids)
    runs: dict[str, Run | None] = {}
    for lot_id, rows in groupby(conn.execute(_READINGS_NEWEST_FIRST), key=itemgetter(0)):
        if lot_id in wanted:
            runs[lot_id] = unchanged_run((ts, free) for _, ts, free in rows if ts <= as_of)
    withheld = {}
    for lot_id in wanted:
        since = withheld_since(runs.get(lot_id), as_of=as_of, window_start=window_start)
        if since is not None:
            withheld[lot_id] = since
    return withheld


class Withholding:
    """A forecaster with no answer for the lots in `withheld`.

    A wrapper rather than an edit to the grid bytes afterwards, so everything
    that asks a forecaster -- the grid and the backtest alike -- gets the same
    answer: for a lot that is not updating, there is no forecast.
    """

    def __init__(self, inner, withheld: Collection[str]) -> None:
        self._inner = inner
        self._withheld = withheld

    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        if lot_id in self._withheld:
            return None
        return self._inner.predict(lot_id, target_ts, horizon_min)
```

- [x] **Step 4: Run to verify they pass**

Run the Python test command with `tests/test_liveness.py tests/test_config.py`. Expected: all pass. Then the full suite (`tests/`): expected 275 existing + 21 new = **296 collected**, 3 skipped, the rest passing.

- [x] **Step 5: Checkpoint (no commit)**

```bash
git add src/parkcast/config.py src/parkcast/liveness.py tests/test_liveness.py tests/test_config.py
```
Proposed message for when commits are authorised: `feat(liveness): judge which lots' feeds have stopped updating`

---

### Task 2: Publish withheld lots as UNKNOWN, with `u` in lots.json

**Files:**
- Modify: `src/parkcast/artifacts.py` (`build_lots_json`, imports)
- Modify: `src/parkcast/scheduler.py` (`publish_artifacts`, imports)
- Test: `tests/test_artifacts.py`, `tests/test_scheduler.py`

**Interfaces:**
- Consumes: `liveness.not_updating(conn, lot_ids, *, as_of) -> dict[str, int]`, `liveness.Withholding`.
- Produces: `artifacts.build_lots_json(lots, *, generated_at, base_data_ts, not_updating: Mapping[str, int] | None = None) -> bytes`; each withheld lot's row carries `"u": int`. The publish log line becomes `published %s lots x %s horizons, %s not updating`.

- [x] **Step 1: Write the failing tests**

Append to `tests/test_artifacts.py`:

```python
def test_a_lot_that_is_not_updating_carries_its_last_update():
    doc = json.loads(build_lots_json([lot(1), lot(2)], generated_at=1, base_data_ts=1,
                                     not_updating={"TPE0002": 1_788_900_000}))
    assert "u" not in doc["lots"][0], "a live lot must carry no key to misread"
    assert doc["lots"][1]["u"] == 1_788_900_000


def test_not_updating_is_additive_and_leaves_the_schema_version_alone():
    """An older client ignores `u` and shows "no data" for the lot's UNKNOWN
    row -- still true -- so this is not a breaking change."""
    doc = json.loads(build_lots_json([lot(1)], generated_at=1, base_data_ts=1,
                                     not_updating={"TPE0001": 5}))
    assert doc["v"] == VERSION == 1
```

In `tests/test_scheduler.py`, add `from parkcast.grid import UNKNOWN` to the imports, then append:

```python
def test_publish_artifacts_withholds_a_lot_that_is_not_updating(tmp_path):
    """Measured 2026-09-14: 120 of 1,090 published lots had not changed their
    reading in over 24 hours, and the app gave them a confident 0% or 100%.
    They stay on the roster -- a missing car park is invisible -- with no
    forecast in any column, and lots.json says when they last updated."""
    conn = store.connect(tmp_path / "t.sqlite")
    conn.execute("PRAGMA synchronous=OFF")    # 313 ticks; durability is not under test
    start, _ = day_bounds(date(2026, 9, 4))
    for i in range(26 * 12 + 1):
        ts = start + i * 300
        store.insert_snapshot(
            conn,
            FeedSnapshot(ts, ts + 200, (Observation("FROZEN", 34, None),
                                        Observation("LIVE", i % 7, None))),
            {"FROZEN": 50, "LIVE": 50},
        )
    out_dir = tmp_path / "artifacts"

    scheduler.publish_artifacts(conn, [_make_lot("FROZEN"), _make_lot("LIVE")], out_dir)
    conn.close()

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    body = (out_dir / "grid.bin").read_bytes()[artifacts.HEADER_SIZE:]
    n = config.HORIZON_COUNT
    row = {l["id"]: body[l["i"] * n:(l["i"] + 1) * n] for l in doc["lots"]}

    assert [l["id"] for l in doc["lots"]] == ["FROZEN", "LIVE"], "withheld, not dropped"
    assert set(row["FROZEN"]) == {UNKNOWN}, "every horizon must say 'no forecast', never a number"
    assert UNKNOWN not in row["LIVE"], "a live lot keeps its forecast"
    assert doc["lots"][0]["u"] == start
    assert "u" not in doc["lots"][1]
    assert doc["base_data_ts"] == start + 26 * 12 * 300
```

- [x] **Step 2: Run to verify they fail**

Run the Python test command with `tests/test_artifacts.py tests/test_scheduler.py`.
Expected: `TypeError: build_lots_json() got an unexpected keyword argument 'not_updating'`, and the scheduler test failing on `set(row["FROZEN"]) == {UNKNOWN}`.

- [x] **Step 3: Implement**

In `src/parkcast/artifacts.py`, change `from collections.abc import Sequence` to `from collections.abc import Mapping, Sequence`, then replace `build_lots_json`'s signature with:

```python
def build_lots_json(
    lots: Sequence[Lot], *, generated_at: int, base_data_ts: int,
    not_updating: Mapping[str, int] | None = None,
) -> bytes:
```

Add this paragraph at the end of its docstring, before the closing quotes:

```
    `u` is present only on a lot whose feed is not updating (`liveness`): the
    unix time of its last update, while every cell of its grid row is UNKNOWN.
    Absent on a live lot, so there is no value to misread. Additive rather than
    a schema change: a client that ignores it shows "no data" for that row,
    which is still true, so `v` stays where it is.
```

and replace the function body from `lot_ids = [lot.id for lot in lots]` through the `return` with:

```python
    lot_ids = [lot.id for lot in lots]
    withheld = not_updating or {}
    rows = []
    for i, lot in enumerate(lots):
        row = {
            "i": i, "id": lot.id, "n": lot.name, "a": lot.area,
            "y": round(lot.lat, 5), "x": round(lot.lon, 5),
            "c": lot.capacity_car, "t": lot.lot_type,
            "p": _price_field(parse_fare(lot.fare_text)),
        }
        if lot.id in withheld:
            row["u"] = withheld[lot.id]
        rows.append(row)
    payload = {
        "v": VERSION,
        "generated_at": generated_at,
        "base_data_ts": base_data_ts,
        "n_lots": len(lot_ids),
        "roster_id": roster_id(lot_ids),
        "lots": rows,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
```

In `src/parkcast/scheduler.py`, change `from parkcast import artifacts, config, store` to `from parkcast import artifacts, config, liveness, store`. In `publish_artifacts`, delete the line `forecaster = Blend(history)` near the top, and replace everything from the comment `# One list drives the grid's rows, the header's roster and lots.json alike,` through the final `log.info(...)` with:

```python
    # One list drives the grid's rows, the header's roster and lots.json alike,
    # so the three cannot describe different sets of lots.
    lot_ids = [lot.id for lot in ordered]
    # A lot whose feed has stopped updating keeps its row, with no forecast in
    # it: a frozen reading published as 0% or 100% was the app telling drivers
    # something the data could not support. Publishing-only -- see `liveness`.
    withheld = liveness.not_updating(conn, lot_ids, as_of=history.latest_ts)
    forecaster = liveness.Withholding(Blend(history), withheld)
    grid = build_grid(forecaster, lot_ids, history.latest_ts)
    # One set of generation values for both files: the row order is recomputed
    # every tick, so a client pairing this grid with an older lots.json must be
    # able to tell. `n_lots` and `roster_id` are derived inside each encoder
    # from the rows it is actually writing, so no stamp can outlive its rows.
    identity = {
        "generated_at": int(time.time()),
        "base_data_ts": history.latest_ts,
    }
    artifacts.publish(
        out_dir,
        grid_blob=artifacts.encode_grid(grid, lot_ids=lot_ids, **identity),
        lots_blob=artifacts.build_lots_json(ordered, not_updating=withheld, **identity),
    )
    log.info(
        "published %s lots x %s horizons, %s not updating",
        len(ordered), config.HORIZON_COUNT, len(withheld),
    )
```

- [x] **Step 4: Run to verify they pass**

Run the Python test command with `tests/`. Expected: 296 + 3 new = **299 collected**, all passing except the 3 live-DB skips.

- [x] **Step 5: Checkpoint (no commit)**

```bash
git add src/parkcast/artifacts.py src/parkcast/scheduler.py tests/test_artifacts.py tests/test_scheduler.py
```
Proposed message: `feat(publish): withhold the forecast for lots that are not updating`

---

### Task 3: The backtest scores what ships

**Files:**
- Modify: `src/parkcast/evaluate.py`
- Modify: `scripts/evaluate-forecast.py`
- Test: `tests/test_evaluate.py`

**Interfaces:**
- Consumes: `liveness.unchanged_run`, `liveness.withheld_since`, `config.HOT_RETENTION_SEC`.
- Produces:
  - `evaluate.reading_series(labels: dict[int, dict[str, int]]) -> dict[str, tuple[array, array]]`
  - `evaluate.withheld_at(series, *, origin: int, window_start: int) -> dict[str, int]`
  - `evaluate.backtest(conn, cold_dir, *, origins, horizons, withhold_not_updating: bool = True) -> Result`
  - `Result.withheld: int`

- [x] **Step 1: Write the failing tests**

In `tests/test_evaluate.py`, speed up the fixture (the new tests write hundreds of ticks):

```python
@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    # Some tests below write hundreds of ticks; durability is not under test.
    c.execute("PRAGMA synchronous=OFF")
    yield c
    c.close()
```

and append:

```python
# --- the not-updating rule -------------------------------------------------


def test_a_lot_not_updating_at_the_origin_is_withheld_from_every_forecaster(conn):
    """The app publishes no forecast for it, so there is nothing to score -- and
    persistence is perfect on a reading that never moves, so scoring it anyway
    flatters the baseline."""
    origin = 1_700_000_000
    for i in range(26 * 12 + 1):
        write(conn, origin - i * 300, lot="FROZEN", free=34)
        write(conn, origin - i * 300, lot="LIVE", free=i % 5)
    write(conn, origin + 900, lot="FROZEN", free=34)
    write(conn, origin + 900, lot="LIVE", free=3)

    result = backtest(conn, cold_dir=None, origins=[origin], horizons=[15])
    for name, preds in result.by_model.items():
        assert {x.lot_id for x in preds} == {"LIVE"}, f"{name} scored a withheld lot"
    assert result.withheld == 1


def test_withholding_cannot_see_past_the_origin(conn):
    """Deciding to withhold is as bound by the cutoff as forecasting is. A lot
    that froze only *after* the origin was live at it and must be scored."""
    origin = 1_700_000_000
    for i in range(6):
        write(conn, origin - i * 300, lot="A", free=i)
    for i in range(1, 26 * 12 + 1):
        write(conn, origin + i * 300, lot="A", free=9)

    result = backtest(conn, cold_dir=None, origins=[origin], horizons=[15])
    assert result.withheld == 0
    assert len(result.by_model["blend"]) == 1


def test_withholding_can_be_turned_off_to_compare(conn):
    origin = 1_700_000_000
    for i in range(26 * 12 + 1):
        write(conn, origin - i * 300, lot="FROZEN", free=34)
    write(conn, origin + 900, lot="FROZEN", free=34)

    result = backtest(conn, cold_dir=None, origins=[origin], horizons=[15],
                      withhold_not_updating=False)
    assert result.withheld == 0
    assert len(result.by_model["blend"]) == 1
```

- [x] **Step 2: Run to verify they fail**

Run the Python test command with `tests/test_evaluate.py`.
Expected: the first test fails (`AttributeError: 'Result' object has no attribute 'withheld'`, or FROZEN scored); the third with `TypeError: backtest() got an unexpected keyword argument 'withhold_not_updating'`.

- [x] **Step 3: Implement** — in `src/parkcast/evaluate.py`:

Add to the stdlib imports:

```python
from array import array
from bisect import bisect_left, bisect_right
```
and change `from parkcast import config` to `from parkcast import config, liveness`.

Replace `Result` with:

```python
@dataclass
class Result:
    origins: list[int] = field(default_factory=list)
    by_model: dict[str, list[Prediction]] = field(default_factory=dict)
    #: (origin, horizon, lot) labels skipped because the app showed the lot as
    #: not updating at that origin: no forecast was published, so none is scored.
    withheld: int = 0

    @property
    def n_predictions(self) -> int:
        return sum(len(v) for v in self.by_model.values())
```

Add these two functions after `hard_lots`:

```python
def reading_series(labels: dict[int, dict[str, int]]) -> dict[str, tuple[array, array]]:
    """Each lot's readings as ascending (data_ts, free_car) arrays, for `withheld_at`.

    `array` rather than lists of tuples: the corpus already sits in memory once
    as `labels`, and a second copy of it as Python objects would cost far more
    than the lookups it serves.
    """
    series: dict[str, tuple[array, array]] = {}
    for ts in sorted(labels):
        for lot_id, free in labels[ts].items():
            stamps, values = series.setdefault(lot_id, (array("q"), array("q")))
            stamps.append(ts)
            values.append(free)
    return series


def withheld_at(series, *, origin: int, window_start: int) -> dict[str, int]:
    """The lots the app would have shown as not updating when publishing `origin`.

    The serving rule in `liveness`, replayed on what the collector's hot store
    would have held then -- readings in [window_start, origin] and nothing
    later -- so deciding to withhold a lot can no more see the future than the
    forecasters can.
    """
    withheld = {}
    for lot_id, (stamps, values) in series.items():
        lo = bisect_left(stamps, window_start)
        hi = bisect_right(stamps, origin)
        run = liveness.unchanged_run((stamps[i], values[i]) for i in range(hi - 1, lo - 1, -1))
        since = liveness.withheld_since(run, as_of=origin, window_start=window_start)
        if since is not None:
            withheld[lot_id] = since
    return withheld
```

Replace `backtest` with:

```python
def backtest(
    conn,
    cold_dir: Path | None,
    *,
    origins: Iterable[int],
    horizons: Sequence[int],
    withhold_not_updating: bool = True,
) -> Result:
    """Score every forecaster at every origin, on identical inputs.

    One `load_history` per origin, so the cost is linear in origins rather than
    in predictions. All three forecasters share that history, which is what
    makes the comparison fair: they differ in what they do with the data, never
    in which data they got.

    `withhold_not_updating` replays the publishing rule in `liveness`: a lot the
    app would have shown as not updating at an origin is scored by no
    forecaster there, and counted in `Result.withheld` instead. On by default,
    because the evaluation measures what ships; off only to compare.
    """
    labels = load_labels(conn, cold_dir)
    result = Result(by_model={name: [] for name, _ in FORECASTERS})
    stamps = sorted(labels)
    series = reading_series(labels) if withhold_not_updating else {}

    for origin in origins:
        # +1 so the reading *at* the origin is inside the history -- it is the
        # forecaster's input, not one of its labels. Everything scored below is
        # strictly later.
        history = load_history(conn, cold_dir=cold_dir, before_ts=origin + 1)
        if not history.counts.glob[1]:
            continue
        withheld: dict[str, int] = {}
        if withhold_not_updating and stamps:
            # The oldest reading the hot store would still have held at the origin.
            first = bisect_left(stamps, origin - config.HOT_RETENTION_SEC)
            window_start = stamps[min(first, len(stamps) - 1)]
            withheld = withheld_at(series, origin=origin, window_start=window_start)
        models = [(name, cls(history)) for name, cls in FORECASTERS]
        result.origins.append(origin)

        for horizon in horizons:
            target = origin + horizon * 60
            actual = labels.get(target)
            if not actual:
                continue
            bucket_counts = history.counts.bucket
            key_bucket = week_bucket(target)
            for lot_id, free in actual.items():
                if lot_id in withheld:
                    result.withheld += 1
                    continue
                outcome = 1 if free >= 1 else 0
                support = bucket_counts.get((lot_id, key_bucket), (0, 0))[1]
                for name, model in models:
                    p = model.predict(lot_id, target, horizon)
                    if p is None:
                        continue
                    result.by_model[name].append(
                        Prediction(lot_id, horizon, p, outcome, support)
                    )
    return result
```

In `scripts/evaluate-forecast.py`, add after the `--every-minutes` argument:

```python
    ap.add_argument("--include-not-updating", action="store_true",
                    help="also score lots the app shows as not updating (to compare)")
```
change the backtest call to:

```python
    result = backtest(conn, config.PARQUET_DIR, origins=origins, horizons=HORIZONS,
                      withhold_not_updating=not args.include_not_updating)
```
and immediately after the existing `print(f"\n  scored   {len(result.by_model['blend']):,} predictions per forecaster")` add:

```python
    if args.include_not_updating:
        print("  withheld nothing -- lots shown as not updating are scored too (--include-not-updating)")
    else:
        print(f"  withheld {result.withheld:,} labels for lots the app showed as not updating at "
              f"their origin (no forecast is published for them, so none is scored)")
```

- [x] **Step 4: Run to verify they pass**

Run the Python test command with `tests/`. Expected: 299 + 3 = **302 collected**, all passing except the 3 skips. The 17 existing evaluation tests pass unchanged — none writes a 24-hour run.

- [x] **Step 5: Checkpoint (no commit)**

```bash
git add src/parkcast/evaluate.py scripts/evaluate-forecast.py tests/test_evaluate.py
```
Proposed message: `feat(evaluate): score only the forecasts the app publishes`

---

### Task 4: The row says "Not updating"

**Files:**
- Modify: `web/src/types.ts`, `web/src/i18n.ts`, `web/src/format.ts`, `web/src/components/LotRow.tsx`, `web/src/components/LotList.tsx`, `web/src/App.tsx` (the `<LotList … />` call, line ~628)
- Test: `web/tests/app.test.tsx`

**Interfaces:**
- Consumes: `lots.json` rows with optional `u` (Task 2).
- Produces: `Lot.u?: number`; `Strings.notUpdating`, `Strings.unchangedForTemplate`; `notUpdatingHours(row: Ranked, baseDataTs: number): number | null`; `LotList` and `LotRow` gain a required `baseDataTs: number` prop.

- [x] **Step 1: Write the failing tests** — in `web/tests/app.test.tsx`, insert this describe immediately after `describe("probability", ...)`:

```tsx
describe("a car park whose feed is not updating", () => {
  /** 30 hours and 7 minutes before the reading. */
  const LAST_UPDATE = BASE_DATA_TS - 30 * 3600 - 7 * 60;
  const NAME = "中山區行政中心停車場";

  /** The standard fixture, with the unpriced lot marked not updating. */
  function stubNotUpdating(cell: number = UNKNOWN) {
    const lots = LOTS.map((lot) => (lot.id === "TPE_UNPRICED" ? { ...lot, u: LAST_UPDATE } : lot));
    const perLot = [88, 61, 45, cell];
    const body: number[] = [];
    for (const lot of lots) for (let h = 0; h < N_HORIZONS; h += 1) body.push(perLot[lot.i] ?? UNKNOWN);
    stubFetch(encodeGrid(body, lots.length), { ...makeLotsDoc(), lots });
  }

  it("says so, and for how long, instead of a probability", async () => {
    stubNotUpdating();
    await renderLocated();
    const chance = within(rowFor(NAME)).getByTestId("lot-probability");
    expect(chance.textContent).toContain(t("en").notUpdating);
    expect(chance.textContent).toContain(fillTemplate(t("en").unchangedForTemplate, { n: 30 }));
    expect(chance.textContent).not.toMatch(/\d+%/);
    expect(chance.textContent).not.toContain(t("en").noData);
  });

  it("counts the hours to the reading, not to now", async () => {
    stubNotUpdating();
    ageArtifact(90); // to now it would be 31 h
    await renderLocated();
    const chance = within(rowFor(NAME)).getByTestId("lot-probability");
    expect(chance.textContent).toContain(fillTemplate(t("en").unchangedForTemplate, { n: 30 }));
  });

  it("lets a fresher grid's forecast win over a stale lots.json", async () => {
    stubNotUpdating(72);
    await renderLocated();
    const chance = within(rowFor(NAME)).getByTestId("lot-probability");
    expect(chance.textContent).toContain("72%");
    expect(chance.textContent).not.toContain(t("en").notUpdating);
  });

  it("still says 'no data' for a lot with no forecast and no last update", async () => {
    await renderLocated();
    const chance = within(rowFor(NAME)).getByTestId("lot-probability");
    expect(chance.textContent).toContain(t("en").noData);
    expect(chance.textContent).not.toContain(t("en").notUpdating);
  });

  it("says it in Chinese too", async () => {
    Object.defineProperty(navigator, "language", { value: "zh-TW", configurable: true });
    stubNotUpdating();
    stubGeolocation("granted");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: t("zh").useMyLocation }));
    await screen.findByTestId("lot-list");
    const chance = within(rowFor(NAME)).getByTestId("lot-probability");
    expect(chance.textContent).toContain("資料未更新");
    expect(chance.textContent).toContain("已 30 小時未變動");
  });
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npm test --prefix web`
Expected: the first, second and fifth new tests FAIL (the row shows "No data"; `t("en").notUpdating` is undefined).

- [x] **Step 3: Implement**

`web/src/types.ts` — add to `interface Lot`, after `p: Price;`:

```ts
  /**
   * Unix seconds of the lot's last update. Present only when its feed is not
   * updating (`src/parkcast/liveness.py`) -- the same reading, or no reading, for
   * at least 24 hours -- in which case its grid row is UNKNOWN in every column.
   * Absent for a live lot, so there is no value to misread.
   *
   * The latest the update could have been, so an age derived from it is a lower
   * bound: "no change in 30 h" may mean 30 or more, never fewer.
   */
  u?: number;
```

`web/src/i18n.ts` — in `interface Strings`, after `noData: string;`:

```ts
  /**
   * Shown instead of a probability for a car park whose feed is not updating:
   * the same reading, or none at all, for at least a day. Deliberately not
   * "offline" or "lost connection" -- for most of these lots the feed still
   * sends a number, and all we can see is that it stopped changing.
   */
  notUpdating: string;
  /** Under `notUpdating`, e.g. "No change in 30 h". Carries `{n}`, whole hours. */
  unchangedForTemplate: string;
```
in `en`, after `noData: "No data",`:
```ts
  notUpdating: "Not updating",
  unchangedForTemplate: "No change in {n} h",
```
in `zh`, after `noData: "無資料",`:
```ts
  notUpdating: "資料未更新",
  unchangedForTemplate: "已 {n} 小時未變動",
```

`web/src/format.ts` — add a bullet at the end of the module comment's list:

```
 *   - A lot whose feed is not updating says so, with how long, rather than "no
 *     data": the car park is real, and "its numbers stopped moving a day ago"
 *     is something a driver can act on.
```
and append:

```ts
/** Seconds in an hour. */
const HOUR_S = 3600;

/**
 * Whole hours a lot's feed has gone without an update, or `null` when the row
 * should show a probability, or plain "no data", instead.
 *
 * Both conditions are load-bearing:
 *
 *   - **The grid must have no forecast either.** The two files are fetched
 *     separately and `lots.json` may come from an earlier tick, so a stale `u`
 *     can sit beside a fresh grid in which the lot has started moving again.
 *     The grid is the fresher file; when it has a number, the number wins.
 *   - **Measured to the reading, not to now.** `u` and `baseDataTs` both
 *     describe the feed; how long ago the reading was is the staleness line's
 *     business. Counting to now would claim the lot stayed unchanged through
 *     time nobody observed.
 *
 * Floored, so the number shown never exceeds what was observed.
 */
export function notUpdatingHours(row: Ranked, baseDataTs: number): number | null {
  const u = row.lot.u;
  if (row.probability !== null || typeof u !== "number" || !Number.isFinite(u)) return null;
  return Math.max(0, Math.floor((baseDataTs - u) / HOUR_S));
}
```

`web/src/components/LotRow.tsx` — replace everything after the module comment with:

```tsx
import { formatDistance, formatPrice, formatProbability, notUpdatingHours } from "../format";
import { districtName, fillTemplate, lotTypeName, t, type Lang } from "../i18n";
import type { Ranked } from "../rank";

interface LotRowProps {
  row: Ranked;
  lang: Lang;
  /** `grid.baseDataTs`: the reading a lot's time without an update is measured to. */
  baseDataTs: number;
}

export function LotRow({ row, lang, baseDataTs }: LotRowProps) {
  const s = t(lang);
  // A lot whose feed is not updating says so in the probability's place, set
  // like "no data" -- small and grey -- because it is the same absence of a
  // forecast, with its reason attached.
  const stalledHours = notUpdatingHours(row, baseDataTs);
  return (
    <li className="lot" data-testid="lot-row" data-lot-id={row.id}>
      <div className="lot-head">
        <div className="lot-ident">
          <h3 className="lot-name" data-testid="lot-name" lang="zh-Hant">
            {row.lot.n}
          </h3>
          <p className="lot-where">
            {districtName(row.lot.a, lang)} · {lotTypeName(row.lot.t, lang)}
          </p>
        </div>
        <p className="lot-chance" data-testid="lot-probability">
          <span
            className={
              row.probability === null ? "lot-chance-value is-unknown" : "lot-chance-value"
            }
          >
            {stalledHours === null ? formatProbability(row.probability, s) : s.notUpdating}
          </span>
          <span className="lot-chance-label">
            {stalledHours === null
              ? s.chanceOfSpace
              : fillTemplate(s.unchangedForTemplate, { n: stalledHours })}
          </span>
        </p>
      </div>
      <p className="lot-facts">
        <span data-testid="lot-walk">
          {s.walk} {row.walkMin} {s.minutesUnit} · {formatDistance(row.meters, s)}
        </span>
        <span data-testid="lot-price">{formatPrice(row, s)}</span>
      </p>
    </li>
  );
}
```

`web/src/components/LotList.tsx` — replace the props interface and component:

```tsx
interface LotListProps {
  rows: readonly Ranked[];
  lang: Lang;
  /** `grid.baseDataTs`, which each row measures a stalled feed to. */
  baseDataTs: number;
}

export function LotList({ rows, lang, baseDataTs }: LotListProps) {
  return (
    <ol className="lots" data-testid="lot-list">
      {rows.map((row) => (
        <LotRow key={row.id} row={row} lang={lang} baseDataTs={baseDataTs} />
      ))}
    </ol>
  );
}
```

`web/src/App.tsx` — replace `<LotList rows={listed} lang={lang} />` with:

```tsx
            <LotList rows={listed} lang={lang} baseDataTs={artifacts.grid.baseDataTs} />
```

- [x] **Step 4: Run to verify they pass**

Run: `npm test --prefix web` — expected **191 passed** (186 + 5). Then `npm run typecheck --prefix web` and `npm run lint --prefix web` — expected clean.

- [x] **Step 5: Checkpoint (no commit)**

```bash
git add web/src/types.ts web/src/i18n.ts web/src/format.ts web/src/components/LotRow.tsx web/src/components/LotList.tsx web/src/App.tsx web/tests/app.test.tsx
```
Proposed message: `feat(web): say a car park is not updating instead of guessing`

---

### Task 5: Prove it on the real corpus

Run by the controller, not a subagent: it touches the live collector's store (read-only, via snapshot). Nothing here writes `data/` or restarts the collector.

- [x] **Step 1: Full checks** — the Python suite in the container (expect 302 collected, 3 skipped, the rest passing); `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` in `web/`.
- [x] **Step 2: Fresh snapshot.** Inside `docker-collector-1`, `sqlite3.connect('/app/data/hot.sqlite').backup(...)` into `/tmp/snap3e/data/hot.sqlite`, copy `/app/data/cold` beside it, `docker cp` the directory to the session scratchpad, then `rm -rf /tmp/snap3e` inside the container. Check `PRAGMA quick_check` is `ok` on the copy.
- [x] **Step 3: Publish from the snapshot with the new code**, in a throwaway `docker-collector:latest` container: `D:/Projects/ParkCast/src` mounted read-only and first on `sys.path`; the snapshot copied into the container's own filesystem; `config.PARQUET_DIR` pointed at its `cold/`; lots from `parse_metadata` on the newest `cold/meta/*.json`; `publish_artifacts(conn, lots, out_dir=...)` timed. Report:
  - lots published and withheld, split by what they are stuck at (0 / capacity / mid) and by "no reading ≥24 h";
  - that every withheld lot's 24 cells are 255, every lot carrying `u` is withheld, and every withheld lot carries `u`;
  - that every non-withheld row is byte-identical to the same row built by `build_grid(Blend(history), …)`;
  - `grid.bin` and `lots.json` byte sizes and the publish wall time.
- [x] **Step 4: Re-run the evaluation** on a copy of the snapshot, by default and with `--include-not-updating`; record both headline tables and the withheld count.
- [x] **Step 5: See it in the app.** Copy the scratch-published `grid.bin` and `lots.json` into `web/public/artifacts/` (gitignored), start `parkcast-web` from `.claude/launch.json`, search for a withheld car park by name, set it as the destination, and confirm its row reads "Not updating · No change in N h" with no percentage, in both languages. A blank map is expected (no basemap is built) and does not affect the list.
- [x] **Step 6: Record** every number from Steps 3–5 in the Review section below.

---

### Task 6: Write down what was learned

Run by the controller. Re-read each file before editing. Keep the 2026-09-10 evaluation numbers beside the new ones, never overwrite them. Use numbers re-measured in Task 5, not arithmetic.

- [x] **`CLAUDE.md`**
  - *Load-bearing facts table:* churn becomes "**42–47% in daytime; 9–12% overnight**" (Sat 2026-09-12 by 3-hour block: 00–03 11.8%, 03–06 9.1%, 06–09 27.4%, 09–12 39.6%, 12–15 41.9%, 15–18 42.0%, 18–21 39.1%, 21–24 29.0%). Published lot count and `grid.bin` / `lots.json` sizes from Task 5.
  - *Evaluation section:* add the 2026-09-13 run (train < 09-12 03:28, 48 origins Sat 03:28 → Sun 02:58, 257,656 predictions, base rate 0.865): blend vs persistence +7.4% / +14.5% / +15.8% / +15.6% / +20.6% citywide at 5/15/30/60/120 min, and +6.6% / +13.1% / +10.2% / +5.9% / +8.6% on the hard set. Say plainly that the 09-10 finding (blend loses beyond 30 min) did not reproduce, that the two test periods differ in days and hours, and that neither is a confidence interval. The confound: every daytime prediction had zero bucket support and every supported one fell at night, yet blend beat persistence by +15.8% to +17.6% in daytime with zero support — so the gain came from lot-level rates, and the support-aware blend is deprioritised, not done. Calibration: the 0.9–1.0 band said 0.987 and got 0.977; the mid bands are overconfident (0.6–0.7 said 0.656, got 0.525). Add Task 5's with/without-withholding numbers.
  - *New section "A lot whose feed is not updating gets no forecast (measured 2026-09-14)":* the Grounded numbers above; the rule and what `u` means; why "not updating" and not "lost connection"; publishing-only; `find_frozen_lots` flagging ~45% of lots on full days; the deferred climatology prior (0.8852 vs 0.9238, 11.81% of cold observations at 0.597).
  - *Data shape:* hourly P(free ≥1) — night 0.92–0.94, trough at 13:00 (Fri 0.811, Sat 0.775, Sun 0.819), recovery after 20:00; 31.1% of lots free <90% of the time, 6.7% <50%, 62% completely full at least once in two days; clamping hits 89 lots, 12 of them on every tick (capacity metadata below reality — harmless to the free ≥1 target); storage — a full day of Parquet 208–245 KB (~85 MB/year), the raw daily metadata snapshots 2.17 MB/day (~790 MB/year, ~90% of cold bytes).
  - *Collection section:* replace "Moved 2026-09-10" with what the move measured — from 09-10 11:03: 09-11 287/288 (the missing slot, 18:53, the city never published), 09-12 288/288, 09-13 262/288; overall 1,684 of 2,880 slots = 58.5% at 09-13 23:43; the 12:00–14:30 hole now collected on 5 of 10 days; poll lag median 210 s, p99 256 s, max 406 s; 25 first-attempt misses (2.5%), all filled within the slot but one. **The 09-13 gap was a Docker Desktop Pause click** (`composePauseClicked` 21:26:41, `composeStartClicked` 23:44:46, 26 slots): the collector logged nothing, the Docker VM lost no time, and `restart: unless-stopped` does not cover a pause. The compose project shows in the dashboard as `docker`. The support schedule: at 09-13, of 336 half-hour-of-week buckets, 134 had 0 collected days, 120 had 1 and 82 had 2 (Tuesday had none); with no further gaps every bucket has ≥1 day by Thu 09-17, ≥2 by Thu 09-24, ≥3 by Thu 10-01.
- [x] **`README.md`** — the status table (observations, coverage 58.5%, lots, tests — all re-measured); the coverage strip with the desktop days; the evaluation paragraph with both runs and the confound; a new limitation paragraph on frozen feeds and how the app now shows them; test counts under "Running it".
- [x] **`docs/state-of-play.md`** — rewrite as of 2026-09-14: the desktop collector's record; both evaluations; the not-updating rule; what to do next — deploy; the compose rename and an outside-the-container staleness watchdog (proposed, not done); re-run the evaluation around 10-01; the deferred climatology-prior fix; the licence. Keep the gotchas and add: the Pause click; that `docker logs` shows nothing during a pause; how to tell a pause from a host sleep (the Docker Desktop electron log, and the Docker VM's `/proc/uptime` against wall-clock time); that host Python here has no pytest, so tests run in a container.
- [x] **`docs/collector-move.md`** — under "On the new machine", warn against cloning into a synced folder (OneDrive Files-On-Demand syncs, locks and dehydrates files under a live WAL bind mount; the desktop clone lives at `D:\Projects\ParkCast`). Add a closing "What the move measured" section: the manifest arrived inside the zip with its name intact while the transfer stripped hyphens from the outer file names; `verify-corpus.py` 16/16; coverage matched the laptop's 694/2,016 exactly; 64,268 + 1,171 rows after the first tick; then the three-day record above.
- [x] **`docker/README.md`** — a section "A pause is not a stop": the restart policy never sees it, the collector logs nothing, and it resumes mid-sleep; how to check (`docker inspect -f '{{.State.Paused}}' docker-collector-1`; the Docker Desktop electron log's `composePauseClicked`). A section "Analysing the corpus while it runs": snapshot with `backup()`, `docker cp` it out, run scripts in a throwaway `docker-collector:latest` container with read-only mounts, and `MSYS_NO_PATHCONV=1` under Git Bash. Note that once deployed the publish log line reads `published N lots x 24 horizons, M not updating`.
- [x] **Verify** — every number in the docs traces to a measurement in this plan or in Task 5; re-run both test suites; `git status --short` shows only the files in the File structure table, `tasks/todo.md`, and `docs/superpowers/plans/2026-09-07-plan3d-todo-archive.md`.
- [x] **Checkpoint (no commit)** — `git add` the five docs. Proposed message: `docs: the collector's first days on the desktop, and frozen feeds`

---

### Task 7: Hand back

- [ ] Summarise the change and its measured effect for the user.
- [ ] **Ask** whether to commit (list the proposed messages — no `Co-Authored-By`), and whether to deploy to the collector: `docker compose -f docker/docker-compose.yml up -d --build --force-recreate` just after a tick (minute ≡1 mod 5, around second 40), then confirm the next two ticks log `published N lots x 24 horizons, M not updating` and the row count keeps growing. Nothing is committed or deployed without a yes.

---

## Deferred beyond 3e

Excluding frozen lots from the climatology counts (invalidates `ColdCountCache`; 3.9-point prior depression measured). Renaming the compose project from `docker` to `parkcast`. A staleness watchdog outside the container. Recalibrating or retiring `find_frozen_lots`. Compressing the daily metadata snapshots. Deployment. Licence.

## Review

Executed 2026-09-14 on branch `feat/not-updating-lots`, subagent-driven: a fresh implementer and a task reviewer per code task (Tasks 1–4), the controller for Tasks 5–6. **Nothing is committed and nothing is deployed** — Task 7 asks.

| task | outcome |
|---|---|
| 1 — the not-updating rule | review clean; 21 tests |
| 2 — publish withheld lots | review clean; 3 tests |
| 3 — the backtest scores what ships | 1 fix round. The reviewer found the hot-window start could fall *after* an origin when nothing was collected in the retention window before it. Extracted `_hot_window_start`, bounded at the origin, with 3 direct tests. The outcome at such an origin did not change — nothing is withheld either way, as the serving store would also be empty — but the documented contract was false. |
| 4 — the row says "Not updating" | review clean; 5 tests |

**Tests:** Python 275 → **306** (303 passed, 3 live-DB skips); TypeScript 186 → **191**; typecheck and lint clean.

**On the real corpus** (a `backup()` snapshot taken 2026-09-14 01:16, 635,761 hot rows):

- Published 1,090 lots at the 01:13 reading; **133 withheld (12.2%)** — 49 stuck at a mid value, 46 at 0, 23 at capacity, 15 with no reading for 24 h; last update 25.1–47.9 h before the reading.
- `u` in `lots.json` matches the rule exactly; every withheld row is 255 in all 24 columns; all 957 live rows are byte-identical to a plain `Blend` grid.
- Rule pass 0.22 s; publish 0.73 s steady state (1.64 s on the first call, which folds the cold corpus). `grid.bin` 26,181 B; `lots.json` 187,922 B raw / 30,877 B gzip.
- Evaluation (train < 09-12 04:33, 48 origins): 26,335 labels withheld. Blend vs persistence +6.9 / +14.4 / +16.6 / +16.3 / +21.9% at 5/15/30/60/120 min (+6.8 / +14.3 / +16.3 / +15.9 / +21.5% with frozen lots scored). Hard set +8.3% (+7.5% with them), its base rate 0.702 (0.566 with them). The 0.0–0.1 calibration band holds 5,910 predictions (17,170 with them).
- In the app: with 叭叭房新光醫院地下停車場 as the destination its row reads "資料未更新 · 已 47 小時未變動" and, after the language toggle, "Not updating · No change in 47 h", with no percentage; four nearby withheld lots are rescued into the list with the same wording.

**Rulings made during execution** (each recorded in the SDD ledger with its cost if wrong): no commits, so reviews ran on git tree snapshots of the working tree; implementers never touched git state; executed in place on the branch rather than in a new worktree; sonnet implementers and reviewers, opus for the final review; Task 4's review package limited to `web/` while the docs were written in parallel; the Task 3 window-start fix.

**Deferred minors:** `liveness.SLOT_SECONDS` equals `compact.SLOT_SECONDS` only because both are 300 today; `reading_series` and `withheld_at` have no direct tests; `withheld_at`'s `series` parameter is unannotated; no web test for a `u` later than the reading or a non-number `u`.

**Found, out of scope, flagged as a separate task:** for a destination in Shilin the list ranked a car park with a 2% chance 5.9 km away (#14) above 99% lots 1.2–1.7 km away. The ranker's failure branch appears not to charge the trip to a hopeless lot. Pre-existing cost model; to be measured before any change.

**Docs** updated as Task 6 specifies. One slip caught before review: the corpus-wide coverage first went in as the 23:43 reading (1,684 slots) beside a day table using 09-13's final 262; corrected to 1,687 / 2,880 = 58.6% throughout.

**Final whole-branch review** (opus): ready to merge *with fixes* — no Critical finding and no runtime defect; 4 Important, 12 Minor. One fix wave followed, and a scoped re-review found all 13 fixed items addressed:

- "No change in N h" is now described as a lower bound on what was *observed*. It assumes nothing changed while the collector itself was down: a run half observed and half collector gap passes the coverage guard, and after a day-long outage a lot whose first reading back is missing is withheld from its last reading.
- The move runbook's post-start coverage check now runs inside the container.
- The cause of the evaluation reversal is described as an inference, not a measurement.
- A new test checks that the backtest withholds exactly what publishing would, lot for lot and down to the last-update time (Python tests now **306**).
- Eight documentation overstatements corrected: the 133 dated to its snapshot, daytime churn ~40–47%, the 34.4% laptop baseline, when a withheld lot appears in the list, the pause's off-phase tick, the Git Bash prefixes, and the machine's hostname removed.

It also corrected one of the controller's Task 3 rulings: `run_forever` publishes before it prunes, so the first publish after a gap longer than 48 h does not work from an empty store, and there serving can withhold what the replay does not.

**Deferred by the final review** (recorded, not done): a gap-aware rule that ends runs at collector gaps and requires ticks across a silent period; measuring coverage against the ticks the store holds rather than calendar slots, so a frozen lot that also sends `-9` often is still caught; pruning before the first publish after a restart; and `scripts/refresh-demo-artifacts.py`, which on a stale corpus shows silent lots with very large hour counts.
