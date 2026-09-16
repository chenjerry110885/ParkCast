import sqlite3

import pytest

from parkcast import store
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.quality import Q


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def snap(data_ts, observed_at, free_car=16):
    return FeedSnapshot("taipei", observed_at, (Observation("TPE0001", free_car, None, data_ts, TS_FEED),))


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
    good = tuple(Observation(f"L{i}", 10 + i, None, 1000, TS_FEED) for i in range(5))
    doomed = Observation(None, 10, None, 1000, TS_FEED)  # type: ignore[arg-type]

    with pytest.raises(sqlite3.IntegrityError):
        store.insert_snapshot(conn, FeedSnapshot("taipei", 1180, good + (doomed,)), {})

    assert store.count_rows(conn) == 0, "the good rows of a failed tick must be rolled back"


def test_connection_is_usable_after_an_aborted_batch(conn):
    """The rollback must leave no transaction open, or every later tick fails too."""
    doomed = (Observation("A", 10, None, 1000, TS_FEED),
              Observation(None, 10, None, 1000, TS_FEED))  # type: ignore[arg-type]
    with pytest.raises(sqlite3.IntegrityError):
        store.insert_snapshot(conn, FeedSnapshot("taipei", 1180, doomed), {})

    assert store.insert_snapshot(conn, snap(1300, 1480), {"TPE0001": 50}) == 1
    assert store.count_rows(conn) == 1


def test_prune_removes_only_old_rows(conn):
    store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50})
    store.insert_snapshot(conn, snap(5000, 5180), {"TPE0001": 50})
    assert store.prune(conn, cutoff_ts=2000) == 1
    assert store.latest_data_ts(conn) == 5000


def test_free_at_returns_each_lots_count_at_one_tick(tmp_path):
    conn = store.connect(tmp_path / "t.sqlite")
    store.insert_snapshot(
        conn,
        FeedSnapshot("taipei", 1200, (Observation("A", 12, None, 1000, TS_FEED),
                                       Observation("B", None, None, 1000, TS_FEED))),
        {"A": 50, "B": 50},
    )
    store.insert_snapshot(conn, FeedSnapshot("taipei", 1500, (Observation("A", 7, None, 1300, TS_FEED),)), {"A": 50})
    # The parser already turned the feed's -9 sentinel into None (see feed.py's
    # clean_count call): seen, reported nothing -> None, not dropped.
    assert store.free_at(conn, 1000) == {"A": 12, "B": None}
    assert store.free_at(conn, 1300) == {"A": 7}
    assert store.free_at(conn, 999) == {}


def test_free_at_can_be_scoped_to_one_city(tmp_path):
    """Each city is published from its own `data_ts` now, and two can land on
    the same second -- the fetch-stamped cities date a reading by when the
    request came back. Nothing is misattributed without the scope (lot ids are
    namespaced, and each shard looks up its own), but every shard would drag
    five other cities' rows through the query to find its own."""
    conn = store.connect(tmp_path / "t.sqlite")
    store.insert_snapshot(
        conn,
        FeedSnapshot("taipei", 1200, (Observation("taipei:A", 12, None, 1000, TS_FEED),)),
        {"taipei:A": 50},
    )
    store.insert_snapshot(
        conn,
        FeedSnapshot("kaohsiung", 1150, (Observation("kaohsiung:1", 3, None, 1000, TS_FEED),)),
        {"kaohsiung:1": 50},
    )

    assert store.free_at(conn, 1000, "taipei") == {"taipei:A": 12}
    assert store.free_at(conn, 1000, "kaohsiung") == {"kaohsiung:1": 3}
    assert store.free_at(conn, 1000) == {"taipei:A": 12, "kaohsiung:1": 3}
    assert store.free_at(conn, 1000, "tainan") == {}
    conn.close()


def test_migration_namespaces_every_row_once(tmp_path):
    conn = store.connect(tmp_path / "hot.sqlite")
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at, free_car, free_motor, quality)"
                 " VALUES ('TPE0001', '', 100, 100, 5, NULL, 0)")
    assert store.migrate_to_namespaced_ids(conn) == store.Migration(rewritten=1, dropped=0)
    row = conn.execute("SELECT lot_id, city FROM observations").fetchone()
    assert row == ("taipei:TPE0001", "taipei")
    # Idempotent: a second run must not double-prefix.
    assert store.migrate_to_namespaced_ids(conn) == store.Migration(rewritten=0, dropped=0)
    assert conn.execute("SELECT lot_id FROM observations").fetchone()[0] == "taipei:TPE0001"


def test_migration_handles_a_bare_feed_id_that_itself_contains_a_colon(tmp_path):
    """`instr(lot_id, ':') = 0` would misread this row as already-migrated on
    the very first run (it contains a colon before migration too) and skip it
    forever -- exactly the cross-city id collision namespacing exists to
    prevent. The prefix check must migrate it once, like any other row."""
    conn = store.connect(tmp_path / "hot.sqlite")
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at, free_car, free_motor, quality)"
                 " VALUES ('PL:0001', '', 100, 100, 5, NULL, 0)")
    assert store.migrate_to_namespaced_ids(conn, city="kaohsiung") == store.Migration(
        rewritten=1, dropped=0)
    row = conn.execute("SELECT lot_id, city FROM observations").fetchone()
    assert row == ("kaohsiung:PL:0001", "kaohsiung")
    # Idempotent: a second run must not double-prefix, and must recognize the
    # row as already migrated even though its lot_id still contains a colon.
    assert store.migrate_to_namespaced_ids(conn, city="kaohsiung") == store.Migration(
        rewritten=0, dropped=0)
    assert conn.execute("SELECT lot_id FROM observations").fetchone()[0] == "kaohsiung:PL:0001"


def test_migration_leaves_every_other_citys_rows_alone(tmp_path):
    """The predicate was written when Taipei was the only source, as
    `lot_id NOT LIKE 'taipei:%'`. Against today's six-city store that matches
    every Kaohsiung, Tainan, Taoyuan, New Taipei and Hsinchu row, rewrites each
    to `taipei:kaohsiung:PL0001` and stamps `city = 'taipei'` on it -- in place,
    in one transaction, on the first boot after deploying. Unrecoverable.

    So what marks a row as un-namespaced is `city = ''`, the column's
    ALTER-TABLE default: a recorded fact about when the row was written, not a
    guess from the shape of its id.
    """
    conn = store.connect(tmp_path / "hot.sqlite")
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at,"
                 " free_car, free_motor, quality)"
                 " VALUES ('TPE0001', '', 100, 100, 5, NULL, 0)")
    for city, raw in (("kaohsiung", "PL0001"), ("newtaipei", "010001"),
                      ("tainan", "1"), ("taoyuan", "TY01"), ("hsinchu", "HC9")):
        store.insert_snapshot(
            conn,
            FeedSnapshot(city, 300,
                         (Observation(f"{city}:{raw}", 3, None, 200, TS_FEED),)),
            {},
        )

    assert store.migrate_to_namespaced_ids(conn) == store.Migration(
        rewritten=1, dropped=0), "only the legacy row"

    rows = dict(conn.execute("SELECT lot_id, city FROM observations"))
    assert rows == {
        "taipei:TPE0001": "taipei",
        "kaohsiung:PL0001": "kaohsiung",
        "newtaipei:010001": "newtaipei",
        "tainan:1": "tainan",
        "taoyuan:TY01": "taoyuan",
        "hsinchu:HC9": "hsinchu",
    }
    conn.close()


def test_migration_merges_a_bare_and_namespaced_twin_rather_than_raising(tmp_path):
    """`lot_id` is half of a WITHOUT ROWID primary key, so a store holding both
    `TPE0001` and `taipei:TPE0001` at one `data_ts` makes the UPDATE violate it
    and the whole migration raise.

    Not hypothetical: it needs only a build that writes namespaced ids to run
    without this migration and then restart inside the 48-hour window -- a
    partial deploy, or a roll back and forward. The primary key is also what
    says the two rows are the SAME reading, so the legacy copy is deleted in the
    same transaction rather than merged.
    """
    conn = store.connect(tmp_path / "hot.sqlite")
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at,"
                 " free_car, free_motor, quality)"
                 " VALUES ('TPE0001', '', 1000, 1200, 5, NULL, 0)")
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at,"
                 " free_car, free_motor, quality)"
                 " VALUES ('taipei:TPE0001', 'taipei', 1000, 1500, 4, NULL, 0)")
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at,"
                 " free_car, free_motor, quality)"
                 " VALUES ('TPE0002', '', 1000, 1200, 9, NULL, 0)")

    assert store.migrate_to_namespaced_ids(conn) == store.Migration(
        rewritten=1, dropped=1)

    rows = sorted(conn.execute(
        "SELECT lot_id, city, data_ts, free_car FROM observations"))
    assert rows == [("taipei:TPE0001", "taipei", 1000, 4),
                    ("taipei:TPE0002", "taipei", 1000, 9)], (
        "one row per reading, and the twin that survives is the namespaced one"
    )
    conn.close()


def test_migration_only_drops_a_legacy_row_that_really_is_a_duplicate(tmp_path):
    """The same lot at a *different* `data_ts` is a different reading and does
    not collide. Deleting it would throw away history the migration exists to
    preserve."""
    conn = store.connect(tmp_path / "hot.sqlite")
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at,"
                 " free_car, free_motor, quality)"
                 " VALUES ('TPE0001', '', 1000, 1200, 5, NULL, 0)")
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at,"
                 " free_car, free_motor, quality)"
                 " VALUES ('taipei:TPE0001', 'taipei', 1300, 1500, 4, NULL, 0)")

    assert store.migrate_to_namespaced_ids(conn) == store.Migration(
        rewritten=1, dropped=0)

    assert sorted(conn.execute("SELECT lot_id, data_ts FROM observations")) == [
        ("taipei:TPE0001", 1000), ("taipei:TPE0001", 1300)
    ]
    conn.close()


class _Boom(Exception):
    pass


class _FailsOnUpdate:
    """A connection proxy that lets the DELETE through and fails the UPDATE.

    `sqlite3.Connection.execute` is read-only, so the seam has to be an object
    rather than a monkeypatched attribute. Failing *between* the two statements
    is the case worth pinning: by then the deduplicating DELETE has already
    modified the table inside the transaction.
    """

    def __init__(self, conn):
        self._conn = conn
        self.calls = []

    def execute(self, sql, *args):
        self.calls.append(sql)
        if sql.startswith("UPDATE observations"):
            raise _Boom("disk full, say")
        return self._conn.execute(sql, *args)


def test_a_failed_migration_leaves_the_store_exactly_as_it_was(tmp_path):
    """One transaction. A half-migrated store has two id conventions in one
    table and every later query silently reads half the corpus -- which is the
    very thing this is here to prevent, so a failure must not create it. The
    rows the DELETE had already removed must come back with it."""
    conn = store.connect(tmp_path / "hot.sqlite")
    for lot_id, city in (("TPE0001", ""), ("taipei:TPE0001", "taipei"),
                         ("TPE0002", "")):
        conn.execute("INSERT INTO observations (lot_id, city, data_ts,"
                     " observed_at, free_car, free_motor, quality)"
                     " VALUES (?, ?, 1000, 1200, 5, NULL, 0)", (lot_id, city))
    before = sorted(conn.execute("SELECT lot_id, city, data_ts FROM observations"))

    flaky = _FailsOnUpdate(conn)
    with pytest.raises(_Boom):
        store.migrate_to_namespaced_ids(flaky)

    assert any(sql.startswith("DELETE") for sql in flaky.calls), (
        "the dedupe must have run, or this proves nothing about rolling it back"
    )
    assert flaky.calls[-1] == "ROLLBACK"
    assert sorted(conn.execute(
        "SELECT lot_id, city, data_ts FROM observations")) == before
    conn.close()


def test_source_health_round_trips(tmp_path):
    conn = store.connect(tmp_path / "hot.sqlite")
    store.record_source_health(conn, "tainan", observed_at=200, rows=268, usable=190, newest_ts=199, ok=True)
    health = store.source_health(conn)["tainan"]
    assert (health["rows"], health["usable"], health["ok"]) == (268, 190, True)


def test_source_health_keeps_the_first_sighting_across_later_ticks(tmp_path):
    conn = store.connect(tmp_path / "hot.sqlite")
    store.record_source_health(conn, "tainan", observed_at=200, rows=268, usable=190, newest_ts=199, ok=True)
    store.record_source_health(conn, "tainan", observed_at=500, rows=270, usable=200, newest_ts=499, ok=False)
    health = store.source_health(conn)["tainan"]
    assert health["first_ts"] == 199, "the first sighting must not be overwritten by a later tick"
    assert (health["last_ts"], health["rows"], health["usable"], health["ok"]) == (500, 270, 200, False)
