"""How much of the corpus actually exists, and when the holes are.

The collector runs on a laptop, so it stops whenever the machine sleeps. That is
a documented, accepted limitation -- but "there are gaps" is not a fact anyone
can plan around, and Plan 4 has to report per-bucket support alongside any skill
number. This turns the limitation into a measurement.

The cold store keeps one row per lot per Taipei day, with 288 five-minute slots
in fixed-size lists, so a missed tick is a **null slot** rather than a missing
row. Coverage is therefore counted as "slots where anything was recorded",
using `lag` -- present exactly when a reading was actually collected, and
distinct from `free_car`, which is legitimately null when the feed itself said
-9 for a lot that was reporting nothing.

The half-hour strip matters more than the percentage. Random gaps would average
out; these do not. If the machine is habitually asleep at the same time each
day, those hours are thin in every week of climatology at once, and the model
will be least informed exactly where it is least able to notice.

    python scripts/corpus-coverage.py
    python scripts/corpus-coverage.py --cold data/cold --hot data/hot.sqlite
"""
import argparse
import sqlite3
import sys
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
SLOTS_PER_DAY = 288          # 24h at the feed's five-minute cadence
MINUTES_PER_CELL = 30        # one character of the strip
SLOTS_PER_CELL = MINUTES_PER_CELL // 5


def strip(covered: set[int]) -> str:
    """One character per half-hour: full, partial, or nothing at all."""
    out = []
    for start in range(0, SLOTS_PER_DAY, SLOTS_PER_CELL):
        got = sum(1 for s in range(start, start + SLOTS_PER_CELL) if s in covered)
        out.append("#" if got == SLOTS_PER_CELL else "+" if got else ".")
    return "".join(out)


def cold_coverage(cold_dir: Path) -> dict[date, set[int]]:
    days: dict[date, set[int]] = {}
    for path in sorted(cold_dir.glob("*.parquet")):
        table = pq.read_table(path, columns=["date", "lag"])
        if table.num_rows == 0:
            continue
        day = date.fromisoformat(str(table["date"][0].as_py()))
        covered: set[int] = set()
        for row in table["lag"]:
            for slot, value in enumerate(row):
                if value.as_py() is not None:
                    covered.add(slot)
        days[day] = covered
    return days


def hot_coverage(hot: Path) -> dict[date, set[int]]:
    """Days still only in SQLite -- today, and anything not yet compacted."""
    if not hot.exists():
        return {}
    conn = sqlite3.connect(f"file:{hot}?mode=ro", uri=True)
    days: dict[date, set[int]] = {}
    rows = conn.execute(
        "SELECT DISTINCT date(data_ts,'unixepoch','+8 hours'),"
        "       (data_ts + 28800) % 86400 / 300 FROM observations"
    )
    for day_text, slot in rows:
        days.setdefault(date.fromisoformat(day_text), set()).add(int(slot))
    return days


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cold", default="data/cold")
    parser.add_argument("--hot", default="data/hot.sqlite")
    args = parser.parse_args()

    cold = cold_coverage(ROOT / args.cold)
    hot = hot_coverage(ROOT / args.hot)
    # A day is whichever source has more of it: the hot store is a rolling
    # window and holds only part of an old day, while a compacted day is whole.
    days: dict[date, set[int]] = dict(cold)
    for day, slots in hot.items():
        if len(slots) > len(days.get(day, set())):
            days[day] = slots
    if not days:
        raise SystemExit("no corpus found -- nothing in the cold store or the hot one")

    # Calendar days with no file and no rows are the most important ones to show,
    # because they are the only kind of gap that leaves no trace to count.
    span = [min(days) + timedelta(days=i) for i in range((max(days) - min(days)).days + 1)]

    print(f"CORPUS COVERAGE  {min(days)} .. {max(days)}   "
          f"({len(span)} calendar days, Taipei)\n")
    print(f"{'day':12s} {'slots':>9s}  {'':4s} 00:00{'':<19s}12:00{'':<17s}24:00")
    per_cell = Counter()
    total = 0
    for day in span:
        covered = days.get(day, set())
        total += len(covered)
        for i, ch in enumerate(strip(covered)):
            if ch != ".":
                per_cell[i] += 1
        flag = "  <- no data at all" if not covered else ""
        print(f"{day.isoformat():12s} {len(covered):4d}/{SLOTS_PER_DAY} "
              f"{len(covered)/SLOTS_PER_DAY:5.0%}  {strip(covered)}{flag}")

    possible = len(span) * SLOTS_PER_DAY
    print(f"\noverall: {total:,} of {possible:,} five-minute slots = {total/possible:.1%}")
    print("  # = the whole half-hour, + = part of it, . = nothing collected\n")

    # The shape of the gaps is the part Plan 4 has to report, so name the worst.
    worst = sorted(range(SLOTS_PER_DAY // SLOTS_PER_CELL), key=lambda i: per_cell[i])[:6]
    print(f"thinnest half-hours across the whole corpus (of {len(span)} days):")
    for cell in sorted(worst):
        hh, mm = divmod(cell * MINUTES_PER_CELL, 60)
        print(f"  {hh:02d}:{mm:02d}  collected on {per_cell[cell]} of {len(span)} days")
    print("\nThese are time-correlated, not random: the same clock hours are thin in")
    print("every week of climatology at once. Plan 4 must report per-bucket support.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
