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


def test_build_week_cells_for_a_lot_the_corpus_has_never_seen_gets_the_citywide_fallback(conn):
    """A newly added lot -- present in this tick's roster, but with no
    observation behind it anywhere in an otherwise ordinary, non-empty
    corpus -- is a real, recurring case (city feeds add lots regularly), not
    a corner case. Climatology's lot tier has nothing to shrink for it, so
    `predict` falls straight through to the global (Jeffreys-shrunk) rate,
    the same for every bucket, while every bucket's support stays honestly
    0 -- support and probability answer different questions ("have we ever
    watched this lot at this hour" vs "what do we expect anyway"), and this
    artifact exists specifically so a client can tell "we predict 40% here"
    apart from "we have never watched this lot at this hour".
    """
    write(conn, 1000, lot="taipei:TPE0001", free=5)
    write(conn, 1000 + 7 * 86400, lot="taipei:TPE0001", free=0)
    history = load_history(conn)
    climatology = Climatology(history)
    fallback = climatology.predict("taipei:NEWLOT", 1000, horizon_min=0)

    cells = build_week_cells(history, ["taipei:TPE0001", "taipei:NEWLOT"])

    row = cells["taipei:NEWLOT"]
    assert len(row) == config.WEEK_BUCKETS
    assert all(support == 0 for _, support in row), (
        "a lot the corpus has never seen must report zero support in every bucket"
    )
    assert all(probability == pytest.approx(fallback) for probability, _ in row), (
        "and the same citywide fall-back probability in every bucket -- the lot "
        "tier (and so the bucket tier beneath it) has nothing of this lot's own "
        "to shrink"
    )


def test_build_week_cells_does_not_mutate_the_shared_bucket_counts(conn):
    """`history.counts.bucket` is the live `defaultdict` `Climatology` also
    reads -- shared, never copied (see `Climatology.__init__`) -- and this
    function only ever asks it questions, via `.get(...)`, never indexes it
    with `[...]`. A `[...]` lookup would silently insert a zeroed `[0, 0]`
    entry for every `(lot_id, bucket)` pair this function merely asks
    about: one daily rebuild would add `len(lot_ids) * config.WEEK_BUCKETS`
    entries to a dict the live forecaster shares (336 per lot; 365,904 for
    Taipei alone), yet `build_week_cells`'s own return value would look
    identical either way, since the shrinkage chain falls back to the same
    parent rate whether a bucket counter exists at zero or does not exist at
    all. The only visible symptom would be memory growth in a long-running
    process -- nothing here would fail on its own, which is exactly why this
    needs its own pin rather than trusting the other tests to notice.
    """
    write(conn, 1000, lot="taipei:TPE0001", free=5)
    history = load_history(conn)
    before = {key: tuple(counter) for key, counter in history.counts.bucket.items()}

    # Many buckets this lot was never observed in, so a `[...]` mutation has
    # plenty of room to insert new entries that `.get` would not.
    build_week_cells(history, ["taipei:TPE0001"])

    after = {key: tuple(counter) for key, counter in history.counts.bucket.items()}
    assert after == before, (
        "build_week_cells must never create bucket entries for buckets it "
        "only read from"
    )
