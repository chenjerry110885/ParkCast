"""Which day of the week does a public holiday most resemble?

    python scripts/holiday-prior.py --city taipei

The climatology's holiday cells shrink toward one day of the clock week
(`config.HOLIDAY_PRIOR_SLOT`) at the same half-hour, because a lot sees about
22 holidays a year and its holiday cells stay thin for a long time. Which day
that should be is a measurement, not a guess:

For every holiday the corpus holds, a climatology is built from everything
strictly BEFORE that day -- holidays already sit in their own slot, so the
clock buckets it reads are clean -- and each observation on the holiday is
predicted from the same half-hour of each of the seven days in turn. The day
with the lowest pooled Brier score is the one a holiday most resembles.

Read the n before the answer. The corpus began on 2026-09-04, so it holds a
handful of holidays; this is the best available measurement, not a settled one,
and it should be re-run once a year of holidays has accumulated.

Runs inside the collector image with the cold corpus mounted read-only. It
reads the cold Parquet only (an empty in-memory hot store), and writes nothing.
"""
import argparse
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from parkcast import config, holidays, ids, store  # noqa: E402
from parkcast.evaluate import load_labels  # noqa: E402
from parkcast.forecast import Climatology, by_city, load_history  # noqa: E402

#: Slot 0 is THURSDAY: bucket 0 is Thursday 00:00 Taipei (1970-01-01 was one).
SLOT_NAMES = ("Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed")

Scores = dict[int, tuple[float, int]]   # slot -> (Brier sum, observations)


def _half_hour(ts: int) -> int:
    return ((ts + 8 * 3600) // 60 // config.CLIMATOLOGY_BUCKET_MIN) % config.BUCKETS_PER_DAY


def score_slots(clim: Climatology, observations: list[tuple[str, int, int]]) -> Scores:
    """Brier sum and count per day slot, predicting each `(lot, ts, free)` from
    that slot's cell at the observation's own half-hour."""
    scores = {slot: [0.0, 0] for slot in range(7)}
    for lot_id, ts, free in observations:
        outcome = 1.0 if free >= 1 else 0.0
        half_hour = _half_hour(ts)
        for slot in range(7):
            p = clim.predict_bucket(lot_id, slot * config.BUCKETS_PER_DAY + half_hour)
            if p is None:
                continue
            scores[slot][0] += (p - outcome) ** 2
            scores[slot][1] += 1
    return {slot: (total, n) for slot, (total, n) in scores.items()}


def pool(per_holiday: dict) -> Scores:
    """Sum every holiday's scores, so each counts by its observations."""
    pooled: dict[int, list] = {}
    for scores in per_holiday.values():
        for slot, (total, n) in scores.items():
            acc = pooled.setdefault(slot, [0.0, 0])
            acc[0] += total
            acc[1] += n
    return {slot: (total, n) for slot, (total, n) in pooled.items()}


def winner(pooled: Scores) -> int:
    return min((s for s in pooled if pooled[s][1]), key=lambda s: pooled[s][0] / pooled[s][1])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--city", default=ids.LEGACY_CITY)
    ap.add_argument("--cold", default=str(config.PARQUET_DIR))
    args = ap.parse_args(argv)

    conn = store.connect_empty()     # cold only: no hot store to lock or read
    cold = Path(args.cold)
    labels = load_labels(conn, cold, city=args.city)
    days: dict[date, list[tuple[str, int, int]]] = {}
    for ts, readings in labels.items():
        day = holidays.taipei_date(ts)
        if holidays.is_holiday(day):
            days.setdefault(day, []).extend((lot, ts, free) for lot, free in readings.items())
    if not days:
        print("the corpus holds no holidays yet")
        return 1

    per_holiday: dict[date, Scores] = {}
    for day in sorted(days):
        start = int(datetime(day.year, day.month, day.day, tzinfo=config.TAIPEI_TZ).timestamp())
        history = by_city(load_history(conn, cold_dir=cold, before_ts=start)).get(args.city)
        if history is None:
            continue
        per_holiday[day] = score_slots(Climatology(history), days[day])

    print(f"holiday prior -- {args.city}, {len(per_holiday)} holidays in the corpus\n")
    print(f"{'holiday':24s} {'own':>4s}  " + "  ".join(f"{s:>6s}" for s in SLOT_NAMES) + "      n")
    for day, scores in per_holiday.items():
        own = SLOT_NAMES[(day - date(1970, 1, 1)).days % 7]
        name = holidays.holiday_name(day)[1]
        cells = "  ".join(f"{scores[s][0] / scores[s][1]:6.4f}" if scores[s][1] else "     -"
                          for s in range(7))
        print(f"{day} {name[:13]:13s} {own:>4s}  {cells}  {scores[0][1]:6d}")
    pooled = pool(per_holiday)
    cells = "  ".join(f"{pooled[s][0] / pooled[s][1]:6.4f}" for s in range(7))
    print(f"{'pooled':24s} {'':>4s}  {cells}  {pooled[0][1]:6d}")
    best = winner(pooled)
    print(f"\nlowest pooled Brier: {SLOT_NAMES[best]} (slot {best}); "
          f"config.HOLIDAY_PRIOR_SLOT is {config.HOLIDAY_PRIOR_SLOT} "
          f"({SLOT_NAMES[config.HOLIDAY_PRIOR_SLOT]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
