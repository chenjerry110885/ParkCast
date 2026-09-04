from datetime import date

import pytest

from parkcast import store
from parkcast.compact import compact_day, day_bounds
from parkcast.feed import FeedSnapshot, Observation
from parkcast.forecast import Blend, Climatology, Persistence, load_history, week_bucket


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


# --- by_lot is sorted by us, not by the database ----------------------------
#
# The query that fills by_lot carries no ORDER BY: on the live store the index
# is non-covering, so ordering in SQL cost 11.19s against 0.16s for the same
# 85,735 rows. Ordering is a property of History, so it is pinned here against
# a connection that hands back rows in the worst order it can.


class _Rows(list):
    def fetchone(self):
        return self[0]


class _HostileConn:
    """Returns every SELECT in an order chosen to break an unsorted reader."""

    def __init__(self, rows):  # rows: (lot_id, data_ts, free_car)
        self._rows = list(rows)

    def execute(self, sql, params=()):
        if "MIN(data_ts)" in sql:
            return _Rows([(min(ts for _, ts, _ in self._rows),)])
        if "MAX(data_ts)" in sql:
            return _Rows([(max(ts for _, ts, _ in self._rows),)])
        if "data_ts, free_car" in sql:  # the by_lot scan
            return _Rows(sorted(self._rows, key=lambda r: -r[1]))
        latest = max(ts for _, ts, _ in self._rows)
        return _Rows([(lot, free) for lot, ts, free in self._rows if ts == latest])


def test_by_lot_series_are_sorted_ascending_by_timestamp():
    rows = [("A", 3000, 1), ("A", 1000, 5), ("A", 2000, 3),
            ("B", 2500, 0), ("B", 500, 7)]
    h = load_history(_HostileConn(rows))
    for lot_id, series in h.by_lot.items():
        stamps = [ts for ts, _ in series]
        assert stamps == sorted(stamps), f"{lot_id} came back out of order"
    assert h.by_lot["A"] == [(1000, 5), (2000, 3), (3000, 1)]


def test_by_lot_is_sorted_across_the_cold_hot_boundary(conn, tmp_path):
    """Cold rows are appended before hot ones, so the two blocks must interleave
    correctly rather than merely being sorted within themselves."""
    day = date(2026, 9, 3)
    start, _ = day_bounds(day)
    other = store.connect(tmp_path / "src.sqlite")
    for slot in range(5):
        store.insert_snapshot(
            other,
            FeedSnapshot(start + slot * 300 + 180, start + slot * 300 + 380,
                         (Observation("A", 5, None),)),
            {"A": 50},
        )
    compact_day(other, day, tmp_path)
    other.close()

    later, _ = day_bounds(date(2026, 9, 4))
    for slot in range(5):
        write(conn, later + slot * 300 + 180, free=3)

    stamps = [ts for ts, _ in load_history(conn, cold_dir=tmp_path).by_lot["A"]]
    assert stamps == sorted(stamps)
    assert len(stamps) == 10


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


def test_climatology_prefers_the_bucket_rate_over_the_lot_rate(conn):
    """Pins the fallback order itself: lot+bucket must be tried before lot.

    Ten weeks of "always free" in one bucket (bucket rate 1.0) are mixed with ten
    weeks of "always full" in a different bucket, which drags the lot's overall
    rate down to 0.5. A lot-first (rather than bucket-first) implementation would
    return 0.5 here instead of 1.0 -- both tiers clear CLIMATOLOGY_MIN_SUPPORT, so
    a passing test can only be explained by the bucket tier winning.
    """
    target_base = 1788537600
    other_base = target_base + 6 * 3600  # a fixed offset lands in a different bucket

    assert week_bucket(other_base) != week_bucket(target_base), \
        "test setup requires the two groups of writes to land in different buckets"

    for week in range(10):
        write(conn, target_base + week * 7 * 86400, free=5)  # always a space
        write(conn, other_base + week * 7 * 86400, free=0)   # always full

    predict_ts = target_base + 15 * 7 * 86400
    assert week_bucket(predict_ts) == week_bucket(target_base), \
        "test setup requires the prediction target to land in the 'always free' bucket"

    c = Climatology(load_history(conn))
    assert c.predict("A", predict_ts, 30) == pytest.approx(1.0), \
        "the bucket rate (1.0) must win; a lot-first order would return the lot rate (0.5)"


def test_climatology_falls_back_to_the_lot_rate_not_the_global_rate(conn):
    """Pins the second fallback step: an empty bucket must reach for the lot's own
    history next, not skip straight to the rate pooled across every lot.
    """
    predict_ts = 1788537600  # bucket 96; none of lot A's writes below land here

    lot_a_ts = [1000 + i * 300 for i in range(10)]
    for ts in lot_a_ts:
        assert week_bucket(ts) != week_bucket(predict_ts), \
            "test setup requires lot A's history to miss the predicted bucket"
        write(conn, ts, lot="A", free=5)  # A always has a space: lot rate 1.0

    for i in range(10):
        write(conn, 1000 + i * 300, lot="B", free=0)  # B is always full

    c = Climatology(load_history(conn))
    # Global rate across both lots is (10 + 0) / 20 == 0.5 -- what a bucket-then-
    # global-only fallback (no lot tier) would return instead of the lot's own 1.0.
    assert c.predict("A", predict_ts, 30) == pytest.approx(1.0)


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


def test_blend_is_persistence_at_the_shortest_horizon(conn):
    """At h=0 the current reading is the whole answer."""
    for i in range(10):
        write(conn, 1000 + i * 300, free=0)   # climatology says 0.0
    write(conn, 4000, free=5)                  # but right now there is a space
    b = Blend(load_history(conn))
    assert b.predict("A", 4000, 0) == pytest.approx(1.0)


def test_blend_moves_toward_climatology_as_the_horizon_grows(conn):
    """Hold target_ts fixed and vary only the horizon, so the climatology term is
    identical in both calls and the difference isolates the decay weight."""
    for i in range(10):
        write(conn, 1000 + i * 300, free=0)
    write(conn, 4000, free=5)
    b = Blend(load_history(conn))
    clim = Climatology(load_history(conn)).predict("A", 4000, 0)
    near, far = b.predict("A", 4000, 5), b.predict("A", 4000, 120)
    assert near > far, "confidence in the current reading must decay with horizon"
    assert abs(far - clim) < abs(near - clim), "the far horizon sits closer to climatology"


def test_blend_halves_the_persistence_weight_every_half_life(conn):
    for i in range(10):
        write(conn, 1000 + i * 300, free=0)
    write(conn, 4000, free=5)
    b = Blend(load_history(conn))
    # climatology ~= 10/11; persistence = 1.0. With w = 0.5**(h/30):
    # P(h) = w*1.0 + (1-w)*clim, so P(30) - clim should be half of P(0) - clim.
    clim = Climatology(load_history(conn)).predict("A", 4000, 0)
    p0, p30 = b.predict("A", 4000, 0), b.predict("A", 4000, 30)
    assert (p30 - clim) == pytest.approx((p0 - clim) / 2, abs=1e-6)


def test_blend_uses_whichever_component_is_available(conn):
    write(conn, 1000, free=5)
    b = Blend(load_history(conn))
    assert b.predict("A", 1300, 5) is not None
    assert b.predict("UNSEEN", 1300, 5) is not None, "falls back to climatology alone"


def test_blend_is_none_with_no_history(conn):
    assert Blend(load_history(conn)).predict("A", 1000, 5) is None


def test_blend_never_leaves_the_unit_interval(conn):
    for i in range(20):
        write(conn, 1000 + i * 300, free=i % 2)
    b = Blend(load_history(conn))
    for h in range(0, 125, 5):
        p = b.predict("A", 7000 + h * 60, h)
        assert 0.0 <= p <= 1.0, f"horizon {h} produced {p}"


def test_cold_observations_covered_by_the_hot_store_are_not_counted_twice(conn, tmp_path):
    """The same reading must not appear once at its true ts and once slot-snapped."""
    day = date(2026, 9, 4)
    start, _ = day_bounds(day)
    # True feed timestamps sit at slot boundary + 180s, exactly as the real feed does.
    for slot in range(10):
        write(conn, start + slot * 300 + 180, free=5)
    compact_day(conn, day, tmp_path)

    hot_only = load_history(conn)
    with_cold = load_history(conn, cold_dir=tmp_path)
    assert len(with_cold.by_lot["A"]) == len(hot_only.by_lot["A"]), (
        "cold rows already covered by the hot window must be skipped"
    )


def test_cold_observations_older_than_the_hot_window_are_kept(conn, tmp_path):
    """Genuinely older history is the whole reason to read the cold store."""
    day = date(2026, 9, 4)
    start, _ = day_bounds(day)
    for slot in range(10):
        write(conn, start + slot * 300 + 180, free=5)
    compact_day(conn, day, tmp_path)

    # A second, older Parquet day that the hot store does not cover.
    older = date(2026, 9, 3)
    older_start, _ = day_bounds(older)
    other = store.connect(tmp_path / "older.sqlite")
    for slot in range(10):
        store.insert_snapshot(
            other,
            FeedSnapshot(older_start + slot * 300 + 180, older_start + slot * 300 + 380,
                         (Observation("A", 5, None),)),
            {"A": 50},
        )
    compact_day(other, older, tmp_path)
    other.close()

    h = load_history(conn, cold_dir=tmp_path)
    assert len(h.by_lot["A"]) == 20, "10 hot + 10 genuinely older cold"


def test_snap_to_slot_rounds_down_to_the_grid():
    from parkcast.forecast import _snap_to_slot

    start, _ = day_bounds(date(2026, 9, 4))
    assert _snap_to_slot(start + 180) == start
    assert _snap_to_slot(start + 300) == start + 300
    assert _snap_to_slot(start + 599) == start + 300


def test_all_cold_is_kept_when_the_hot_store_is_empty(conn, tmp_path):
    day = date(2026, 9, 4)
    start, _ = day_bounds(day)
    other = store.connect(tmp_path / "src.sqlite")
    for slot in range(10):
        store.insert_snapshot(
            other,
            FeedSnapshot(start + slot * 300 + 180, start + slot * 300 + 380,
                         (Observation("A", 5, None),)),
            {"A": 50},
        )
    compact_day(other, day, tmp_path)
    other.close()

    h = load_history(conn, cold_dir=tmp_path)  # conn is empty
    assert len(h.by_lot["A"]) == 10
