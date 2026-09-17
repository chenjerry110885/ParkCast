"""Build a dev-only `week.bin` for `npm run dev`, from a synthetic history.

`scripts/sync-artifacts.mjs` fills `web/.dev-artifacts/` with the published
`grid.bin` and `lots.json`, but not `week.bin`: the client asks for the week
table lazily, and the copy the live site serves is 715 KB. So a developer
driving the app to a far arrival -- tomorrow evening, or any time past the
grid's two-hour window -- got a 404 and the honest "no data" that follows it,
and the whole `week.bin` half of the screen was unreachable outside the test
suite. That includes the two states Task 10b exists for: a week-sourced
probability during a stale period, and a car park whose own feed has stopped
still saying so while a climatology number stands beside it.

    python scripts/build-dev-week.py

This is **not** a fixture and nothing asserts its bytes. `seam-week.bin` is the
pinned artifact (`scripts/build-seam-fixture.py`, `tests/test_seam_fixture.py`
asserts it regenerates byte-identically); this is a development convenience,
and `web/.dev-artifacts/` is gitignored, so the file it writes is never
committed and its numbers are never anybody's expected value.

**It does not read `data/`.** A live collector owns that directory, and this
script never opens it -- the same discipline `build_seam_history` states in
`build-seam-fixture.py`. The corpus here is invented in memory and pushed
through the real `forecast.Counts.add`, exactly as `load_history` would push
rows read from the store, so `week.build_week_cells` sees the tallies it would
see in production and `artifacts.encode_week` writes the bytes it would write.
Nothing here computes a probability of its own.

The roster comes from `web/.dev-artifacts/lots.json`, in published row order,
so `artifacts.roster_id` derives the same 32-bit identity `grid.bin` carries
and the client's `weekTable.rosterId === grid.rosterId` check passes. That
check is the reason this cannot be a generic table: a week file built against
any other ordering answers every row with some other car park's history.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from parkcast import artifacts, config, forecast, week  # noqa: E402
from parkcast.forecast import week_bucket  # noqa: E402

LOTS_PATH = ROOT / "web" / ".dev-artifacts" / "lots.json"
WEEK_PATH = ROOT / "web" / ".dev-artifacts" / "week.bin"

#: Seconds in one climatology bucket, and in one week of them. `week_bucket` is
#: invariant under a shift of a whole week, which is what lets the same bucket
#: be fed from several distinct weeks below.
BUCKET_SEC = config.CLIMATOLOGY_BUCKET_MIN * 60
WEEK_SEC = config.WEEK_BUCKETS * BUCKET_SEC

#: Four weeks at the collector's own five-minute cadence gives each bucket 24
#: observations -- `confidence.ts`'s `SUPPORT_HIGH_MIN`, so a dev build shows
#: the "high, 4 weeks" grade rather than sitting on "not watched often enough"
#: for every lot. Six five-minute slots fit inside a thirty-minute bucket.
DEFAULT_WEEKS = 4
PER_WEEK = BUCKET_SEC // 300


def occupancy(lot_id: str, bucket: int) -> float:
    """A plausible, deterministic P(a space) for one lot in one half-hour.

    Invented, and openly so: the point of this file is that the *shape* of the
    screen is exercisable in dev -- rings at different values, a confidence
    pill with weeks behind it, the seam between the grid and the week table --
    not that any particular car park's number is real. It is derived from the
    lot id rather than drawn at random so two runs produce the same table and a
    developer chasing a rendering bug is not also chasing a moving number.

    Shaped by time of day so the seven-day picker visibly does something: a
    quiet early morning, a busy afternoon and evening, and a per-lot base rate
    that keeps the map from being one flat colour.
    """
    seed = sum(ord(c) * (i + 7) for i, c in enumerate(lot_id))
    base = 0.30 + 0.60 * ((seed % 977) / 977)
    hour = (bucket * config.CLIMATOLOGY_BUCKET_MIN // 60) % 24
    if 2 <= hour < 7:
        factor = 1.25          # nearly empty overnight
    elif 11 <= hour < 21:
        factor = 0.65          # the hours a driver actually asks about
    else:
        factor = 1.0
    return min(0.97, max(0.03, base * factor))


def bucket_start(anchor_ts: int, bucket: int) -> int:
    """A timestamp `week_bucket` puts in `bucket`, at or before `anchor_ts`.

    Multiples of `BUCKET_SEC` are exactly the bucket boundaries -- Taipei's
    offset is 8 h, a whole number of half-hours -- so stepping the anchor back
    by whole buckets walks the index down by the same count, modulo the week.
    Asserted rather than assumed: this is the one piece of arithmetic here that
    is not simply handed to `week_bucket`, and getting it wrong would mis-file
    every observation by a constant nobody would notice in a dev build.
    """
    floor = (anchor_ts // BUCKET_SEC) * BUCKET_SEC
    ts = floor - ((week_bucket(floor) - bucket) % config.WEEK_BUCKETS) * BUCKET_SEC
    assert week_bucket(ts) == bucket, (ts, bucket, week_bucket(ts))
    return ts


def build_history(lots: list[dict], anchor_ts: int, weeks: int) -> forecast.History:
    """The synthetic corpus, as the real `forecast.History` the real models read.

    Fed one observation at a time through the real `Counts.add`, which is the
    only thing `load_history` does with the rows it reads, so `Climatology`
    sees production's tallies. No SQLite file, no `data/`, nothing held: the
    counts are the whole point and the observations are thrown away as they go.

    `current` is each lot's own published `f` from `lots.json` -- the live
    reading the grid was built from -- so the blend at the seam decays from the
    same count the card's "spaces now" tile shows. `recent` carries the bounded
    newest-`HISTORY_TAIL` tail `load_history` keeps: nothing on this path reads
    it, but a `History` with an empty tail beside a populated `current` is not
    a shape production can produce.
    """
    counts = forecast.Counts()
    recent: dict[str, list[tuple[int, int]]] = {}
    starts = [bucket_start(anchor_ts, b) for b in range(config.WEEK_BUCKETS)]
    for lot in lots:
        lot_id = lot["id"]
        tail: list[tuple[int, int]] = []
        for bucket, start in enumerate(starts):
            hits = round(occupancy(lot_id, bucket) * weeks * PER_WEEK)
            n = 0
            for w in range(weeks):
                for slot in range(PER_WEEK):
                    ts = start - w * WEEK_SEC + slot * 300
                    free = 1 if n < hits else 0
                    counts.add(lot_id, ts, free)
                    tail.append((ts, free))
                    n += 1
            if len(tail) > config.HISTORY_TAIL:
                tail = sorted(tail)[-config.HISTORY_TAIL:]
        recent[lot_id] = sorted(tail)[-config.HISTORY_TAIL:]
    current = {lot["id"]: lot["f"] for lot in lots if isinstance(lot.get("f"), int)}
    return forecast.History(anchor_ts, current, recent, counts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weeks", type=int, default=DEFAULT_WEEKS,
                        help=f"weeks of synthetic history per bucket (default {DEFAULT_WEEKS})")
    args = parser.parse_args()

    if not LOTS_PATH.exists():
        raise SystemExit(
            f"{LOTS_PATH.relative_to(ROOT)} is missing -- run `npm run sync-artifacts` in web/ first. "
            "This script never reads data/."
        )
    doc = json.loads(LOTS_PATH.read_text(encoding="utf-8"))
    # Published row order is `i`, not the array's: `fetchLots` reads every row
    # at the index the lot declares, and `roster_id` hashes the ids in order.
    lots = sorted(doc["lots"], key=lambda lot: lot["i"])
    lot_ids = [lot["id"] for lot in lots]

    derived = artifacts.roster_id(lot_ids)
    if derived != doc["roster_id"]:
        raise SystemExit(
            f"roster id {derived} derived from lots.json's own rows does not match its header's "
            f"{doc['roster_id']} -- the client would refuse this table, and rightly."
        )

    history = build_history(lots, int(doc["base_data_ts"]), args.weeks)
    cells = week.build_week_cells(history, lot_ids)
    blob = artifacts.encode_week(lot_ids, cells, built_ts=int(doc["base_data_ts"]))
    WEEK_PATH.parent.mkdir(parents=True, exist_ok=True)
    WEEK_PATH.write_bytes(blob)
    print(
        f"wrote {len(blob)} bytes to {WEEK_PATH.relative_to(ROOT)} "
        f"({len(lot_ids)} lots x {config.WEEK_BUCKETS} buckets, roster {derived}, "
        f"{args.weeks * PER_WEEK} observations per bucket)"
    )


if __name__ == "__main__":
    main()
