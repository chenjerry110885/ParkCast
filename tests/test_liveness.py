"""Tests for the not-updating rule.

The failure this guards against has two faces and both are silent: a frozen lot
published as a confident 0% or 100%, and a live lot hidden behind "not
updating" because a collector outage looked like a frozen feed.
"""
import pytest

from parkcast import config, liveness, store
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.liveness import (Run, Withholding, last_update, not_updating,
                               unchanged_run, withheld_since)

HOUR = 3600
T = 1_789_000_080                      # a data_ts on the feed's phase
WINDOW = T - 48 * HOUR                 # a full hot window


def newest_first(values, *, end=T):
    """[(data_ts, value)], newest first, one reading per 5-minute slot."""
    return [(end - i * 300, v) for i, v in enumerate(values)]


def full_run(hours, value=7):
    """A run with a reading on every slot, ending at T."""
    return Run(newest_ts=T, since_ts=T - hours * HOUR, readings=hours * 12 + 1, value=value)


# --- the run ---------------------------------------------------------------


def test_the_run_ends_at_the_first_different_value():
    assert unchanged_run(newest_first([7, 7, 7, 3, 7])) == Run(T, T - 600, 3, 7)


def test_no_readings_is_no_run():
    assert unchanged_run([]) is None


def test_a_lot_that_just_changed_has_a_one_reading_run():
    run = unchanged_run(newest_first([4, 5, 5, 5]))
    assert (run.since_ts, run.readings) == (T, 1)


# --- when a lot last updated -----------------------------------------------


def test_a_well_covered_run_last_updated_when_it_began():
    assert last_update(full_run(30), window_start=WINDOW) == T - 30 * HOUR


def test_a_sparse_run_proves_nothing_beyond_its_newest_reading():
    # A 5 before a long collector outage and a 5 after it: 24 readings over 26 h.
    run = Run(newest_ts=T, since_ts=T - 26 * HOUR, readings=24, value=5)
    assert last_update(run, window_start=WINDOW) == T


def test_no_reading_in_the_window_last_updated_no_later_than_its_start():
    assert last_update(None, window_start=WINDOW) == WINDOW


# --- whether to withhold ---------------------------------------------------


def test_exactly_the_threshold_is_withheld():
    hours = config.NOT_UPDATING_AFTER_SEC // HOUR
    assert withheld_since(full_run(hours), as_of=T, window_start=WINDOW) == T - hours * HOUR


def test_one_slot_short_of_the_threshold_is_not():
    span = config.NOT_UPDATING_AFTER_SEC - 300
    run = Run(T, T - span, span // 300 + 1, 7)
    assert withheld_since(run, as_of=T, window_start=WINDOW) is None


def test_the_coverage_guard_stops_an_outage_looking_like_a_frozen_feed():
    run = Run(newest_ts=T, since_ts=T - 26 * HOUR, readings=24, value=5)
    assert withheld_since(run, as_of=T, window_start=WINDOW) is None


def test_a_lot_that_stopped_reporting_is_withheld_from_its_last_reading():
    # It changed often, then sent only -9 for 25 hours.
    last = T - 25 * HOUR
    run = Run(newest_ts=last, since_ts=last, readings=1, value=12)
    assert withheld_since(run, as_of=T, window_start=WINDOW) == last


def test_a_lot_silent_for_the_whole_window_needs_the_window_to_be_long_enough():
    assert withheld_since(None, as_of=T, window_start=T - 25 * HOUR) == T - 25 * HOUR
    # A store only an hour old cannot tell a silent lot from a new one.
    assert withheld_since(None, as_of=T, window_start=T - HOUR) is None


def test_full_empty_and_mid_value_are_all_the_same_failure():
    for value in (0, 34, 221):
        assert withheld_since(full_run(30, value), as_of=T, window_start=WINDOW) is not None


# --- against the store -----------------------------------------------------


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    # These fixtures write hundreds of ticks; durability is not under test.
    c.execute("PRAGMA synchronous=OFF")
    yield c
    c.close()


def write(conn, ts, readings):
    """One tick. `readings` is {lot_id: free_car or None}."""
    obs = tuple(Observation(lot, free, None, ts, TS_FEED) for lot, free in readings.items())
    store.insert_snapshot(conn, FeedSnapshot("taipei", ts + 200, obs), {lot: 50 for lot in readings})


def ticks(hours, *, end=T):
    """Every 5-minute data_ts from `hours` before `end` up to `end`, oldest first."""
    return [end - i * 300 for i in range(hours * 12, -1, -1)]


def test_not_updating_finds_the_frozen_lot_and_leaves_the_live_one(conn):
    for i, ts in enumerate(ticks(26)):
        write(conn, ts, {"FROZEN": 7, "LIVE": i % 5})
    assert not_updating(conn, ["FROZEN", "LIVE"], as_of=T) == {"FROZEN": T - 26 * HOUR}


def test_readings_after_as_of_are_ignored(conn):
    for ts in ticks(26):
        write(conn, ts, {"A": 7})
    write(conn, T + 300, {"A": 8})        # a tick newer than the one being published
    assert not_updating(conn, ["A"], as_of=T) == {"A": T - 26 * HOUR}


def test_a_missing_reading_neither_breaks_nor_extends_a_run(conn):
    for i, ts in enumerate(ticks(26)):
        write(conn, ts, {"A": None if i % 4 == 0 else 7})   # the feed sent -9 every fourth tick
    assert "A" in not_updating(conn, ["A"], as_of=T)


def test_only_the_lots_asked_about_are_reported(conn):
    for ts in ticks(26):
        write(conn, ts, {"A": 7, "NOT_PUBLISHED": 7})
    assert set(not_updating(conn, ["A"], as_of=T)) == {"A"}


def test_a_lot_the_window_never_heard_from_is_withheld_from_the_window_start(conn):
    for i, ts in enumerate(ticks(26)):
        write(conn, ts, {"LIVE": i % 3})
    assert not_updating(conn, ["LIVE", "SILENT"], as_of=T) == {"SILENT": T - 26 * HOUR}


def test_an_empty_store_withholds_nothing(conn):
    assert not_updating(conn, ["A"], as_of=T) == {}


def test_the_detector_walks_the_primary_key_backwards_without_a_sort(conn):
    """0.23 s per publish at 635,563 rows depends on this plan. Mixing sort
    directions (`lot_id, data_ts DESC`) adds a temporary B-tree."""
    plan = conn.execute("EXPLAIN QUERY PLAN " + liveness._READINGS_NEWEST_FIRST).fetchall()
    assert not any("TEMP B-TREE" in row[-1] for row in plan), plan


def test_withholding_answers_none_only_for_withheld_lots():
    class Always:
        def predict(self, lot_id, target_ts, horizon_min):
            return 0.75

    forecaster = Withholding(Always(), {"FROZEN": T})
    assert forecaster.predict("FROZEN", T, 15) is None
    assert forecaster.predict("LIVE", T, 15) == 0.75
