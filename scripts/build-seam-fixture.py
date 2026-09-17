"""Emit `(ts, bucket)` pairs from the real `forecast.week_bucket`, for the
client's `weekBucket` (`web/src/week.ts`) to be checked against.

`weekBucket` must agree with `forecast.week_bucket` exactly: bucket 0 is
Thursday 00:00 Taipei, NOT Monday, because `week_bucket` anchors on the bare
Unix epoch (1970-01-01, a Thursday) and does no calendar arithmetic. An
earlier draft of the Stage A plan asserted a Monday-anchored table; a
`weekBucket` written to satisfy it would have disagreed with Python by 192
buckets -- four days -- and passed its own test. A hand-typed expectation
table is just that same mistake waiting to happen again: it can only ever
restate one author's arithmetic. Every row below is instead computed by
calling the real function.

    python scripts/build-seam-fixture.py

`tests/test_seam_fixture.py` asserts regenerating this file reproduces the
committed `web/tests/fixtures/week-buckets.json` byte-for-byte, so a change to
`week_bucket`, `config.TAIPEI_TZ`, or this script that would silently
invalidate the fixture is caught in the Python suite instead of surfacing as
an unexplained JS failure downstream.

Task 6 (Stage A) took that invitation up, as a second `build_*`/`render_*`/
`write_*` trio below rather than a rewrite: this script now ALSO emits the
seam blobs -- `web/tests/fixtures/seam-grid.bin`, `seam-week.bin` and
`seam.json` -- from one synthetic history, through the real `forecast.Blend`,
`grid.build_grid`/`artifacts.encode_grid` and
`week.build_week_cells`/`artifacts.encode_week` (plan ruling R9). See the
"the seam fixture" section below for why every byte of both blobs has to be
written by Python and only ever read by TypeScript. One run

    python scripts/build-seam-fixture.py

writes all four fixtures, and `tests/test_seam_fixture.py` asserts all four
regenerate byte-identically.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from parkcast import artifacts, config, forecast, grid, ids, week  # noqa: E402
from parkcast.config import TAIPEI_TZ  # noqa: E402
from parkcast.forecast import week_bucket  # noqa: E402

FIXTURE_PATH = ROOT / "web" / "tests" / "fixtures" / "week-buckets.json"

# A real Mon..Sun calendar week -- checked against the calendar (see
# `test_seam_fixture.py`), not assumed -- so every row's label can be dated by
# a reader without trusting this script's own arithmetic.
_MONDAY = date(2026, 9, 14)
_WEEKDAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

# Both sides of every half-hour bucket boundary, and both sides of every
# midnight -- which is also where the Wed->Thu bucket-336 wrap and the
# Sun->Mon calendar wrap both live, at no extra bookkeeping.
_TIMES_OF_DAY = (
    (0, 0), (0, 29), (0, 30),
    (6, 15), (11, 59), (12, 0),
    (18, 45), (23, 29), (23, 30), (23, 59),
)


def taipei_ts(year: int, month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0) -> int:
    """Unix seconds for a Taipei wall-clock moment, via the collector's own tz.

    Building rows from real calendar dates -- rather than raw epoch-offset
    arithmetic -- makes each row's label trustworthy on its own: `TAIPEI_TZ` is
    the exact `timezone(timedelta(hours=8))` every `week_bucket` caller already
    runs under, so this cannot disagree with it about what "Monday" means.
    """
    return int(datetime(year, month, day, hour, minute, second, tzinfo=TAIPEI_TZ).timestamp())


def row(ts: int, label: str) -> dict:
    """One fixture row: `ts`, its bucket (computed by the real function), and
    a human label for anyone spot-checking a value by hand."""
    return {"ts": ts, "bucket": week_bucket(ts), "label": label}


def _pinned_rows() -> list[dict]:
    """The five rows the Stage A plan's task-5 brief pins by name, kept
    explicit so a reader can match them straight to that table -- even though
    every one of them also recurs inside `_spread_rows`'s grid below.
    """
    return [
        row(taipei_ts(2026, 9, 17, 0, 0), "Thu 00:00 Taipei -- bucket 0, not Monday"),
        row(taipei_ts(2026, 9, 14, 0, 0), "Mon 00:00 Taipei"),
        row(taipei_ts(2026, 9, 14, 0, 29), "Mon 00:29 Taipei"),
        row(taipei_ts(2026, 9, 14, 0, 30), "Mon 00:30 Taipei"),
        row(taipei_ts(2026, 9, 13, 23, 30), "Sun 23:30 Taipei"),
    ]


def _spread_rows() -> list[dict]:
    """One row per (weekday, time-of-day) across the full calendar week
    above, plus the Monday that opens the following week -- so the grid's
    last row (Sun 23:59) has an explicit successor across the Sunday->Monday
    boundary to compare against.
    """
    rows = []
    for offset, name in enumerate(_WEEKDAY_NAMES):
        d = _MONDAY + timedelta(days=offset)
        for hour, minute in _TIMES_OF_DAY:
            rows.append(row(
                taipei_ts(d.year, d.month, d.day, hour, minute),
                f"{name} {hour:02d}:{minute:02d} Taipei ({d.isoformat()})",
            ))
    next_monday = _MONDAY + timedelta(days=7)
    rows.append(row(
        taipei_ts(next_monday.year, next_monday.month, next_monday.day, 0, 0),
        f"Mon 00:00 Taipei ({next_monday.isoformat()}), the week after -- Sunday->Monday wrap",
    ))
    return rows


def _negative_ts_rows() -> list[dict]:
    """Timestamps at and before the Unix epoch, where JS `Math.floor` and
    Python `//` must still agree -- `Math.trunc` / `x | 0` would not, and
    would misbucket every one of these.
    """
    anchor = taipei_ts(1970, 1, 1, 0, 0)  # -28800: bucket 0's own representative ts
    return [
        row(anchor, "epoch shifted to exactly Thu 00:00 Taipei, 1970-01-01 (bucket-0 anchor)"),
        row(anchor - 1, "one second earlier: Wed 23:59:59 Taipei, 1969-12-31 -- must floor to bucket 335"),
        row(anchor - 4 * 86400, "four days before the anchor: Sun 00:00 Taipei, 1969-12-28"),
        row(anchor - 3 * 86400, "three days before the anchor: Mon 00:00 Taipei, 1969-12-29"),
        row(-1, "one second before the Unix epoch (UTC) -- still floors correctly across the +8h shift"),
    ]


def build_rows() -> list[dict]:
    """Every fixture row: the plan's five pinned values, a full-week spread
    over every half-hour boundary and midnight, and negative-domain coverage.
    """
    return _pinned_rows() + _spread_rows() + _negative_ts_rows()


def render(rows: list[dict]) -> str:
    """The fixture file's exact text.

    Stable across runs -- no wall-clock reads, no randomness, no unordered
    iteration -- which is what lets `test_seam_fixture.py` check regeneration
    byte-for-byte instead of merely "close enough".
    """
    payload = {
        "generator": "scripts/build-seam-fixture.py",
        "source": "parkcast.forecast.week_bucket",
        "rows": rows,
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


# --- the seam fixture: one synthetic history, both artifacts ----------------
#
# `web/tests/seam.test.ts` pins the boundary between ParkCast's two sources of
# a probability. Inside +120 min the client reads the answer straight out of
# `grid.bin`; past it, the client computes its own from `week.bin`:
#
#     blend(f, probabilityAt(week, lot, t).p, minutesFromReading)
#
# At exactly +120 min both are defined, and they must agree -- otherwise a
# driver dragging the arrival time across the two-hour mark watches the number
# jump for no reason the data supports.
#
# Both blobs are built HERE, in Python, by the very functions that build the
# published artifacts, and are only ever READ by that test. A fixture that
# constructed either blob in TypeScript could only prove the client agrees
# with itself: the client's arithmetic would sit on both sides of the equals
# sign, and a client that computes the seam differently from the server is
# precisely the bug the test exists to catch.
#
# These are also the first bytes the JS suite reads that Python actually
# wrote, which is what makes that test the only guard on CROSS-LANGUAGE
# LAYOUT AGREEMENT. `week.test.ts` exercises `parseWeek` hard, but against
# tables its own `makeWeek` helper lays out by hand -- a second, independent
# statement of the wire format that never consults `encode_week`. Add a pad
# byte to `WEEK_HEADER_FORMAT` (`"<4sBIHHBI"` -> `"<4sBIHHBxI"`) and
# regenerate these fixtures: the whole Python suite stays green, because it
# compares the encoder against itself, and `week.test.ts` stays green, because
# it compares the client against itself. Only `seam.test.ts` fails. That gap
# is what these blobs close, and it is why they have to be written here.

SEAM_GRID_PATH = ROOT / "web" / "tests" / "fixtures" / "seam-grid.bin"
SEAM_WEEK_PATH = ROOT / "web" / "tests" / "fixtures" / "seam-week.bin"
SEAM_JSON_PATH = ROOT / "web" / "tests" / "fixtures" / "seam.json"

SEAM_CITY = "taipei"

# The reading every forecast in this fixture is made from: Wed 2026-09-16
# 19:20 Taipei. `+120 min` lands at 21:20 the same evening -- four buckets
# later, in a DIFFERENT half-hour-of-week bucket from the reading's own, which
# is what lets the JS test tell a client that buckets on the arrival time
# apart from one that quietly reused the reading's bucket. (2026-09-14 is the
# Monday `_MONDAY` above is dated against, so this is a Wednesday.)
SEAM_BASE_TS = taipei_ts(2026, 9, 16, 19, 20)
# Fixed, never `time.time()`: every byte this script writes has to be the same
# on every run, or `tests/test_seam_fixture.py` could not check regeneration
# byte-for-byte. The grid is stamped a moment after the reading it was built
# from, as the live scheduler stamps it; the week table earlier the same day,
# on the corpus's own slower schedule.
SEAM_GENERATED_AT = SEAM_BASE_TS + 47
SEAM_BUILT_TS = taipei_ts(2026, 9, 16, 4, 0)

# How many weeks of history each sampled time of week carries.
SEAM_WEEKS = 8
# The free-space count an observation WITH a space carries. Any value >= 1
# scores the same hit -- `Counts.add` and `Persistence` both only ask
# `free >= 1` -- so the exact number is cosmetic; a realistic one just keeps
# the synthetic corpus readable.
SEAM_FREE = 4

# The sampled times of week, as `(day_delta, hour, minute)` Taipei relative to
# the reading's own day, replayed at `-7 * week` days for `SEAM_WEEKS` weeks.
#
# Every entry resolves strictly before `SEAM_BASE_TS`: a history holding an
# observation from after its own `latest_ts` would let `Climatology` count the
# very reading the grid is being asked to forecast from. That is why the 21:0x
# rows start at `-7` -- this Wednesday's 21:05 has not happened yet at 19:20,
# so the newest observation in that bucket is last Wednesday's.
SEAM_SLOTS = (
    (0, 19, 2),    # 0 |  the reading's own bucket, Wed 19:00-19:30
    (0, 19, 14),   # 1 |
    (-7, 21, 5),   # 2 |  +120 min from the reading: Wed 21:00-21:30,
    (-7, 21, 25),  # 3 |  the bucket this whole fixture turns on
    (0, 8, 15),    # 4 |  elsewhere in the week: feeds the lot and citywide
    (0, 12, 45),   # 5 |  tiers, so the shrinkage chain has real parents to
    (-1, 21, 5),   # 6 |  fall back through rather than a degenerate one
    (-2, 13, 15),  # 7 |
    (-3, 9, 45),   # 8 |
    (-4, 17, 30),  # 9 |
)
_SEAM_BASE_DATE = date(2026, 9, 16)


@dataclass(frozen=True)
class SeamLot:
    """One synthetic lot: its published id, its reading at `SEAM_BASE_TS`, and
    how many of the `SEAM_WEEKS` weeks had a space at each `SEAM_SLOTS` entry.

    `free_now` is `Persistence`'s entire input (`1.0 if free >= 1 else 0.0`)
    and is also the `f` the JS test hands `blend`. `hits` is a count, not a
    pattern: the weeks are filled oldest-first, which is arbitrary but fixed,
    because everything downstream only ever counts them.
    """

    bare_id: str
    free_now: int
    hits: tuple[int, ...]

    def __post_init__(self) -> None:
        if len(self.hits) != len(SEAM_SLOTS):
            raise ValueError(
                f"{self.bare_id}: {len(self.hits)} hit counts for {len(SEAM_SLOTS)} slots"
            )
        if any(not 0 <= h <= SEAM_WEEKS for h in self.hits):
            raise ValueError(f"{self.bare_id}: a hit count is outside 0..{SEAM_WEEKS}")

    @property
    def lot_id(self) -> str:
        """The namespaced, stored spelling -- what `History` and
        `build_week_cells` are keyed by. `bare_id` is the published one, which
        is what both encoders and `roster_id` want. Deriving both from one
        place mirrors `scheduler.publish_city`, the single point in production
        where the two spellings meet.
        """
        return ids.qualify(SEAM_CITY, self.bare_id)


# Four lots, so the fixture lot is neither the first row -- where a wrong row
# stride reads the right bytes anyway -- nor the last, where an over-read runs
# off the end and fails for the wrong reason. Their profiles differ on
# purpose: a row-offset bug in either the encoder or the client then has to
# land on a visibly different number rather than a neighbour's plausible one.
SEAM_LOTS = (
    SeamLot("SEAM0001", 0, (1, 2, 1, 0, 6, 4, 2, 5, 7, 3)),   # usually full
    SeamLot("SEAM0002", 9, (8, 7, 6, 6, 8, 7, 6, 8, 8, 7)),   # usually free
    SeamLot("SEAM0003", 3, (7, 8, 2, 1, 5, 4, 3, 6, 7, 5)),   # <- the fixture lot
    SeamLot("SEAM0004", 0, (4, 4, 4, 4, 4, 4, 4, 4, 4, 4)),   # flat
)

# SEAM0003: reliably has a space at 19:2x but usually full at 21:2x, with a
# live reading that says it has a space right now. Climatology and persistence
# therefore pull in OPPOSITE directions at +120 min, so the blend weight is
# load-bearing rather than arithmetically invisible -- a client that dropped
# the weight entirely, or applied it to the wrong term, cannot pass by
# accident.
#
# Its 21:00-21:30 bucket also carries a real, mixed observation count. That
# keeps it clear of the one legitimate divergence at this seam, which is not
# what this test is for: when `Climatology.predict` returns `None` but
# `Persistence` does not, `Blend` falls through to pure persistence and the
# grid stores 0 or 100, while the week cell stores `WEEK_UNKNOWN` (255) and
# the client honestly renders "no data". That is intended behaviour, in the
# honest direction. `tests/test_seam_fixture.py` and the JS test both assert
# this cell is not 255, so the seam test cannot silently degenerate into
# passing for that reason instead of the right one.
SEAM_FIXTURE_INDEX = 2


def _seam_observations() -> list[tuple[str, int, int]]:
    """Every synthetic observation as `(lot_id, ts, free_car)`.

    One per (lot, slot, week), plus the reading each lot is sitting on at
    `SEAM_BASE_TS` -- the live tick, which the store would hold and the counts
    would include exactly like any other observation.
    """
    out: list[tuple[str, int, int]] = []
    for lot in SEAM_LOTS:
        for (day_delta, hour, minute), hits in zip(SEAM_SLOTS, lot.hits):
            for week_index in range(SEAM_WEEKS):
                day = _SEAM_BASE_DATE + timedelta(days=day_delta - 7 * week_index)
                ts = taipei_ts(day.year, day.month, day.day, hour, minute)
                out.append((lot.lot_id, ts, SEAM_FREE if week_index < hits else 0))
        out.append((lot.lot_id, SEAM_BASE_TS, lot.free_now))
    return out


def build_seam_history() -> forecast.History:
    """The synthetic corpus, as the real `forecast.History` the real
    forecasters read.

    Assembled here rather than round-tripped through `store` +
    `load_history`: the counters are the real `forecast.Counts`, fed one
    observation at a time through its real `add` -- which is the only thing
    `load_history` does with the rows it reads -- so `Climatology` sees
    exactly the tallies it would see in production, with no temporary SQLite
    file and no dependence on anything outside this script. It also keeps this
    generator clear of `data/`, which a live collector owns.

    `recent` is the same bounded newest-`HISTORY_TAIL` tail `load_history`
    keeps. Nothing on this path reads it (`Persistence` takes `current`,
    `Climatology` takes `counts`), but a `History` with an empty tail beside a
    populated `current` is not a shape production can produce, and a fixture
    should not be the first place someone meets one.
    """
    counts = forecast.Counts()
    series: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for lot_id, ts, free in _seam_observations():
        counts.add(lot_id, ts, free)
        series[lot_id].append((ts, free))
    recent = {lot_id: sorted(obs)[-config.HISTORY_TAIL:] for lot_id, obs in series.items()}
    current = {lot.lot_id: lot.free_now for lot in SEAM_LOTS}
    return forecast.History(SEAM_BASE_TS, current, recent, counts)


def build_seam_blobs() -> tuple[bytes, bytes, dict]:
    """`(grid_blob, week_blob, seam_json_payload)` from one history.

    Both blobs travel the production path exactly: `build_grid` over a real
    `Blend` for the grid, `build_week_cells` over a real `Climatology` for the
    week table, each handed to its real encoder, each keyed by the namespaced
    ids the history uses and headed by the bare ids the artifacts publish --
    the same id bridge `scheduler.publish_week` crosses, for the same reason.
    Nothing here computes a probability of its own.

    `liveness.Withholding`, which `publish_city` wraps its forecaster in, is
    deliberately absent: it exists to blank the rows of lots whose feed has
    stopped, and blanking the fixture lot's row would replace the number this
    test measures with the 255 it must not be reading.
    """
    history = build_seam_history()
    lot_ids = [lot.lot_id for lot in SEAM_LOTS]          # namespaced: the forecaster's keys
    published_ids = [lot.bare_id for lot in SEAM_LOTS]   # bare: the artifacts' rows

    grid_blob = artifacts.encode_grid(
        grid.build_grid(forecast.Blend(history), lot_ids, SEAM_BASE_TS),
        generated_at=SEAM_GENERATED_AT,
        base_data_ts=SEAM_BASE_TS,
        lot_ids=published_ids,
    )

    cells = week.build_week_cells(history, lot_ids)
    bare_cells = {ids.bare(lot_id): row for lot_id, row in cells.items()}
    week_blob = artifacts.encode_week(published_ids, bare_cells, built_ts=SEAM_BUILT_TS)

    fixture = SEAM_LOTS[SEAM_FIXTURE_INDEX]
    payload = {
        "generator": "scripts/build-seam-fixture.py",
        "source": "parkcast.forecast.Blend, via parkcast.grid.build_grid and parkcast.week.build_week_cells",
        # Deliberately only what the JS test needs to INDEX the two blobs. No
        # expected probability, no bucket number, no header sizes: every value
        # the test compares has to come back out of the bytes, or the test
        # would be checking this script's arithmetic against itself.
        "lot_index": SEAM_FIXTURE_INDEX,
        "lot_id": fixture.bare_id,
        "f": fixture.free_now,
        "base_data_ts": SEAM_BASE_TS,
    }
    return grid_blob, week_blob, payload


def render_seam_json(payload: dict) -> str:
    """`seam.json`'s exact text -- the same stable, diffable shape `render`
    gives the bucket table, for the same byte-for-byte reason."""
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def write_seam() -> None:
    grid_blob, week_blob, payload = build_seam_blobs()
    seam_json = render_seam_json(payload)
    SEAM_GRID_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEAM_GRID_PATH.write_bytes(grid_blob)
    SEAM_WEEK_PATH.write_bytes(week_blob)
    SEAM_JSON_PATH.write_text(seam_json, encoding="utf-8", newline="\n")
    for path, size in (
        (SEAM_GRID_PATH, len(grid_blob)),
        (SEAM_WEEK_PATH, len(week_blob)),
        (SEAM_JSON_PATH, len(seam_json.encode("utf-8"))),
    ):
        print(f"wrote {size} bytes to {path.relative_to(ROOT)}")


def main() -> None:
    rows = build_rows()
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(render(rows), encoding="utf-8", newline="\n")
    print(f"wrote {len(rows)} rows to {FIXTURE_PATH.relative_to(ROOT)}")
    write_seam()


if __name__ == "__main__":
    main()
