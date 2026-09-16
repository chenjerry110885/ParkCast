"""Daily data-quality summary: coverage, gaps, and suspect sensors."""
import time
from dataclasses import dataclass
from datetime import date

from parkcast import ids, store
from parkcast.compact import SLOTS_PER_DAY, day_bounds
from parkcast.quality import Q

STALE_AFTER_SEC = 3600

# A city's whole tick shares one data_ts: Taipei stamps its own feed-wide
# UPDATETIME once per payload (`feed.TS_FEED`); Kaohsiung and Taoyuan carry no
# timestamp in their feed at all and take `data_ts=now` for every row of one
# fetch (`feed.TS_FETCH` -- see each adapter's own module docstring, and
# scheduler.run_forever's stall-counting comment, which leans on the same
# fact). Either way, one collector fetch produces exactly one data_ts for the
# whole city, so `COUNT(DISTINCT data_ts)` is a tick count in the sense
# `SLOTS_PER_DAY` assumes, and a lot short of it is a lot a tick actually
# missed -- see `_city_coverage`.
#
# New Taipei, Tainan and Hsinchu stamp `data_ts` per RECORD (`feed.TS_RECORD`):
# each lot carries its own last-update clock, independent of every other
# lot's and of when we asked. Distinct `data_ts` there counts lots'
# unsynchronised update cadences, not ticks -- on a busy day it can run into
# the tens of thousands while `ticks_expected` stays 288. `ts_kind` is never
# persisted (see `feed.Observation`), so which convention produced a row has
# to be known here, statically, from the adapters themselves -- there is
# nothing in the stored row that says it. See `CityCoverage` for what stands
# in for these three cities instead, and what it can and cannot show.
TICK_STAMPED_CITIES = frozenset({"taipei", "kaohsiung", "taoyuan"})


@dataclass(frozen=True, slots=True)
class CityCoverage:
    """One city's coverage for the day -- see `TICK_STAMPED_CITIES`.

    `ticks_seen`, `ticks_expected` and `lots_with_gaps` are populated only
    for a tick-stamped city. For a per-record city (New Taipei, Tainan,
    Hsinchu) they are `None`: there is no tick to count there, or to measure
    a lot short of, and printing a number in their place would look like the
    old, meaningful one while measuring something else entirely -- exactly
    what this rescoping exists to stop.

    `polls_seen` -- `COUNT(DISTINCT observed_at)`, the collector's own clock,
    stamped once per fetch regardless of what the feed says -- stands in for
    those three cities: genuine evidence the collector kept asking, on a
    footing every city shares. It is NOT a per-lot coverage check, and
    `lots_with_gaps` is deliberately not computed against it: `observed_at`
    is only ever recorded on a row's first sighting (`insert_snapshot`'s
    primary key is `(lot_id, data_ts)`, so a re-fetch that repeats a lot's
    still-unchanged record stamp writes nothing new), so a lot that is
    genuinely healthy but merely slow to change and a lot a tick actually
    missed both show up as "row count well below `polls_seen`" -- this
    measure cannot tell those two apart, so it does not try to.
    """
    rows: int
    lots_seen: int
    tick_based: bool
    ticks_seen: int | None
    ticks_expected: int | None
    lots_with_gaps: int | None
    polls_seen: int


@dataclass(frozen=True, slots=True)
class DayReport:
    day: date
    lots_seen: int
    missing_pct: float
    clamped: int
    frozen_lots: tuple[str, ...]
    coverage: dict[str, CityCoverage]
    sources: dict[str, dict]


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


def _city_coverage(conn, start: int, end: int) -> dict[str, CityCoverage]:
    """Per-city coverage, grouped by `ids.city_of_stored` rather than the
    stored `city` column.

    Every writer sets a row's `city` column from the same value its `lot_id`
    is namespaced with, so the two should never disagree -- but a
    pre-migration row (`city = ''`, see `store.migrate_to_namespaced_ids`) is
    exactly the shape `city_of_stored` exists to fall back on (as
    `LEGACY_CITY`) instead of raising. The report is a diagnostic and must
    never be the thing that takes the process down, so it groups on the total
    function rather than trusting the column, even though today's writers
    never actually disagree with it.
    """
    # A Python UDF, not the `city` column, is what `GROUP BY` and the
    # per-city `WHERE` below key on -- see the docstring above for why.
    conn.create_function("city_of_stored", 1, ids.city_of_stored)

    rows = conn.execute(
        """
        SELECT city_of_stored(lot_id) AS city,
               COUNT(*),
               COUNT(DISTINCT lot_id),
               COUNT(DISTINCT data_ts),
               COUNT(DISTINCT observed_at)
        FROM observations
        WHERE data_ts >= ? AND data_ts < ?
        GROUP BY city
        """,
        (start, end),
    ).fetchall()

    coverage: dict[str, CityCoverage] = {}
    for city, row_count, lots_seen, ticks_seen_raw, polls_seen in rows:
        tick_based = city in TICK_STAMPED_CITIES
        ticks_seen = ticks_expected = lots_with_gaps = None
        if tick_based:
            ticks_seen = ticks_seen_raw
            ticks_expected = SLOTS_PER_DAY
            # Per-lot coverage (spec section 10), now scoped to THIS city's
            # own tick count instead of measured against every city's
            # data_ts lumped together. Citywide counts hide a truncated
            # tick: a batch that wrote 965 of a city's 1177 lots still shows
            # a full lot count and a full tick count for that city, because
            # every lot and every data_ts was seen by *someone*. Counting
            # lots short of THIS city's own tick total is what makes the
            # hole visible -- and, just as importantly now that six cities
            # share one store, comparing each city only to itself is what
            # keeps a genuine gap in one city from being drowned by a
            # healthy city's own full count or swamped by another city's
            # (per-record, unrelated) tick figure.
            lots_with_gaps = conn.execute(
                """
                SELECT COUNT(*) FROM (
                    SELECT lot_id FROM observations
                    WHERE data_ts >= ? AND data_ts < ?
                      AND city_of_stored(lot_id) = ?
                    GROUP BY lot_id HAVING COUNT(*) < ?
                )
                """,
                (start, end, city, ticks_seen),
            ).fetchone()[0]
        coverage[city] = CityCoverage(
            rows=row_count,
            lots_seen=lots_seen,
            tick_based=tick_based,
            ticks_seen=ticks_seen,
            ticks_expected=ticks_expected,
            lots_with_gaps=lots_with_gaps,
            polls_seen=polls_seen,
        )
    return coverage


def build_report(conn, day: date) -> DayReport:
    start, end = day_bounds(day)
    window = (start, end)

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
        lots_seen=lots_seen,
        missing_pct=(100.0 * (missing or 0) / total) if total else 0.0,
        clamped=clamped or 0,
        frozen_lots=tuple(find_frozen_lots(conn, day)),
        coverage=_city_coverage(conn, start, end),
        sources=store.source_health(conn),
    )


def _coverage_line(city: str, cov: CityCoverage) -> str:
    if cov.tick_based:
        pct = 100.0 * cov.ticks_seen / cov.ticks_expected if cov.ticks_expected else 0.0
        return (
            f"  ticks      {city:<12} {cov.ticks_seen}/{cov.ticks_expected} "
            f"({pct:.1f}% coverage) -- incomplete: {cov.lots_with_gaps} "
            f"lots missed at least one tick"
        )
    # Per-record city: no tick to count. Said explicitly, with the honest
    # substitute (collector polls) rather than a number that looks like the
    # tick-based line above but measures something else -- see CityCoverage.
    return (
        f"  ticks      {city:<12} n/a (per-record stamps) -- "
        f"{cov.polls_seen} collector polls seen; per-lot gaps not measured"
    )


def _source_line(city: str, health: dict, *, now: int) -> str:
    """One city's health line.

    `last_ts` is the newest DATA timestamp the city has ever answered with, not
    when we last polled it -- see `store.record_source_health`, where the two
    used to be written into each other's columns. Ageing it against `now` is
    therefore a real staleness measure for the four cities whose feeds carry a
    timestamp at all.

    IT IS NOT ONE FOR KAOHSIUNG OR TAOYUAN. Their feeds carry no timestamp, so
    their adapters stamp `data_ts = now` (`feed.TS_FETCH`); `last_ts` is then
    always the moment of the last successful fetch and the age is always ~0.
    Those two cities have NO staleness signal available at any layer -- a
    payload frozen for a week and a live one are byte-identical in every field
    this table records. Closing that would need something outside the feed:
    either the feed itself learning to stamp its records, or a content hash per
    fetch (an unchanged payload hash over N consecutive polls is evidence a
    per-row timestamp would have given directly). `ok=False` on an outright
    failure remains the only thing their line can honestly report.
    """
    rows, usable = health["rows"], health["usable"]
    age_min = (now - health["last_ts"]) // 60 if health["last_ts"] else None
    if not health["ok"]:
        note = "FAILED"
    elif rows and not usable:
        # The failure this line exists to catch: HTTP 200, a full payload, and
        # not one usable count in it. Silence would read as health.
        note = "NO USABLE COUNTS"
    elif age_min is not None and age_min * 60 > STALE_AFTER_SEC:
        note = f"STALE ({age_min} min)"
    else:
        note = "ok"
    return f"  {city:<12} {usable:>5}/{rows:<5} rows usable   {note}"


def format_report(report: DayReport, *, now: int | None = None) -> str:
    if now is None:
        now = int(time.time())
    lines = [f"ParkCast data quality — {report.day.isoformat()}"]
    for city in sorted(report.coverage):
        lines.append(_coverage_line(city, report.coverage[city]))
    lines += [
        f"  lots       {report.lots_seen}",
        f"  missing    {report.missing_pct:.2f}% of readings",
        f"  clamped    {report.clamped}",
        f"  frozen     {len(report.frozen_lots)} lots",
        "  sources:",
    ]
    for city in sorted(report.sources):
        lines.append(_source_line(city, report.sources[city], now=now))
    return "\n".join(lines)
