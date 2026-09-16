# tests/test_main.py
import inspect
import json
import logging
import sqlite3
import time

import pytest

from parkcast import __main__ as entry
from parkcast import scheduler, store
from parkcast.feed import TS_FEED, TS_FETCH, FeedSnapshot, Observation
from parkcast.metadata import Lot, capacity_map
from parkcast.scheduler import archive_day, run_forever
from parkcast.sources import SourceTick


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
    monkeypatch.setattr(entry, "publish_artifacts",
                        lambda conn, lots, **kw: calls.append((lots, kw)))

    entry.main()
    seen["kwargs"]["publish"]("conn", {})

    assert calls == [([], {"uploader": sentinel})]


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


def test_a_failed_migration_says_that_withholding_stops_too(monkeypatch, tmp_path, caplog):
    """The log used to describe the cost as precision on the short-horizon
    forecast and the observed count. Measured, it is more than that: every
    per-city read is scoped by the `city` column or by the namespaced key
    range, and a legacy row satisfies neither -- so `liveness.not_updating`
    sees only post-boot readings and no lot can be judged not-updating until
    the collector has been up for NOT_UPDATING_AFTER_SEC. Stuck sensors are
    published as certainties again for about a day, the exact failure
    `liveness.py`'s docstring opens with. An operator reading "collecting
    anyway" has to be told that."""
    db = tmp_path / "hot.sqlite"
    conn = store.connect(db)
    _legacy_row(conn, "TPE0001", 100)
    conn.close()

    def boom(conn, *args, **kwargs):
        raise sqlite3.IntegrityError("UNIQUE constraint failed")

    monkeypatch.setattr(entry.config, "DB_PATH", db)
    _capture_run_forever(monkeypatch, {})
    monkeypatch.setattr(entry, "build_capacities", lambda day: {})
    monkeypatch.setattr(entry.store, "migrate_to_namespaced_ids", boom)

    with caplog.at_level(logging.ERROR, logger="parkcast"):
        entry.main()

    assert "liveness.not_updating" in caplog.text, "name what stops, not only what degrades"
    assert "24 h" in caplog.text
    assert "certainties" in caplog.text


# --- every city that carries its own roster actually gets published ----------
#
# `_lots` was set only by `build_capacities`, which parses Taipei's
# METADATA_URL. The other five feeds answer their roster in the same request as
# their counts, and `collect_once` consumed it for capacities and then dropped
# it -- so `publish_city`, `cities.json`, `bbox` and every `grid-{city}.bin`
# were unreachable in production. The branch's headline feature was dead code
# outside the tests, and no test noticed, because every publish test calls
# `publish_artifacts` directly with a hand-built multi-city roster. Verified
# before the fix by running `main()` with a stubbed `run_forever`: six sources
# registered, `_lots` grouped to `['taipei']`.
#
# This drives the real `main()` -- its source selection, its roster wiring, its
# publish lambda and the real `run_forever` -- injecting only a clock, an
# archive hook and an artifact directory, none of which are the thing tested.


class _StopLoop(BaseException):
    """Escapes run_forever's `except Exception` on purpose."""


class _VirtualClock:
    def __init__(self, start: int):
        self.now = start

    def now_fn(self) -> int:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def _lot(city: str, raw: str, *, lat: float, lon: float) -> Lot:
    return Lot(id=f"{city}:{raw}", name=raw, area="", lot_type="", capacity_car=20,
               lat=lat, lon=lon, service_time="", fare_text="")


class _FakeSource:
    """One city's adapter without the network.

    `carries_roster` is the distinction the whole fix turns on: Taipei answers
    `lots=None`, because its roster arrives on a separate daily endpoint, while
    the other five answer their roster in the very same tick as their counts.
    """

    def __init__(self, city: str, lots: tuple[Lot, ...], *, carries_roster: bool):
        self.city = city
        self._lots = lots
        self._carries_roster = carries_roster

    def fetch(self, *, now: int) -> SourceTick:
        snapshot = FeedSnapshot(
            city=self.city, observed_at=now,
            observations=tuple(
                Observation(lot.id, 5, None, now, TS_FETCH) for lot in self._lots
            ),
        )
        return SourceTick(snapshot=snapshot,
                          lots=self._lots if self._carries_roster else None)


TAIPEI_LOTS = (_lot("taipei", "A", lat=25.05, lon=121.52),
               _lot("taipei", "B", lat=25.04, lon=121.55))
TAINAN_LOTS = (_lot("tainan", "1", lat=22.99, lon=120.21),
               _lot("tainan", "2", lat=22.98, lon=120.19))
KAOHSIUNG_LOTS = (_lot("kaohsiung", "PL0001", lat=22.63, lon=120.30),
                  _lot("kaohsiung", "PL0002", lat=22.61, lon=120.35))


def _drive_main(monkeypatch, tmp_path, *, registry):
    """Run the real `main()` for exactly one slot; return the artifact dir."""
    out_dir = tmp_path / "artifacts"
    clock = _VirtualClock(int(time.time()))

    monkeypatch.delenv(entry.sources.CITIES_ENV, raising=False)
    monkeypatch.setattr(entry.config, "DB_PATH", tmp_path / "hot.sqlite")
    monkeypatch.setattr(entry.config, "PARQUET_DIR", tmp_path / "cold")
    monkeypatch.setattr(entry.sources, "SOURCES", registry)
    monkeypatch.setattr(entry.upload, "from_environment", lambda: None)
    # Taipei's half of the roster, as a successful `build_capacities` leaves it.
    monkeypatch.setattr(entry, "_lots", TAIPEI_LOTS)
    monkeypatch.setattr(entry, "build_capacities", lambda day: capacity_map(TAIPEI_LOTS))
    # The only reason to touch publishing at all: its `out_dir` default is
    # bound at import time, so patching config cannot redirect it.
    monkeypatch.setattr(
        entry, "publish_artifacts",
        lambda conn, lots, **kw: scheduler.publish_artifacts(conn, lots, out_dir, **kw),
    )

    real_run_forever = scheduler.run_forever
    monkeypatch.setattr(
        entry, "run_forever",
        lambda conn, capacities, **kw: real_run_forever(
            conn, capacities, sleep=clock.sleep, now_fn=clock.now_fn,
            archive=lambda conn, day: None, **kw,
        ),
    )

    def stop_after_the_first_publish(conn, cutoff_ts):
        # prune runs after publish inside the loop, so reaching it means this
        # slot was collected and published in full.
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", stop_after_the_first_publish)

    with pytest.raises(_StopLoop):
        entry.main()
    return out_dir


def test_main_publishes_a_shard_for_every_city_that_carries_its_own_roster(
    monkeypatch, tmp_path
):
    out_dir = _drive_main(monkeypatch, tmp_path, registry={
        "taipei": _FakeSource("taipei", TAIPEI_LOTS, carries_roster=False),
        "tainan": _FakeSource("tainan", TAINAN_LOTS, carries_roster=True),
        "kaohsiung": _FakeSource("kaohsiung", KAOHSIUNG_LOTS, carries_roster=True),
    })

    index = json.loads((out_dir / "cities.json").read_text(encoding="utf-8"))
    assert sorted(row["city"] for row in index["cities"]) == [
        "kaohsiung", "tainan", "taipei"
    ], "a roster that reaches the store but not publishing puts no city on the map"
    assert (out_dir / "grid.bin").exists(), "Taipei keeps the unsuffixed names"
    assert (out_dir / "lots.json").exists()
    for city in ("tainan", "kaohsiung"):
        assert (out_dir / f"grid-{city}.bin").exists(), f"{city} has no shard"
        assert (out_dir / f"lots-{city}.json").exists()


def test_main_still_publishes_taipei_from_its_daily_metadata_alone(monkeypatch, tmp_path):
    """The staged rollout's first step: Taipei alone, roster from METADATA_URL,
    and nothing about its shard changed by any of this."""
    out_dir = _drive_main(monkeypatch, tmp_path, registry={
        "taipei": _FakeSource("taipei", TAIPEI_LOTS, carries_roster=False),
    })

    index = json.loads((out_dir / "cities.json").read_text(encoding="utf-8"))
    assert [row["city"] for row in index["cities"]] == ["taipei"]
    assert json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))["n_lots"] == 2


# --- which cities this container collects (PARKCAST_CITIES) -----------------
#
# Spec section 9 and the runbook both stage the rollout: Taipei alone, then New
# Taipei, then the rest. With `SOURCES` hard-coded and `main()` never passing
# `sources=`, that meant editing source and rebuilding the image three times --
# and a first boot after a merge turning all six feeds on at once, which is
# exactly when an unproven adapter costs the most.


def _capture_sources(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.setattr(entry.config, "DB_PATH", tmp_path / "hot.sqlite")
    _capture_run_forever(monkeypatch, seen)
    monkeypatch.setattr(entry, "build_capacities", lambda day: {})
    entry.main()
    return [source.city for source in seen["kwargs"]["sources"]]


def test_an_unset_variable_collects_every_city(monkeypatch, tmp_path):
    """The default has to be the whole registry, or an operator who has never
    heard of this variable silently stops collecting five cities."""
    monkeypatch.delenv(entry.sources.CITIES_ENV, raising=False)
    assert _capture_sources(monkeypatch, tmp_path) == list(entry.sources.SOURCES)


def test_the_variable_narrows_collection_to_the_named_cities(monkeypatch, tmp_path):
    monkeypatch.setenv(entry.sources.CITIES_ENV, "taipei")
    assert _capture_sources(monkeypatch, tmp_path) == ["taipei"]


def test_whitespace_and_order_in_the_variable_do_not_matter(monkeypatch, tmp_path):
    """Request order within a tick is the registry's, not the operator's: this
    names a set of cities to enable, not a sequence to poll in."""
    monkeypatch.setenv(entry.sources.CITIES_ENV, " newtaipei , taipei ,taipei")
    assert _capture_sources(monkeypatch, tmp_path) == ["taipei", "newtaipei"]


def test_an_empty_variable_is_treated_as_unset(monkeypatch, tmp_path):
    monkeypatch.setenv(entry.sources.CITIES_ENV, "   ")
    assert _capture_sources(monkeypatch, tmp_path) == list(entry.sources.SOURCES)


def test_an_unknown_city_stops_the_boot_and_names_the_valid_ones(monkeypatch, tmp_path):
    """Fatal on purpose. Every other startup failure here degrades, because the
    alternative costs ticks that cannot be re-fetched; this one is the opposite
    -- carrying on would collect a set the operator did not ask for while they
    believed otherwise, and that gap is just as unrecoverable."""
    monkeypatch.setenv(entry.sources.CITIES_ENV, "taipei,taichung")
    monkeypatch.setattr(entry.config, "DB_PATH", tmp_path / "hot.sqlite")
    _capture_run_forever(monkeypatch, {})
    monkeypatch.setattr(entry, "build_capacities", lambda day: {})

    with pytest.raises(SystemExit) as exc:
        entry.main()

    assert "taichung" in str(exc.value)
    assert "taipei" in str(exc.value), "the message must list what IS valid"


def test_the_boot_log_says_which_cities_are_being_collected(monkeypatch, tmp_path, caplog):
    """A container that does not say what it is collecting makes a staged
    rollout unverifiable from outside it."""
    monkeypatch.setenv(entry.sources.CITIES_ENV, "taipei,newtaipei")
    with caplog.at_level(logging.INFO, logger="parkcast"):
        _capture_sources(monkeypatch, tmp_path)

    assert "collecting 2 of 6 cities: taipei, newtaipei" in caplog.text
