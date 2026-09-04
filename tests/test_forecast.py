from datetime import date

import pytest

from parkcast import store
from parkcast.compact import compact_day, day_bounds
from parkcast.feed import FeedSnapshot, Observation
from parkcast.forecast import Climatology, Persistence, load_history, week_bucket


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def write(conn, ts, lot="A", free=5, capacity=50):
    store.insert_snapshot(conn, FeedSnapshot(ts, ts + 200, (Observation(lot, free, None),)), {lot: capacity})


def test_history_separates_current_from_past(conn):
    write(conn, 1000, free=5)
    write(conn, 1300, free=9)
    h = load_history(conn)
    assert h.latest_ts == 1300
    assert h.current == {"A": 9}, "current must be the newest tick only"
    assert h.by_lot["A"] == [(1000, 5), (1300, 9)], "by_lot keeps the full ordered series"


def test_history_excludes_missing_readings(conn):
    write(conn, 1000, free=5)
    write(conn, 1300, free=None)
    h = load_history(conn)
    assert h.by_lot["A"] == [(1000, 5)], "NULL readings are absent, never coerced to 0"
    assert "A" not in h.current, "a lot whose newest reading is NULL has no current value"


def test_persistence_is_one_when_a_space_exists(conn):
    write(conn, 1000, free=5)
    assert Persistence(load_history(conn)).predict("A", 1600, 10) == 1.0


def test_persistence_is_zero_when_full(conn):
    write(conn, 1000, free=0)
    assert Persistence(load_history(conn)).predict("A", 1600, 10) == 0.0


def test_persistence_is_none_for_an_unknown_lot(conn):
    write(conn, 1000, free=5)
    assert Persistence(load_history(conn)).predict("NOPE", 1600, 10) is None


def test_persistence_ignores_the_horizon(conn):
    """Naive by design: it is the bar the model must clear, not a good forecast."""
    write(conn, 1000, free=5)
    p = Persistence(load_history(conn))
    assert p.predict("A", 1600, 5) == p.predict("A", 8200, 120)


def test_week_bucket_is_taipei_local_not_utc():
    """16:00 UTC is 00:00 the next day in Taipei, i.e. bucket 0 of that weekday."""
    # 2026-09-04 16:00 UTC == 2026-09-05 00:00 +08
    assert week_bucket(1788537600) % 48 == 0


def test_week_bucket_wraps_over_a_week():
    ts = 1788537600
    assert week_bucket(ts + 7 * 86400) == week_bucket(ts)


def test_climatology_uses_the_lot_bucket_rate(conn):
    # Same bucket on three different weeks: two with a space, one full.
    for week, free in enumerate((5, 5, 0)):
        write(conn, 1788537600 + week * 7 * 86400, free=free)
    c = Climatology(load_history(conn))
    assert c.predict("A", 1788537600 + 21 * 86400, 30) == pytest.approx(2 / 3)


def test_climatology_falls_back_to_the_lot_rate_when_the_bucket_is_thin(conn):
    """One observation in a bucket is not evidence; the lot's overall rate is."""
    for i in range(10):
        write(conn, 1000 + i * 300, free=5)
    write(conn, 1788537600, free=0)  # a lone observation in a far-away bucket
    c = Climatology(load_history(conn))
    # Predicting into that thin bucket must not return 0.0 from a single sample.
    assert c.predict("A", 1788537600 + 7 * 86400, 30) > 0.5


def test_climatology_falls_back_to_the_global_rate_for_an_unseen_lot(conn):
    for i in range(10):
        write(conn, 1000 + i * 300, lot="A", free=5)
    c = Climatology(load_history(conn))
    assert c.predict("BRAND_NEW", 1000, 30) == pytest.approx(1.0)


def test_climatology_is_none_with_no_history_at_all(conn):
    assert Climatology(load_history(conn)).predict("A", 1000, 30) is None


def test_read_cold_missing_dir_returns_normally(conn, tmp_path):
    """cold_dir need not exist yet -- the first daily Parquet file is hours away."""
    h = load_history(conn, cold_dir=tmp_path / "does-not-exist")
    assert h.by_lot == {}


def test_read_cold_empty_dir_returns_normally(conn, tmp_path):
    cold_dir = tmp_path / "cold"
    cold_dir.mkdir()
    h = load_history(conn, cold_dir=cold_dir)
    assert h.by_lot == {}


def test_read_cold_skips_files_with_a_non_iso_date_stem(conn, tmp_path):
    cold_dir = tmp_path / "cold"
    cold_dir.mkdir()
    (cold_dir / "not-a-date.parquet").write_bytes(b"garbage, never parsed as parquet")
    h = load_history(conn, cold_dir=cold_dir)
    assert h.by_lot == {}


def test_read_cold_round_trips_through_compact_day(conn, tmp_path):
    day = date(2026, 9, 1)
    start, _ = day_bounds(day)
    write(conn, start, free=5)
    write(conn, start + 300, free=3)

    cold_dir = tmp_path / "cold"
    compact_day(conn, day, cold_dir)

    hot = store.connect(tmp_path / "hot.sqlite")  # empty hot store
    h = load_history(hot, cold_dir=cold_dir)
    hot.close()

    assert h.by_lot["A"] == [(start, 5), (start + 300, 3)]
