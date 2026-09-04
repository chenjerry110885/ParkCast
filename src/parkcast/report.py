"""Daily data-quality summary: coverage, gaps, and suspect sensors."""
from dataclasses import dataclass
from datetime import date

from parkcast.compact import SLOTS_PER_DAY, day_bounds
from parkcast.quality import Q


@dataclass(frozen=True, slots=True)
class DayReport:
    day: date
    ticks_seen: int
    ticks_expected: int
    lots_seen: int
    lots_with_gaps: int
    missing_pct: float
    clamped: int
    frozen_lots: tuple[str, ...]


def find_frozen_lots(conn, day: date, *, min_run: int = 72) -> list[str]:
    """Lots with a RUN of at least `min_run` consecutive identical observations.

    Runs are counted in consecutive OBSERVATIONS, not consecutive slots, so a
    run bridges anything that left no row: a collection outage, and also any
    MISSING reading, since the `free_car IS NOT NULL` filter removes those
    before the rows are ranked. 36 identical readings, a nine-hour gap, then 36
    more identical readings is therefore reported as one run of 72.

    72 observations is six hours at the 5-minute cadence. A lot that never moves
    for six hours is far more likely to have a broken sensor than to be genuinely
    static, and undetected it becomes a confidently wrong prediction.

    The run matters, not the whole day: the realistic failure is a sensor that
    works, then seizes. Asking merely "was this lot constant all day" misses that
    entirely, because the earlier varying readings hide the later frozen ones.
    """
    start, end = day_bounds(day)
    # Gap-and-islands: the difference between a row's overall rank and its rank
    # within its own value is constant exactly across a run of identical values,
    # so grouping on it yields one group per run.
    rows = conn.execute(
        """
        WITH ordered AS (
            SELECT lot_id, free_car,
                   ROW_NUMBER() OVER (PARTITION BY lot_id ORDER BY data_ts) -
                   ROW_NUMBER() OVER (PARTITION BY lot_id, free_car ORDER BY data_ts) AS island
            FROM observations
            WHERE data_ts >= ? AND data_ts < ? AND free_car IS NOT NULL
        ),
        runs AS (
            SELECT lot_id, COUNT(*) AS run_len
            FROM ordered
            GROUP BY lot_id, free_car, island
        )
        SELECT lot_id FROM runs GROUP BY lot_id HAVING MAX(run_len) >= ?
        """,
        (start, end, min_run),
    ).fetchall()
    return [lot_id for (lot_id,) in rows]


def build_report(conn, day: date) -> DayReport:
    start, end = day_bounds(day)
    window = (start, end)

    ticks_seen = conn.execute(
        "SELECT COUNT(DISTINCT data_ts) FROM observations WHERE data_ts >= ? AND data_ts < ?",
        window,
    ).fetchone()[0]
    lots_seen = conn.execute(
        "SELECT COUNT(DISTINCT lot_id) FROM observations WHERE data_ts >= ? AND data_ts < ?",
        window,
    ).fetchone()[0]
    # Per-lot coverage (spec section 10). Citywide counts hide a truncated
    # tick entirely: a batch that wrote 965 of 1177 lots still reports
    # "lots 1177" and a full tick count, because every lot and every data_ts
    # was seen by *someone*. Counting lots short of the day's tick total is
    # what makes the hole visible.
    lots_with_gaps = conn.execute(
        """
        SELECT COUNT(*) FROM (
            SELECT lot_id FROM observations
            WHERE data_ts >= ? AND data_ts < ?
            GROUP BY lot_id HAVING COUNT(*) < ?
        )
        """,
        (start, end, ticks_seen),
    ).fetchone()[0]
    total, missing, clamped = conn.execute(
        """
        SELECT COUNT(*),
               SUM(CASE WHEN free_car IS NULL THEN 1 ELSE 0 END),
               SUM(CASE WHEN quality & ? THEN 1 ELSE 0 END)
        FROM observations WHERE data_ts >= ? AND data_ts < ?
        """,
        (int(Q.CLAMPED), start, end),
    ).fetchone()

    return DayReport(
        day=day,
        ticks_seen=ticks_seen,
        ticks_expected=SLOTS_PER_DAY,
        lots_seen=lots_seen,
        lots_with_gaps=lots_with_gaps,
        missing_pct=(100.0 * (missing or 0) / total) if total else 0.0,
        clamped=clamped or 0,
        frozen_lots=tuple(find_frozen_lots(conn, day)),
    )


def format_report(report: DayReport) -> str:
    coverage = 100.0 * report.ticks_seen / report.ticks_expected
    return "\n".join([
        f"ParkCast data quality — {report.day.isoformat()}",
        f"  ticks      {report.ticks_seen}/{report.ticks_expected} ({coverage:.1f}% coverage)",
        f"  lots       {report.lots_seen}",
        f"  incomplete {report.lots_with_gaps} lots missed at least one tick",
        f"  missing    {report.missing_pct:.2f}% of readings",
        f"  clamped    {report.clamped}",
        f"  frozen     {len(report.frozen_lots)} lots",
    ])
