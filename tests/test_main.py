# tests/test_main.py
import inspect
import logging
import sqlite3

from parkcast import __main__ as entry
from parkcast import store
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.scheduler import archive_day, run_forever


def _capture_run_forever(monkeypatch, seen):
    def fake_run_forever(conn, capacities, **kwargs):
        seen["capacities"] = capacities
        seen["kwargs"] = kwargs

    monkeypatch.setattr(entry, "run_forever", fake_run_forever)


def test_startup_survives_an_unavailable_metadata_endpoint(monkeypatch, tmp_path):
    """A dead metadata blob must not cost a single availability tick.

    The two endpoints are separate blobs; the 2.85 MB metadata one can be down
    while availability is perfectly fine. Dying here loses ticks that can never
    be re-fetched, for a map that costs only a NO_CAPACITY flag while it is
    missing and that the day-rollover refresh rebuilds anyway.
    """
    seen = {}
    monkeypatch.setattr(entry.config, "DB_PATH", tmp_path / "hot.sqlite")
    _capture_run_forever(monkeypatch, seen)

    def unavailable(day):
        raise ConnectionError("metadata endpoint down")

    monkeypatch.setattr(entry, "build_capacities", unavailable)

    entry.main()

    assert seen["capacities"] == {}, "must start collecting with an empty map, not exit"
    assert seen["kwargs"]["refresh_metadata"] is unavailable, (
        "the refresh hook must still be wired, so a later day can fill the map in"
    )


def test_startup_passes_the_loaded_capacities_through(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.setattr(entry.config, "DB_PATH", tmp_path / "hot.sqlite")
    _capture_run_forever(monkeypatch, seen)
    monkeypatch.setattr(entry, "build_capacities", lambda day: {"TPE0001": 50})

    entry.main()

    assert seen["capacities"] == {"TPE0001": 50}


def test_publishing_is_wired_to_the_uploader_from_the_environment(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.setattr(entry.config, "DB_PATH", tmp_path / "hot.sqlite")
    _capture_run_forever(monkeypatch, seen)
    monkeypatch.setattr(entry, "build_capacities", lambda day: {})
    sentinel = object()
    monkeypatch.setattr(entry.upload, "from_environment", lambda: sentinel)
    calls = []
    monkeypatch.setattr(entry, "publish_artifacts", lambda conn, lots, **kw: calls.append(kw))

    entry.main()
    seen["kwargs"]["publish"]("conn")

    assert calls == [{"uploader": sentinel}]


def test_compaction_is_wired_up_by_default():
    """The cold store must not depend on a caller remembering to ask for it.

    compact_day had zero production callers for the whole of Plan 1: prune
    deleted everything past 48 hours and no Parquet file was ever written, so
    the system was a rolling two-day buffer that discarded the training corpus.
    """
    assert inspect.signature(run_forever).parameters["archive"].default is archive_day


# --- the id migration runs at startup ----------------------------------------
#
# Ids were namespaced by city partway through this project's life, and
# `store.migrate_to_namespaced_ids` was written and tested for it in Task 2 --
# and then never called by anything. The hot store is namespaced today only
# because prune ages rows out after 48 hours, not because anything migrated
# them, so the first boot of a build that writes namespaced ids would spend two
# days with both conventions in one window for the same physical car park.
# `forecast.load_history` keys `current` and `counts` on that string, so the
# lot's history splits -- in the half that feeds `Persistence` and
# `store.free_at`, i.e. the short-horizon signal and the observed count on every
# card. These tests exist because `main()` is the only place that closes it.


def _legacy_row(conn, lot_id, data_ts):
    """A row as the collector wrote it before ids were namespaced.

    `city` is '', the ALTER TABLE default -- the column did not exist yet, which
    is exactly what marks the row as predating namespacing.
    """
    conn.execute(
        "INSERT INTO observations (lot_id, city, data_ts, observed_at, free_car,"
        " free_motor, quality) VALUES (?, '', ?, ?, 5, NULL, 0)",
        (lot_id, data_ts, data_ts + 200),
    )


def _lot_ids(db):
    conn = store.connect(db)
    try:
        return sorted(row[0] for row in conn.execute("SELECT lot_id FROM observations"))
    finally:
        conn.close()


def _boot(monkeypatch, db):
    """One `main()`, with collection and metadata stubbed out."""
    monkeypatch.setattr(entry.config, "DB_PATH", db)
    _capture_run_forever(monkeypatch, {})
    monkeypatch.setattr(entry, "build_capacities", lambda day: {})
    entry.main()


def test_startup_namespaces_a_pre_namespacing_store(monkeypatch, tmp_path, caplog):
    db = tmp_path / "hot.sqlite"
    conn = store.connect(db)
    _legacy_row(conn, "TPE0001", 100)
    _legacy_row(conn, "TPE0002", 100)
    conn.close()

    with caplog.at_level(logging.INFO, logger="parkcast"):
        _boot(monkeypatch, db)

    assert _lot_ids(db) == ["taipei:TPE0001", "taipei:TPE0002"]
    assert "id migration rewrote 2 pre-namespacing row(s) and dropped 0" in caplog.text


def test_a_second_startup_rewrites_nothing(monkeypatch, tmp_path, caplog):
    """Idempotent, because this runs on every boot and the collector restarts
    mid-day. A second prefix would be no more recoverable than the first
    split."""
    db = tmp_path / "hot.sqlite"
    conn = store.connect(db)
    _legacy_row(conn, "TPE0001", 100)
    conn.close()

    _boot(monkeypatch, db)
    first = _lot_ids(db)
    with caplog.at_level(logging.INFO, logger="parkcast"):
        _boot(monkeypatch, db)

    assert _lot_ids(db) == first == ["taipei:TPE0001"]
    assert "id migration rewrote 0 pre-namespacing row(s) and dropped 0" in caplog.text


def test_startup_leaves_every_other_citys_rows_alone(monkeypatch, tmp_path):
    """The migration's predicate was written when Taipei was the only source.
    As `lot_id NOT LIKE 'taipei:%'` it rewrites every Kaohsiung, Tainan,
    Taoyuan, New Taipei and Hsinchu row to `taipei:kaohsiung:PL0001` and stamps
    `city = 'taipei'` on all of them -- in place, in one transaction, on the
    first boot after deploying. Five cities' hot windows, unrecoverable.
    """
    db = tmp_path / "hot.sqlite"
    conn = store.connect(db)
    _legacy_row(conn, "TPE0001", 100)
    for city, raw in (("kaohsiung", "PL0001"), ("newtaipei", "010001"),
                      ("tainan", "1"), ("taoyuan", "TY01"), ("hsinchu", "HC9")):
        store.insert_snapshot(
            conn,
            FeedSnapshot(city, 300,
                         (Observation(f"{city}:{raw}", 3, None, 200, TS_FEED),)),
            {},
        )
    conn.close()

    _boot(monkeypatch, db)

    assert _lot_ids(db) == ["hsinchu:HC9", "kaohsiung:PL0001", "newtaipei:010001",
                            "tainan:1", "taipei:TPE0001", "taoyuan:TY01"]
    check = store.connect(db)
    cities = sorted({row[0] for row in check.execute("SELECT city FROM observations")})
    check.close()
    assert cities == ["hsinchu", "kaohsiung", "newtaipei", "tainan", "taipei", "taoyuan"]


def test_startup_migrates_before_anything_reads_the_store(monkeypatch, tmp_path):
    """Order is the whole point. A tick collected, or artifacts published, off a
    half-namespaced store is exactly the split this is here to prevent."""
    db = tmp_path / "hot.sqlite"
    conn = store.connect(db)
    _legacy_row(conn, "TPE0001", 100)
    conn.close()

    order = []
    monkeypatch.setattr(entry.config, "DB_PATH", db)
    real_migrate = store.migrate_to_namespaced_ids
    monkeypatch.setattr(
        entry.store, "migrate_to_namespaced_ids",
        lambda c, *a, **k: (order.append("migrate"), real_migrate(c, *a, **k))[1],
    )
    monkeypatch.setattr(entry, "build_capacities",
                        lambda day: (order.append("metadata"), {})[1])
    monkeypatch.setattr(entry, "run_forever",
                        lambda conn, capacities, **kw: order.append("collect"))

    entry.main()

    assert order == ["migrate", "metadata", "collect"]


def test_startup_merges_a_bare_and_namespaced_twin_instead_of_dying(
    monkeypatch, tmp_path, caplog
):
    """`lot_id` is half of a WITHOUT ROWID primary key, so the same reading
    present under both conventions makes the migration's UPDATE violate it.

    Reachable without anything exotic: a build that writes namespaced ids
    running without this migration, then restarted inside the 48-hour window --
    a partial deploy, or a roll back and forward. Before the dedupe, this killed
    `main()` at startup, and would have killed it again on every later boot.
    """
    db = tmp_path / "hot.sqlite"
    conn = store.connect(db)
    _legacy_row(conn, "TPE0001", 1000)
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at,"
                 " free_car, free_motor, quality)"
                 " VALUES ('taipei:TPE0001', 'taipei', 1000, 1500, 4, NULL, 0)")
    conn.close()

    with caplog.at_level(logging.INFO, logger="parkcast"):
        _boot(monkeypatch, db)

    assert _lot_ids(db) == ["taipei:TPE0001"], "one row per reading"
    assert "rewrote 0 pre-namespacing row(s) and dropped 1" in caplog.text


def test_startup_survives_a_migration_that_fails(monkeypatch, tmp_path, caplog):
    """Collection is the irreplaceable half. A store that cannot be migrated
    costs precision on the short-horizon forecast and the observed count until
    someone fixes it; a collector that refuses to boot costs every tick, on
    every restart, until someone runs SQL by hand. Degrade, do not stop."""
    db = tmp_path / "hot.sqlite"
    conn = store.connect(db)
    _legacy_row(conn, "TPE0001", 100)
    conn.close()

    seen = {}
    monkeypatch.setattr(entry.config, "DB_PATH", db)
    _capture_run_forever(monkeypatch, seen)
    monkeypatch.setattr(entry, "build_capacities", lambda day: {"taipei:X": 4})

    def boom(conn, *args, **kwargs):
        raise sqlite3.IntegrityError("UNIQUE constraint failed")

    monkeypatch.setattr(entry.store, "migrate_to_namespaced_ids", boom)

    with caplog.at_level(logging.ERROR, logger="parkcast"):
        entry.main()

    assert seen["capacities"] == {"taipei:X": 4}, "collection must still start"
    assert "id migration failed and was rolled back" in caplog.text
    assert _lot_ids(db) == ["TPE0001"], "and the store is untouched"
