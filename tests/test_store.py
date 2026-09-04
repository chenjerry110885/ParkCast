import sqlite3

import pytest

from parkcast import store
from parkcast.feed import FeedSnapshot, Observation
from parkcast.quality import Q


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def snap(data_ts, observed_at, free_car=16):
    return FeedSnapshot(data_ts, observed_at, (Observation("TPE0001", free_car, None),))


def test_insert_then_read_back(conn):
    assert store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50}) == 1
    row = conn.execute("SELECT lot_id, data_ts, observed_at, free_car FROM observations").fetchone()
    assert tuple(row) == ("TPE0001", 1000, 1180, 16)


def test_reinserting_the_same_tick_is_a_no_op(conn):
    store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50})
    inserted = store.insert_snapshot(conn, snap(1000, 1999), {"TPE0001": 50})
    assert inserted == 0, "duplicate (lot_id, data_ts) must not create a second row"
    assert store.count_rows(conn) == 1


def test_first_observed_at_wins_on_duplicate(conn):
    store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50})
    store.insert_snapshot(conn, snap(1000, 1999), {"TPE0001": 50})
    observed = conn.execute("SELECT observed_at FROM observations").fetchone()[0]
    assert observed == 1180, "must keep the earliest sighting, not overwrite it"


def test_missing_value_stored_as_null_not_zero(conn):
    store.insert_snapshot(conn, snap(1000, 1180, free_car=None), {"TPE0001": 50})
    value, flags = conn.execute("SELECT free_car, quality FROM observations").fetchone()
    assert value is None
    assert Q.MISSING in Q(flags)


def test_overcount_is_clamped_and_flagged(conn):
    store.insert_snapshot(conn, snap(1000, 1180, free_car=80), {"TPE0001": 50})
    value, flags = conn.execute("SELECT free_car, quality FROM observations").fetchone()
    assert value == 50
    assert Q.CLAMPED in Q(flags)


def test_unknown_lot_gets_no_capacity_flag(conn):
    store.insert_snapshot(conn, snap(1000, 1180), {})
    flags = conn.execute("SELECT quality FROM observations").fetchone()[0]
    assert Q.NO_CAPACITY in Q(flags)


def test_latest_data_ts(conn):
    assert store.latest_data_ts(conn) is None
    store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50})
    store.insert_snapshot(conn, snap(1300, 1480), {"TPE0001": 50})
    assert store.latest_data_ts(conn) == 1300


def test_aborted_batch_writes_no_rows_at_all(conn):
    """A tick is all-or-nothing: a batch that fails partway must leave nothing behind.

    Under autocommit each row of the executemany commits separately, so a batch
    that dies on row 6 leaves rows 1-5 permanently visible — a truncated tick
    indistinguishable from a complete one. This happened twice in the live
    store (1119 and 965 rows against a full tick of 1177) when the container
    was restarted mid-batch. The in-slot retry cannot repair it: by the time
    the process is back, the feed has advanced and that data_ts is gone
    forever.

    The failure is injected with a NULL lot_id on the last observation, which
    violates the primary key's implicit NOT NULL only once SQLite reaches
    that row — i.e. after the five good rows have already been written.
    """
    good = tuple(Observation(f"L{i}", 10 + i, None) for i in range(5))
    doomed = Observation(None, 10, None)  # type: ignore[arg-type]

    with pytest.raises(sqlite3.IntegrityError):
        store.insert_snapshot(conn, FeedSnapshot(1000, 1180, good + (doomed,)), {})

    assert store.count_rows(conn) == 0, "the good rows of a failed tick must be rolled back"


def test_connection_is_usable_after_an_aborted_batch(conn):
    """The rollback must leave no transaction open, or every later tick fails too."""
    doomed = (Observation("A", 10, None), Observation(None, 10, None))  # type: ignore[arg-type]
    with pytest.raises(sqlite3.IntegrityError):
        store.insert_snapshot(conn, FeedSnapshot(1000, 1180, doomed), {})

    assert store.insert_snapshot(conn, snap(1300, 1480), {"TPE0001": 50}) == 1
    assert store.count_rows(conn) == 1


def test_prune_removes_only_old_rows(conn):
    store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50})
    store.insert_snapshot(conn, snap(5000, 5180), {"TPE0001": 50})
    assert store.prune(conn, cutoff_ts=2000) == 1
    assert store.latest_data_ts(conn) == 5000
