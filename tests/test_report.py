# tests/test_report.py
from datetime import date

import pytest

from parkcast import ids, store
from parkcast.compact import day_bounds
from parkcast.feed import TS_FEED, TS_FETCH, TS_RECORD, FeedSnapshot, Observation
from parkcast.report import STALE_AFTER_SEC, build_report, find_frozen_lots, format_report


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def write(conn, slot, lot="A", free=10):
    """Taipei only, bare (unnamespaced) lot ids -- the original fixture.

    Left exactly as it was: `ids.city_of_stored` falls a bare id back to
    `taipei` (its `LEGACY_CITY`), which happens to be the same city this
    helper always writes under, so every pre-existing test below keeps
    working unchanged against the now-per-city coverage.
    """
    start, _ = day_bounds(date(2026, 9, 4))
    ts = start + slot * 300
    store.insert_snapshot(conn, FeedSnapshot("taipei", ts + 200, (Observation(lot, free, None, ts, TS_FEED),)), {lot: 50})


def write_city(conn, slot, city, lot="A", free=10, ts_kind=TS_FEED, data_ts=None):
    """Like `write`, but for any city, with a properly namespaced lot id.

    `data_ts` lets a caller stamp a per-record city's own, per-lot clock
    (rather than the tick-aligned `start + slot * 300` every tick-stamped
    city uses) -- the whole reason per-record cities need a test helper of
    their own.
    """
    start, _ = day_bounds(date(2026, 9, 4))
    ts = data_ts if data_ts is not None else start + slot * 300
    lot_id = ids.qualify(city, lot)
    store.insert_snapshot(
        conn,
        FeedSnapshot(city, start + slot * 300 + 200, (Observation(lot_id, free, None, ts, ts_kind),)),
        {lot_id: 50},
    )


def test_counts_ticks_and_reports_gaps(conn):
    for slot in (0, 1, 2):
        write(conn, slot)
    report = build_report(conn, date(2026, 9, 4))
    cov = report.coverage["taipei"]
    assert cov.tick_based
    assert cov.ticks_seen == 3
    assert cov.ticks_expected == 288
    assert report.lots_seen == 1


def test_a_lot_missing_from_some_ticks_is_counted_as_incomplete(conn):
    """Per-lot coverage (spec section 10) is what makes a truncated tick visible.

    The citywide counters cannot see one: when a batch wrote 965 of 1177 lots,
    every lot and every data_ts was still observed by *someone*, so lots_seen
    and ticks_seen both looked perfect. Counting lots short of the day's tick
    total is the only citywide number that moves.
    """
    for slot in (0, 1, 2):
        write(conn, slot, lot="COMPLETE")
    for slot in (0, 1):
        write(conn, slot, lot="TRUNCATED")

    report = build_report(conn, date(2026, 9, 4))
    cov = report.coverage["taipei"]
    assert cov.ticks_seen == 3
    assert report.lots_seen == 2, "the citywide counters see nothing wrong"
    assert cov.lots_with_gaps == 1


def test_no_lot_is_incomplete_when_every_tick_is_whole(conn):
    for slot in (0, 1, 2):
        for lot in ("A", "B"):
            write(conn, slot, lot=lot)
    assert build_report(conn, date(2026, 9, 4)).coverage["taipei"].lots_with_gaps == 0


def test_missing_percentage_counts_nulls(conn):
    write(conn, 0, free=10)
    write(conn, 1, free=None)
    report = build_report(conn, date(2026, 9, 4))
    assert report.missing_pct == pytest.approx(50.0)


def test_frozen_lot_detected_after_long_unchanged_run(conn):
    for slot in range(80):
        write(conn, slot, lot="STUCK", free=7)
    for slot in range(80):
        write(conn, slot, lot="FINE", free=slot)
    frozen = find_frozen_lots(conn, date(2026, 9, 4), min_run=72)
    assert "STUCK" in frozen
    assert "FINE" not in frozen


def test_sensor_that_seizes_mid_day_is_detected(conn):
    """The realistic failure: works, then freezes. Earlier variation must not hide it."""
    for slot in range(100):
        write(conn, slot, lot="SEIZED", free=slot)
    for slot in range(100, 200):
        write(conn, slot, lot="SEIZED", free=7)
    assert "SEIZED" in find_frozen_lots(conn, date(2026, 9, 4), min_run=72)


def test_sensor_frozen_early_then_recovering_is_detected(conn):
    """Mirror case: a long frozen run followed by normal variation."""
    for slot in range(100):
        write(conn, slot, lot="RECOVERED", free=7)
    for slot in range(100, 200):
        write(conn, slot, lot="RECOVERED", free=slot)
    assert "RECOVERED" in find_frozen_lots(conn, date(2026, 9, 4), min_run=72)


def test_a_run_just_under_the_threshold_is_not_flagged(conn):
    """Pins the boundary: 71 identical readings is not yet suspicious, 72 is."""
    for slot in range(71):
        write(conn, slot, lot="ALMOST", free=7)
    assert find_frozen_lots(conn, date(2026, 9, 4), min_run=72) == []
    write(conn, 71, lot="ALMOST", free=7)
    assert find_frozen_lots(conn, date(2026, 9, 4), min_run=72) == ["ALMOST"]


def test_short_unchanged_run_is_not_frozen(conn):
    """A genuinely quiet lot overnight should not be flagged."""
    for slot in range(20):
        write(conn, slot, lot="QUIET", free=7)
    assert find_frozen_lots(conn, date(2026, 9, 4), min_run=72) == []


def test_format_report_is_human_readable(conn):
    write(conn, 0)
    text = format_report(build_report(conn, date(2026, 9, 4)))
    assert "2026-09-04" in text
    assert "ticks" in text.lower()


def test_format_report_surfaces_incomplete_lots(conn):
    """A number computed but never printed is a number nobody acts on."""
    for slot in (0, 1, 2):
        write(conn, slot, lot="COMPLETE")
    write(conn, 0, lot="TRUNCATED")

    text = format_report(build_report(conn, date(2026, 9, 4)))
    assert "incomplete" in text.lower()
    assert "1" in text.split("incomplete")[1].splitlines()[0]


# --- Job 2: coverage rescoped per city ---

def test_a_truncated_tick_in_one_city_does_not_drown_in_another_citys_ticks(conn):
    """The regression a Task 10 review found: one global `ticks_seen` mixing
    every city's data_ts together makes a real gap invisible next to a
    healthy city's own count, and (worse, for a per-record city) makes
    nearly EVERY lot in EVERY city look gapped. Each city must be measured
    against only its own tick count.
    """
    # Taipei: three whole ticks, one lot truncated after two.
    for slot in (0, 1, 2):
        write_city(conn, slot, "taipei", lot="COMPLETE")
    for slot in (0, 1):
        write_city(conn, slot, "taipei", lot="TRUNCATED")
    # Kaohsiung: healthy, all three ticks, every lot present -- its own
    # tick count must stay 3, not be inflated by Taipei's or drowned by it.
    for slot in (0, 1, 2):
        write_city(conn, slot, "kaohsiung", lot="X", ts_kind=TS_FETCH)

    report = build_report(conn, date(2026, 9, 4))
    taipei = report.coverage["taipei"]
    kaohsiung = report.coverage["kaohsiung"]

    assert taipei.ticks_seen == 3
    assert taipei.lots_with_gaps == 1, "Taipei's own truncated lot must still show up"
    assert kaohsiung.ticks_seen == 3
    assert kaohsiung.lots_with_gaps == 0, "a healthy city must not inherit another city's gap"


def test_per_record_city_reports_no_tick_count(conn):
    """New Taipei stamps `data_ts` per record (`TS_RECORD`): each lot's own
    clock, not the collector's. Distinct `data_ts` there is not a tick
    count, so it must not be reported as one -- `ticks_seen`,
    `ticks_expected` and `lots_with_gaps` must come back `None` rather than
    a number that looks like the tick-based ones but means something else.
    """
    start, _ = day_bounds(date(2026, 9, 4))
    # Three lots, each stamping its own distinct data_ts across three polls
    # -- nine distinct data_ts in total for a city with three polls, which
    # is exactly the shape that used to make `lots_with_gaps` explode.
    for lot_idx, lot in enumerate(("A", "B", "C")):
        for poll in (0, 1, 2):
            write_city(
                conn, poll, "newtaipei", lot=lot, ts_kind=TS_RECORD,
                data_ts=start + poll * 300 + lot_idx,
            )

    cov = build_report(conn, date(2026, 9, 4)).coverage["newtaipei"]
    assert cov.tick_based is False
    assert cov.ticks_seen is None
    assert cov.ticks_expected is None
    assert cov.lots_with_gaps is None
    assert cov.rows == 9
    assert cov.lots_seen == 3


def test_per_record_citys_data_ts_explosion_does_not_pollute_other_cities(conn):
    """The exact Task 10 regression: a per-record city's data_ts cardinality
    must never leak into another city's tick count or gap count.
    """
    start, _ = day_bounds(date(2026, 9, 4))
    # Taipei: two whole, healthy ticks.
    for slot in (0, 1):
        write_city(conn, slot, "taipei", lot="A")
    # New Taipei: 50 lots, each with its own distinct data_ts on one poll --
    # 50 distinct data_ts values in a store where Taipei only ever produced 2.
    for i in range(50):
        write_city(
            conn, 0, "newtaipei", lot=f"L{i}", ts_kind=TS_RECORD,
            data_ts=start + i,
        )

    taipei = build_report(conn, date(2026, 9, 4)).coverage["taipei"]
    assert taipei.ticks_seen == 2, "New Taipei's 50 distinct stamps must not inflate Taipei's own tick count"
    assert taipei.lots_with_gaps == 0


def test_polls_seen_counts_collector_fetches_not_feed_stamps(conn):
    """`polls_seen` is `COUNT(DISTINCT observed_at)` -- the collector's own
    clock -- and must track how many times we asked, not how many distinct
    per-record stamps the feed happened to carry.
    """
    start, _ = day_bounds(date(2026, 9, 4))
    for poll in (0, 1, 2):
        write_city(conn, poll, "tainan", lot="A", ts_kind=TS_RECORD, data_ts=start + poll * 300)
        write_city(conn, poll, "tainan", lot="B", ts_kind=TS_RECORD, data_ts=start + poll * 300 + 1)

    cov = build_report(conn, date(2026, 9, 4)).coverage["tainan"]
    assert cov.polls_seen == 3


def test_report_never_raises_on_a_pre_migration_legacy_row(conn):
    """A row that predates the `city` column (`city = ''`, see
    `store.migrate_to_namespaced_ids`) must be grouped by `ids.city_of_stored`
    -- which falls back to `taipei` rather than raising -- not by the strict
    `ids.city_of`, which would take the whole report down over one old row.
    """
    start, _ = day_bounds(date(2026, 9, 4))
    conn.execute(
        "INSERT INTO observations (lot_id, city, data_ts, observed_at, free_car, free_motor, quality)"
        " VALUES ('TPE0001', '', ?, ?, 5, NULL, 0)",
        (start, start),
    )
    report = build_report(conn, date(2026, 9, 4))  # must not raise
    assert report.coverage["taipei"].rows == 1


def test_format_report_shows_per_record_cities_as_not_applicable(conn):
    write_city(conn, 0, "newtaipei", lot="A", ts_kind=TS_RECORD)
    text = format_report(build_report(conn, date(2026, 9, 4)))
    line = next(l for l in text.splitlines() if "newtaipei" in l)
    assert "n/a" in line
    assert "per-record" in line


# --- Job 1: a line per source ---

def test_sources_dict_is_filled_from_store_source_health(conn):
    store.record_source_health(conn, "taipei", observed_at=1000, rows=300, usable=295, newest_ts=1000, ok=True)
    report = build_report(conn, date(2026, 9, 4))
    assert report.sources["taipei"] == {
        "first_ts": 1000, "last_ts": 1000, "rows": 300, "usable": 295, "ok": True,
    }


def test_format_report_prints_a_line_per_source(conn):
    store.record_source_health(conn, "taipei", observed_at=1000, rows=300, usable=295, newest_ts=1000, ok=True)
    store.record_source_health(conn, "kaohsiung", observed_at=1000, rows=200, usable=198, newest_ts=1000, ok=True)
    text = format_report(build_report(conn, date(2026, 9, 4)), now=1000)
    assert "taipei" in text
    assert "kaohsiung" in text
    assert "295" in text and "300" in text


def test_source_with_full_payload_and_zero_usable_counts_is_flagged(conn):
    """The failure this line exists to catch: HTTP 200, a full payload, and
    not one usable count in it. Silence there would read as health.
    """
    store.record_source_health(conn, "hsinchu", observed_at=1000, rows=55, usable=0, newest_ts=1000, ok=True)
    text = format_report(build_report(conn, date(2026, 9, 4)), now=1000)
    line = next(l for l in text.splitlines() if "hsinchu" in l)
    assert "NO USABLE COUNTS" in line


def test_source_that_failed_to_fetch_is_marked_failed(conn):
    store.record_source_health(conn, "taoyuan", observed_at=1000, rows=0, usable=0, newest_ts=None, ok=False)
    text = format_report(build_report(conn, date(2026, 9, 4)), now=1000)
    line = next(l for l in text.splitlines() if "taoyuan" in l)
    assert "FAILED" in line


def test_a_frozen_feed_polled_successfully_right_now_is_marked_stale(conn):
    """The production shape, and the one this line exists for.

    The previous version of this test back-dated `observed_at` -- it recorded a
    poll from an hour ago, which the collector never does: it records every
    poll at the moment it happens. With `observed_at` and `newest_ts` written
    into each other's columns, `last_ts` held the poll time, its age was ~0 on
    every successful tick, and STALE was unreachable for any city being polled
    at all. A week-old payload with half its counts usable printed `ok`.

    So: polled NOW, successfully, 268 of 268 counts usable -- and answering
    with data stamped two hours ago. Everything about the fetch looks healthy;
    only the feed's own clock says otherwise.
    """
    now = 1_788_485_010
    store.record_source_health(conn, "tainan", observed_at=now, rows=268, usable=268,
                               newest_ts=now - 2 * 3600, ok=True)
    text = format_report(build_report(conn, date(2026, 9, 4)), now=now)
    line = next(l for l in text.splitlines() if "tainan" in l)
    assert "STALE" in line, (
        "a successful poll of a frozen feed is exactly what this must catch"
    )
    assert "120 min" in line, "and it must say how stale the DATA is, not the poll"


def test_source_that_is_healthy_and_fresh_is_marked_ok(conn):
    now = 1000
    store.record_source_health(conn, "taipei", observed_at=now, rows=300, usable=295, newest_ts=now, ok=True)
    text = format_report(build_report(conn, date(2026, 9, 4)), now=now)
    line = next(l for l in text.splitlines() if "taipei" in l and "rows usable" in l)
    assert line.rstrip().endswith("ok")
