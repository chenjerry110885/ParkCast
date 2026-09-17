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

Task 6 (Stage A) extends this same script to also emit the seam `grid.bin` /
`week.bin` blobs and a `seam.json` describing them (plan ruling R9). The
functions below are split -- row-building, rendering, writing -- so that
addition is a new `build_*`/`render_*`/`write_*` trio alongside these, not a
rewrite. It must not itself build those blobs; that is Task 6's work.
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

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


def main() -> None:
    rows = build_rows()
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(render(rows), encoding="utf-8", newline="\n")
    print(f"wrote {len(rows)} rows to {FIXTURE_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
