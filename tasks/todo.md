# ParkCast — Stage B prerequisites

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The ranking-preferences todo is archived at `docs/superpowers/plans/2026-09-18-ranking-preferences-archive.md`.

**Goal:** Land the two things that must exist *before* the corpus deepens, so that Stage B — and the evaluation it will be judged by — can be built on a corpus that records what it needs to.

**Architecture:** Both are small and independent. One adds a quality bit so the corpus records which timestamps are the feed's and which are our fetch clock. The other adds a script that measures cold-store growth against the spec's estimate, because the corpus is the one asset that cannot be recreated and nobody has checked whether it fits.

**Tech Stack:** Python 3.13+, stdlib plus the pyarrow already present. No new dependency.

**Spec:** [`docs/superpowers/specs/2026-09-21-stage-b-trained-model-design.md`](../docs/superpowers/specs/2026-09-21-stage-b-trained-model-design.md) — §10 (risks) is where both of these come from.

## Global Constraints

- **Never read or write anything under `data/`.** A live collector owns it. Scripts written here take paths as arguments and are run by the user; tests use `tmp_path`.
- **The corpus stays a faithful record of the feed.** `liveness.py`: "The readings are still collected and stored exactly as the feed sent them." Nothing here rewrites a collected row.
- **`0` is a real reading**, distinct from absent, everywhere.
- **No new dependency.**
- **No `Co-Authored-By:` trailers and no AI attribution of any kind in commit messages** (CLAUDE.md).
- Tests run via the project's container: `docker run --rm --user 0:0 -v "D:/Projects/ParkCast/src:/repo/src:ro" -v "D:/Projects/ParkCast/tests:/repo/tests:ro" -v "D:/Projects/ParkCast/scripts:/repo/scripts:ro" -v "D:/Projects/ParkCast/web/tests:/repo/web/tests:ro" -v "D:/Projects/ParkCast/pyproject.toml:/repo/pyproject.toml:ro" -w /repo -e PYTHONDONTWRITEBYTECODE=1 docker-collector:latest sh -c "pip install -q pytest 2>/dev/null; python -m pytest -q -p no:cacheprovider tests/"`

---

### Task 1: Record which timestamps are assumptions

`feed.py` already says of `ts_kind`: "A fetch-time stamp is an assumption, not a reading, and a backtest must be able to exclude it." Nothing persists it. Kaohsiung and Taoyuan are inferable from the city, but Tainan, New Taipei and Hsinchu fall back to fetch time **per record**, so for those three it is lost the moment the row is written.

No schema change: `Q` is a per-observation `IntFlag` "written at insert time", already stored as an `INTEGER` in the hot store and a per-slot `int16` list in Parquet. Bits 1/2/4 are in use and 8 is reserved for `FROZEN`; **16 is free**.

**Files:**
- Modify: `src/parkcast/quality.py` (the `Q` flag)
- Modify: `src/parkcast/store.py:70-78` (`insert_snapshot`'s row construction)
- Test: `tests/test_quality.py`, `tests/test_store.py`, `tests/test_compact.py`

**Interfaces:**
- Consumes: `feed.TS_FETCH`, `feed.Observation.ts_kind`
- Produces: `quality.Q.ASSUMED_TS` (value 16), set on any observation whose `ts_kind` is `TS_FETCH`

- [ ] **Step 1: Write the failing test**

In `tests/test_store.py`:

```python
def test_a_fetch_stamped_observation_is_flagged_as_an_assumption(conn):
    store.insert_snapshot(conn, FeedSnapshot("tainan", 1_700_000_100, (
        Observation("tainan:A", 5, None, 1_700_000_000, TS_RECORD),
        Observation("tainan:B", 5, None, 1_700_000_100, TS_FETCH),
    )), {"tainan:A": 50, "tainan:B": 50})

    flags = dict(conn.execute("SELECT lot_id, quality FROM observations"))
    assert not flags["tainan:A"] & Q.ASSUMED_TS, "the feed stamped this one itself"
    assert flags["tainan:B"] & Q.ASSUMED_TS, "this data_ts is our clock, not the feed's"


def test_the_assumption_flag_does_not_disturb_the_other_quality_bits(conn):
    # NO_CAPACITY and ASSUMED_TS are independent facts and must both survive.
    store.insert_snapshot(conn, FeedSnapshot("hsinchu", 1_700_000_100, (
        Observation("hsinchu:A", 5, None, 1_700_000_100, TS_FETCH),
    )), {})

    quality = conn.execute("SELECT quality FROM observations").fetchone()[0]
    assert quality & Q.ASSUMED_TS
    assert quality & Q.NO_CAPACITY
```

- [ ] **Step 2: Run them to verify they fail**

Run the container command above with `tests/test_store.py -k assumption`.
Expected: FAIL with `AttributeError: ASSUMED_TS`.

- [ ] **Step 3: Add the flag**

In `src/parkcast/quality.py`, inside `Q`, after `FROZEN`:

```python
    ASSUMED_TS = 16   # data_ts is our fetch clock: the feed stamped nothing
```

And extend the class docstring, which currently explains only why `FROZEN` is the exception:

```python
    ASSUMED_TS is the opposite case and genuinely belongs here: whether a feed
    stamped a record is known at the instant it is parsed, about that one
    observation, and is never revised. Three adapters (Tainan, New Taipei,
    Hsinchu) fall back to fetch time PER RECORD, so the city cannot answer it
    and nothing else can recover it afterwards.
```

- [ ] **Step 4: Set it at insert**

In `src/parkcast/store.py`, in `insert_snapshot`'s loop:

```python
    for obs in snapshot.observations:
        capacity = capacities.get(obs.lot_id)
        free_car, flags = validate(obs.free_car, capacity)
        free_motor, _ = validate(obs.free_motor, None)
        # Provenance, not validity, which is why it is OR-ed in rather than
        # returned by `validate`: nothing about the count is wrong here. It
        # cannot be recovered later -- three adapters decide it per record.
        if obs.ts_kind == TS_FETCH:
            flags |= Q.ASSUMED_TS
        rows.append(
            (obs.lot_id, snapshot.city, obs.data_ts, snapshot.observed_at,
             free_car, free_motor, int(flags))
        )
```

Add `TS_FETCH` to the existing `from parkcast.feed import ...` and `Q` to the `from parkcast.quality import ...`.

- [ ] **Step 5: Run them to verify they pass**

Expected: PASS.

- [ ] **Step 6: Prove it survives compaction**

Parquet already carries `quality` per slot, so this should need no code — the test exists to prove it rather than assume it. In `tests/test_compact.py`:

```python
def test_the_assumption_flag_reaches_the_cold_store(conn, tmp_path):
    day = date(2026, 9, 6)
    start, _ = day_bounds(day)
    store.insert_snapshot(conn, FeedSnapshot("taoyuan", start + 180, (
        Observation("taoyuan:A", 4, None, start + 180, TS_FETCH),
    )), {"taoyuan:A": 50})

    compact_day(conn, day, tmp_path)
    row = pq.read_table(tmp_path / "2026-09-06.parquet").to_pylist()[0]
    assert row["quality"][0] & Q.ASSUMED_TS, (
        "provenance that does not outlive the 48-hour hot window is no use to a "
        "backtest over months"
    )
```

- [ ] **Step 7: Run it; implement only if it fails**

If it fails, the cause is in `compact_day`'s quality list, not in this task's design.

- [ ] **Step 8: Record the discontinuity**

The bit is only meaningful for rows written after this ships, so the corpus divides in two. Add to `docs/sources.md`, under the per-city notes:

```markdown
**Timestamp provenance.** `Q.ASSUMED_TS` (quality bit 16) marks an observation whose `data_ts` is
our fetch clock rather than the feed's stamp. Kaohsiung and Taoyuan set it on every row; Tainan, New
Taipei and Hsinchu set it per record, whenever `update_time` is missing or unparseable; Taipei never
does. **The bit is only meaningful from 2026-09-21 forward** — rows collected before it shipped carry
0 for "not recorded", which is indistinguishable from "the feed stamped it". Any analysis that
excludes assumed timestamps must bound itself to data collected after that date, or it is treating an
unknown as a known.
```

- [ ] **Step 9: Run the whole suite, then commit**

```bash
git add src/parkcast/quality.py src/parkcast/store.py tests/test_store.py tests/test_compact.py docs/sources.md
git commit -m "feat(quality): record which timestamps are ours, not the feed's"
```

- [ ] **Step 10: Tell the user the collector needs a rebuild**

The live collector runs from a built image, so the flag starts being written only after:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

This is the user's action, not the implementer's. Every slot before it is a slot of unrecorded provenance, which is the whole reason this task is first.

---

### Task 2: Measure whether the corpus fits on the disk

`docs/state-of-play.md` step 5 has been open since 2026-09-17: read `data/cold/`'s growth after a full day of six cities and compare it against the spec's 150–400 MB/month estimate. The corpus is the one asset that cannot be recreated, and Stage B is about to start writing model files beside it.

A script rather than a one-off `du`, because the question recurs every time a city is added and the answer has to be comparable across runs.

**Files:**
- Create: `scripts/disk-growth.py`
- Test: `tests/test_disk_growth.py`

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `disk_growth.summarise(sizes: dict[date, int], *, hot_bytes: int) -> Report` with fields `days`, `total_bytes`, `mean_bytes_per_day`, `projected_bytes_per_month`, `newest_day_bytes`

- [ ] **Step 1: Write the failing test**

Create `tests/test_disk_growth.py`. The arithmetic is the part worth testing; the filesystem walk is not.

```python
from datetime import date
import importlib.util, pathlib, sys

spec = importlib.util.spec_from_file_location(
    "disk_growth", pathlib.Path(__file__).resolve().parent.parent / "scripts" / "disk-growth.py")
disk_growth = importlib.util.module_from_spec(spec)
sys.modules["disk_growth"] = disk_growth
spec.loader.exec_module(disk_growth)


def test_a_month_is_projected_from_the_mean_day():
    report = disk_growth.summarise(
        {date(2026, 9, 18): 1_000_000, date(2026, 9, 19): 3_000_000}, hot_bytes=0)
    assert report.mean_bytes_per_day == 2_000_000
    assert report.projected_bytes_per_month == 2_000_000 * 30


def test_the_newest_day_is_reported_separately_from_the_mean():
    # Cities were added over time, so the mean understates the current rate --
    # the number that matters for "will this fit" is the newest full day.
    report = disk_growth.summarise(
        {date(2026, 9, 16): 200_000, date(2026, 9, 20): 1_800_000}, hot_bytes=0)
    assert report.newest_day_bytes == 1_800_000
    assert report.mean_bytes_per_day == 1_000_000


def test_an_empty_cold_store_projects_nothing_rather_than_zero():
    # Zero would read as "it costs nothing", which is a different claim.
    report = disk_growth.summarise({}, hot_bytes=0)
    assert report.mean_bytes_per_day is None
    assert report.projected_bytes_per_month is None
```

- [ ] **Step 2: Run them to verify they fail**

Expected: FAIL at module load — the file does not exist.

- [ ] **Step 3: Write the script**

```python
#!/usr/bin/env python
"""How fast the cold store is growing, and what that means for a month.

    python scripts/disk-growth.py
    python scripts/disk-growth.py --cold data/cold --hot data/hot.sqlite

Open since 2026-09-17: the nationwide spec estimated 150-400 MB/month for six
cities and the plan deliberately left it unmeasured. The corpus is the only
asset in this project that cannot be recreated -- a feed serves the present, so
a day not collected is gone -- which makes "does it fit" a question worth a
script rather than a one-off `du`.

The newest full day matters more than the mean. Cities were added over two
weeks, so the mean is an average over a corpus that was smaller for most of its
life, and it understates today's rate.
"""
import argparse
from dataclasses import dataclass
from datetime import date
from pathlib import Path

DAYS_PER_MONTH = 30


@dataclass(frozen=True)
class Report:
    days: int
    total_bytes: int
    hot_bytes: int
    mean_bytes_per_day: float | None
    projected_bytes_per_month: float | None
    newest_day_bytes: int | None


def summarise(sizes: dict[date, int], *, hot_bytes: int) -> Report:
    """Turn per-day byte counts into the numbers the question needs.

    None rather than 0 for an empty corpus: 0 would read as "it costs nothing",
    which is a claim, where None is the absence of one.
    """
    if not sizes:
        return Report(0, 0, hot_bytes, None, None, None)
    total = sum(sizes.values())
    mean = total / len(sizes)
    return Report(
        days=len(sizes),
        total_bytes=total,
        hot_bytes=hot_bytes,
        mean_bytes_per_day=mean,
        projected_bytes_per_month=mean * DAYS_PER_MONTH,
        newest_day_bytes=sizes[max(sizes)],
    )


def day_sizes(cold_dir: Path) -> dict[date, int]:
    """One entry per compacted day. A stem that is not an ISO date is not ours."""
    sizes: dict[date, int] = {}
    for path in sorted(cold_dir.glob("*.parquet")):
        try:
            day = date.fromisoformat(path.stem)
        except ValueError:
            continue
        sizes[day] = path.stat().st_size
    return sizes


def mb(value: float | None) -> str:
    return "--" if value is None else f"{value / 1_000_000:,.1f} MB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cold", default="data/cold")
    ap.add_argument("--hot", default="data/hot.sqlite")
    ap.add_argument("--estimate-low", type=float, default=150.0,
                    help="the spec's low estimate, MB/month")
    ap.add_argument("--estimate-high", type=float, default=400.0,
                    help="the spec's high estimate, MB/month")
    args = ap.parse_args()

    cold = Path(args.cold)
    if not cold.exists():
        raise SystemExit(f"no cold store at {cold}")
    hot = Path(args.hot)
    report = summarise(day_sizes(cold), hot_bytes=hot.stat().st_size if hot.exists() else 0)

    print(f"COLD STORE  {args.cold}")
    print(f"  compacted days     {report.days}")
    print(f"  total              {mb(report.total_bytes)}")
    print(f"  mean day           {mb(report.mean_bytes_per_day)}")
    print(f"  newest full day    {mb(report.newest_day_bytes)}   <- today's rate")
    print(f"  hot store          {mb(report.hot_bytes)}  (bounded: 48h window)")
    if report.newest_day_bytes is not None:
        at_current = report.newest_day_bytes * DAYS_PER_MONTH / 1_000_000
        print(f"\nprojected from the newest day: {at_current:,.1f} MB/month")
        print(f"the spec estimated {args.estimate_low:,.0f}-{args.estimate_high:,.0f} MB/month")
        if at_current > args.estimate_high:
            print(f"  OVER the high estimate by {at_current - args.estimate_high:,.1f} MB/month")
        elif at_current < args.estimate_low:
            print(f"  UNDER the low estimate by {args.estimate_low - at_current:,.1f} MB/month")
        else:
            print("  inside the estimate")
        print(f"\na year at this rate: {at_current * 12 / 1000:,.2f} GB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the script end-to-end on a fixture, never on `data/`**

Build a throwaway cold directory with two `.parquet` files of known size in `tmp`, run the script against it with `--cold`, and check the printed mean and projection match the bytes written. The live `data/` directory is never an argument here.

- [ ] **Step 6: Commit**

```bash
git add scripts/disk-growth.py tests/test_disk_growth.py
git commit -m "feat(ops): measure whether the corpus fits on the disk"
```

- [ ] **Step 7: Hand the measurement to the user**

Only the user may run this against the live store:

```bash
python scripts/disk-growth.py
```

Record the result in `docs/state-of-play.md` step 5 and close it.

---

## After these two

Stage B's own plan is written once these have landed and the disk number is known — the trainer's memory and fit-time budgets depend on it, and a plan that guessed them would be a plan with placeholders in it. The corpus also needs the depth §10 describes: six-city collection began 2026-09-17, and the evaluation's own bar is every half-hour-of-week bucket having three days behind it, targeted around 2026-10-01.

Not prerequisites, and deliberately not in this plan:

- **Frozen readings out of `Counts`.** Long deferred, and it moves every published probability for every city. `NOT_UPDATING_AFTER_SEC` is 24 hours, so a run spans day boundaries, while `load_history`'s scan is deliberately unordered — the `ORDER BY` it avoids costs 11.19 s against 0.16 s. It needs its own spec and its own before/after measurement. Stage B does not depend on it: excluding frozen rows from the *training set* is the trainer's own business (spec §4.2), and the support features in §3.3 exist partly so the model can learn to distrust a frozen bucket by itself.
