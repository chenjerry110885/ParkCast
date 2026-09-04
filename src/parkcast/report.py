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
    missing_pct: float
    clamped: int
    frozen_lots: tuple[str, ...]


def find_frozen_lots(conn, day: date, *, min_run: int = 72) -> list[str]:
    """Lots whose value never changed across at least `min_run` observations.

    72 slots is six hours. A lot that never moves for six hours is far more
    likely to have a broken sensor than to be genuinely static, and undetected
    it becomes a confidently wrong prediction.
    """
    start, end = day_bounds(day)
    rows = conn.execute(
        """
        SELECT lot_id, COUNT(*) AS n, COUNT(DISTINCT free_car) AS distinct_values
        FROM observations
        WHERE data_ts >= ? AND data_ts < ? AND free_car IS NOT NULL
        GROUP BY lot_id
        """,
        (start, end),
    ).fetchall()
    return [lot_id for lot_id, n, distinct in rows if n >= min_run and distinct == 1]


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
        f"  missing    {report.missing_pct:.2f}% of readings",
        f"  clamped    {report.clamped}",
        f"  frozen     {len(report.frozen_lots)} lots",
    ])
