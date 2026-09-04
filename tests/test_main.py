# tests/test_main.py
import inspect

from parkcast import __main__ as entry
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


def test_compaction_is_wired_up_by_default():
    """The cold store must not depend on a caller remembering to ask for it.

    compact_day had zero production callers for the whole of Plan 1: prune
    deleted everything past 48 hours and no Parquet file was ever written, so
    the system was a rolling two-day buffer that discarded the training corpus.
    """
    assert inspect.signature(run_forever).parameters["archive"].default is archive_day
