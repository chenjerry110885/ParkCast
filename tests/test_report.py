# tests/test_report.py
from datetime import date

import pytest

from parkcast import store
from parkcast.compact import day_bounds
from parkcast.feed import FeedSnapshot, Observation
from parkcast.report import build_report, find_frozen_lots, format_report


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def write(conn, slot, lot="A", free=10):
    start, _ = day_bounds(date(2026, 9, 4))
    ts = start + slot * 300
    store.insert_snapshot(conn, FeedSnapshot(ts, ts + 200, (Observation(lot, free, None),)), {lot: 50})


def test_counts_ticks_and_reports_gaps(conn):
    for slot in (0, 1, 2):
        write(conn, slot)
    report = build_report(conn, date(2026, 9, 4))
    assert report.ticks_seen == 3
    assert report.ticks_expected == 288
    assert report.lots_seen == 1


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
