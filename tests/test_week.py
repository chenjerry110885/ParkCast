"""Tests for `week.build_week_cells`: the numbers `artifacts.encode_week`
packs, computed straight from a city's `Climatology`.
"""
import pytest

from parkcast import config, store
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.forecast import Climatology, empty_history, load_history, week_bucket
from parkcast.week import _bucket_timestamp, build_week_cells


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def write(conn, ts, lot="taipei:TPE0001", free=5, capacity=50):
    store.insert_snapshot(
        conn,
        FeedSnapshot("taipei", ts + 200, (Observation(lot, free, None, ts, TS_FEED),)),
        {lot: capacity},
    )


# --- inverting week_bucket ---------------------------------------------------
#
# The whole risk in this module is getting the inversion backwards -- e.g.
# anchoring bucket 0 on a Monday instead of the epoch's actual Thursday. This
# is the cheapest possible guard: every bucket must round-trip through the
# exact function `forecast.week_bucket` uses to serve real predictions, not a
# reimplementation of its calendar arithmetic.


def test_bucket_timestamp_round_trips_every_bucket_of_the_week():
    for bucket in range(config.WEEK_BUCKETS):
        assert week_bucket(_bucket_timestamp(bucket)) == bucket


def test_bucket_zero_is_thursday_not_monday():
    """1970-01-01 was a Thursday, and week_bucket anchors on the bare epoch
    with no calendar arithmetic -- so bucket 0 is Thursday 00:00 Taipei."""
    assert _bucket_timestamp(0) == -8 * 3600
    # Monday 00:00 Taipei is four days (192 buckets) after that Thursday.
    assert week_bucket(_bucket_timestamp(0) + 4 * 86400) == 192


# --- build_week_cells ---------------------------------------------------


def test_build_week_cells_reports_honest_support(conn):
    lot = "taipei:TPE0001"
    target_ts = 1788537600  # an arbitrary anchor also used in test_forecast.py
    bucket = week_bucket(target_ts)

    # Two observations a week apart, both landing in the same bucket.
    write(conn, target_ts, lot=lot, free=5)
    write(conn, target_ts + 7 * 86400, lot=lot, free=0)

    history = load_history(conn)
    climatology = Climatology(history)
    cells = build_week_cells(history, [lot])

    assert list(cells) == [lot]
    row = cells[lot]
    assert len(row) == config.WEEK_BUCKETS

    probability, support = row[bucket]
    assert support == 2, "support is the raw observation count, before shrinkage"
    assert probability == pytest.approx(
        climatology.predict(lot, target_ts, horizon_min=0)
    ), "the probability must be exactly Climatology's own tier chain, never a copy of it"

    other_bucket = (bucket + 1) % config.WEEK_BUCKETS
    other_ts = _bucket_timestamp(other_bucket)
    other_probability, other_support = row[other_bucket]
    assert other_support == 0, "an unobserved bucket must honestly report zero support"
    assert other_probability is not None, (
        "shrinkage still gives an unobserved bucket a fall-back probability -- "
        "that continuity through lot -> global is the whole point"
    )
    assert other_probability == pytest.approx(
        climatology.predict(lot, other_ts, horizon_min=0)
    )


def test_build_week_cells_gives_every_lot_id_its_own_full_row(conn):
    write(conn, 1000, lot="taipei:TPE0001", free=5)
    write(conn, 1000, lot="taipei:TPE0002", free=0)
    history = load_history(conn)

    cells = build_week_cells(history, ["taipei:TPE0001", "taipei:TPE0002"])

    assert set(cells) == {"taipei:TPE0001", "taipei:TPE0002"}
    for row in cells.values():
        assert len(row) == config.WEEK_BUCKETS


def test_build_week_cells_with_no_observations_anywhere_is_all_unknown(conn):
    """A lot the corpus has never seen at all, in a history with no
    observations anywhere -- not even the global tier has a basis for an
    answer, so `Climatology.predict` returns None for every bucket."""
    history = empty_history()

    cells = build_week_cells(history, ["taipei:GHOST"])

    row = cells["taipei:GHOST"]
    assert len(row) == config.WEEK_BUCKETS
    assert all(probability is None and support == 0 for probability, support in row)
