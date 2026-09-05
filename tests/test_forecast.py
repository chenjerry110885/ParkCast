import logging
import os
from datetime import date

import pytest

from parkcast import config, store
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
    assert h.recent["A"] == [(1000, 5), (1300, 9)], "recent keeps the full ordered series"


# --- recent is sorted by us, not by the database ----------------------------
#
# The query that fills recent carries no ORDER BY: on the live store the index
# is non-covering, so ordering in SQL cost 11.19s against 0.16s for the same
# 85,735 rows. Ordering is a property of History, so it is pinned here against
# a connection that hands back rows in the worst order it can.


class _HostileConn:
    """Returns every SELECT in an order chosen to break an unsorted reader.

    Only one query is answered. `latest_ts` and `current` are derived from the
    assembled series, not queried, so any second SELECT here means that
    derivation has silently gone back to the hot store -- which is exactly what
    made both come back empty for a backtest cutoff older than 48 hours.
    """

    def __init__(self, rows):  # rows: (lot_id, data_ts, free_car)
        self._rows = list(rows)

    def execute(self, sql, params=()):
        if "data_ts, free_car" in sql:  # the recent scan
            return sorted(self._rows, key=lambda r: -r[1])
        raise AssertionError(f"load_history issued an unexpected query: {sql}")


def test_recent_series_are_sorted_ascending_by_timestamp():
    rows = [("A", 3000, 1), ("A", 1000, 5), ("A", 2000, 3),
            ("B", 2500, 0), ("B", 500, 7)]
    h = load_history(_HostileConn(rows))
    for lot_id, series in h.recent.items():
        stamps = [ts for ts, _ in series]
        assert stamps == sorted(stamps), f"{lot_id} came back out of order"
    assert h.recent["A"] == [(1000, 5), (2000, 3), (3000, 1)]


def test_latest_ts_and_current_are_derived_not_queried():
    """Pinned against the same stub: the newest reading and the lots that
    reported it come out of `recent`, so a store the hot query cannot see (a
    cold-only backtest window) still produces both."""
    rows = [("A", 3000, 1), ("A", 1000, 5), ("B", 3000, 0), ("C", 2500, 7)]
    h = load_history(_HostileConn(rows))
    assert h.latest_ts == 3000
    assert h.current == {"A": 1, "B": 0}, "C did not report in the newest tick"


def test_recent_is_sorted_across_the_cold_hot_boundary(conn, tmp_path):
    """Cold rows are read before hot ones, so on the backtest path -- the only
    path where `recent` spans both stores -- the two blocks must interleave
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

    h = load_history(conn, cold_dir=tmp_path, before_ts=later + 86400)
    stamps = [ts for ts, _ in h.recent["A"]]
    assert stamps == sorted(stamps)
    assert len(stamps) == 10


def test_history_excludes_missing_readings(conn):
    write(conn, 1000, free=5)
    write(conn, 1300, free=None)
    h = load_history(conn)
    assert h.recent["A"] == [(1000, 5)], "NULL readings are absent, never coerced to 0"
    # With no other lot reporting, the newest tick that carried *any* reading is
    # 1000, so that is what latest_ts (and therefore base_data_ts) describes --
    # the honest answer, rather than claiming the freshness of an all-NULL tick.
    assert h.latest_ts == 1000
    assert h.current == {"A": 5}


def test_a_lot_whose_newest_reading_is_null_has_no_current_value(conn):
    """The live shape of the case above: ~1,000 lots report each tick, so a lot
    that returned -9 is simply absent from `current` and Persistence declines to
    answer for it rather than reaching back to a stale reading."""
    write(conn, 1000, lot="A", free=5)
    write(conn, 1300, lot="A", free=None)
    write(conn, 1300, lot="B", free=7)
    h = load_history(conn)
    assert h.latest_ts == 1300
    assert h.current == {"B": 7}
    assert Persistence(h).predict("A", 1600, 5) is None


# --- before_ts: the train side of a time split -------------------------------
#
# Climatology counts every observation it is given, so scoring it against the
# same store it was built from lets it see its own labels. Persistence gets only
# the newest tick and has no such advantage. Spec section 8 rests on that
# comparison being fair, so a backtest needs a history that provably stops.


def test_before_ts_excludes_observations_at_or_after_the_cutoff(conn):
    for ts in (1000, 1300, 1600, 1900):
        write(conn, ts, free=5)
    h = load_history(conn, before_ts=1600)
    assert h.recent["A"] == [(1000, 5), (1300, 5)], "the cutoff is strict: >= is excluded"


def test_before_ts_current_is_the_newest_tick_before_the_cutoff(conn):
    write(conn, 1000, free=5)
    write(conn, 1300, free=7)
    write(conn, 1600, free=9)   # the label a backtest would score against
    h = load_history(conn, before_ts=1600)
    assert h.latest_ts == 1300, "latest_ts must not reach past the cutoff"
    assert h.current == {"A": 7}, "current must be the newest tick before the cutoff"


def test_before_ts_filters_the_cold_store_too(conn, tmp_path):
    """A cutoff that only bound the hot query would train on the cold copy of
    exactly the days being scored."""
    day = date(2026, 9, 4)
    start, _ = day_bounds(day)
    other = store.connect(tmp_path / "src.sqlite")
    for slot in range(10):
        store.insert_snapshot(
            other,
            FeedSnapshot(start + slot * 300, start + slot * 300 + 200,
                         (Observation("A", 5, None),)),
            {"A": 50},
        )
    compact_day(other, day, tmp_path)
    other.close()

    cutoff = start + 5 * 300
    h = load_history(conn, cold_dir=tmp_path, before_ts=cutoff)   # conn is empty
    assert [ts for ts, _ in h.recent["A"]] == [start + i * 300 for i in range(5)]


# --- latest_ts and current must follow the history, not the hot store --------
#
# The hot store keeps 48 hours. Every historical cutoff a backtest uses is
# older than that, so a hot-store query for the newest tick matched nothing:
# `current` came back {} and `Persistence.predict` returned None for every lot,
# deleting one of the two baselines spec section 8 requires the model to beat --
# with no error, exactly the asymmetry `before_ts` exists to remove.


def _cold_day(tmp_path, day, *, lot="A", free=5, slots=10):
    """Write one Parquet day and return its slot timestamps."""
    start, _ = day_bounds(day)
    other = store.connect(tmp_path / f"src-{day}-{lot}.sqlite")
    for slot in range(slots):
        store.insert_snapshot(
            other,
            FeedSnapshot(start + slot * 300, start + slot * 300 + 200,
                         (Observation(lot, free, None),)),
            {lot: 50},
        )
    compact_day(other, day, tmp_path)
    other.close()
    return [start + slot * 300 for slot in range(slots)]


def test_current_is_populated_from_a_cold_only_backtest(conn, tmp_path):
    """The regression: an empty hot store plus a cold corpus must still yield a
    working Persistence, or the backtest silently compares against climatology
    alone and reports a 'win' the model never had to earn.

    A backtest is the only way this store shape is reached: `recent` is fed from
    the cold stream exactly when a cutoff is given, because that is when the hot
    store may hold nothing. Live, hot always holds the newest 48 hours."""
    stamps = _cold_day(tmp_path, date(2026, 9, 4))

    # conn is empty: pruned past 48h, as it is for every cutoff Plan 4 will use.
    h = load_history(conn, cold_dir=tmp_path, before_ts=stamps[-1] + 1)
    assert h.latest_ts == stamps[-1], "the newest cold reading, not 0"
    assert h.current == {"A": 5}
    assert Persistence(h).predict("A", stamps[-1] + 600, 10) == 1.0, (
        "the persistence baseline must not evaporate for a historical cutoff"
    )


def test_before_ts_still_governs_current_over_a_cold_only_history(conn, tmp_path):
    """The fix must not reopen the leak: nothing at or after the cutoff may
    reach `current`, cold store or not."""
    stamps = _cold_day(tmp_path, date(2026, 9, 4))
    cutoff = stamps[5]

    h = load_history(conn, cold_dir=tmp_path, before_ts=cutoff)
    assert h.latest_ts == stamps[4], "latest_ts must stop strictly before the cutoff"
    assert h.current == {"A": 5}
    assert max(ts for ts, _ in h.recent["A"]) < cutoff


def test_current_matches_the_hot_store_query_it_replaced(conn):
    """The live path is claimed to be unchanged, so it is checked rather than
    asserted: with the hot store holding the newest tick, deriving `current`
    from `recent` must agree with the MAX(data_ts) query it replaced, exactly.
    """
    for i in range(5):
        write(conn, 1000 + i * 300, lot="A", free=i)       # includes free=0
        write(conn, 1000 + i * 300, lot="B", free=5)
    write(conn, 1000 + 5 * 300, lot="A", free=0)           # C-style partial tick
    h = load_history(conn)

    latest = conn.execute("SELECT MAX(data_ts) FROM observations").fetchone()[0]
    expected = dict(conn.execute(
        "SELECT lot_id, free_car FROM observations "
        "WHERE data_ts = ? AND free_car IS NOT NULL", (latest,)
    ))
    assert h.latest_ts == latest
    assert h.current == expected == {"A": 0}, "0 is a reading, not a missing one"


def test_before_ts_none_keeps_everything(conn):
    for ts in (1000, 1300, 1600):
        write(conn, ts, free=5)
    assert len(load_history(conn).recent["A"]) == 3
    assert load_history(conn).latest_ts == 1600


def test_a_forecaster_trained_before_the_cutoff_cannot_see_its_labels(conn):
    """The leak this exists to close: without a cutoff, climatology's count for
    the target bucket already contains the target observation."""
    base = 1788537600
    for week in range(4):
        write(conn, base + week * 7 * 86400, free=5)   # always a space...
    target = base + 4 * 7 * 86400
    write(conn, target, free=0)                        # ...until the test day

    leaky = Climatology(load_history(conn)).predict("A", target, 30)
    clean = Climatology(load_history(conn, before_ts=target)).predict("A", target, 30)
    assert clean > leaky, "the label must not be inside the training counts"


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
    # The whole chain, spelled out, because every tier here holds the same three
    # observations: Jeffreys on the global tier, then lot toward global, then
    # bucket toward lot. A raw 2/3 at every level would be the unsmoothed answer.
    glob = (2 + 0.5) / (3 + 1)
    lot_rate = (2 + 20 * glob) / (3 + 20)
    assert c.predict("A", 1788537600 + 21 * 86400, 30) == pytest.approx(
        (2 + 8 * lot_rate) / (3 + 8)
    )


def test_climatology_falls_back_to_the_lot_rate_when_the_bucket_is_thin(conn):
    """One observation in a bucket is not evidence; the lot's overall rate is."""
    for i in range(10):
        write(conn, 1000 + i * 300, free=5)
    write(conn, 1788537600, free=0)  # a lone observation in a far-away bucket
    c = Climatology(load_history(conn))
    # Predicting into that thin bucket must not return 0.0 from a single sample.
    assert c.predict("A", 1788537600 + 7 * 86400, 30) > 0.5


def test_climatology_falls_back_to_the_global_rate_for_an_unseen_lot(conn):
    """The global tier carries a Jeffreys prior, so it is (hits + 0.5)/(n + 1)
    rather than the raw fraction.

    A corpus of ten hits out of ten would otherwise hand an unseen lot exactly
    1.0 -- a certainty from a tier with nothing above it to shrink toward, and
    one that then propagates down every tier beneath it. "Never a certainty"
    was a property of the corpus we happen to have; this makes it a property of
    the function, at the cost of ~4.5 points on a ten-observation store and
    nothing measurable on a real one.
    """
    for i in range(10):
        write(conn, 1000 + i * 300, lot="A", free=5)
    c = Climatology(load_history(conn))
    assert c.predict("BRAND_NEW", 1000, 30) == pytest.approx(10.5 / 11)
    assert c.predict("BRAND_NEW", 1000, 30) < 1.0, (
        "a degenerate global rate must not reach the client as a certainty"
    )


def test_climatology_is_none_with_no_history_at_all(conn):
    assert Climatology(load_history(conn)).predict("A", 1000, 30) is None


def test_climatology_prefers_the_bucket_rate_over_the_lot_rate(conn):
    """Pins the fallback order itself: lot+bucket must be tried before lot.

    Ten weeks of "always free" in one bucket (bucket rate 1.0) are mixed with ten
    weeks of "always full" in a different bucket, which drags the lot's overall
    rate down to 0.5. A lot-first (rather than bucket-first) implementation would
    return the lot rate here, so a passing test can only be explained by the
    bucket tier winning. Shrinkage pulls the bucket's raw 1.0 down toward the
    lot's 0.5, so what is pinned is that the answer is driven by the bucket and
    sits well clear of the lot rate -- not that it is exactly 1.0.
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
    # lot: 10 hits / 20, shrunk toward the identical global 0.5, stays 0.5.
    # bucket: 10 hits / 10, shrunk toward that 0.5 with 8 pseudo-obs -> 14/18.
    assert c.predict("A", predict_ts, 30) == pytest.approx(14 / 18), \
        "the bucket must win; a lot-first order would return the lot rate (0.5)"


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
    # global-only fallback (no lot tier) would return. The lot tier gives A's own
    # 10/10 shrunk toward that 0.5 with 20 pseudo-obs: (10 + 10) / 30.
    assert c.predict("A", predict_ts, 30) == pytest.approx(2 / 3)
    assert c.predict("A", predict_ts, 30) > 0.5, "the lot tier must beat the global rate"


# --- shrinkage keeps climatology a probability -------------------------------
#
# Spec section 8 makes climatology the baseline a model has to beat. A 30-minute
# bucket at a 5-minute cadence holds 6 observations a week, so a raw bucket rate
# is nearly always 0.0 or 1.0 -- measured live, 96.1% of bucket cells and 79% of
# published grid bytes. A baseline that answers with certainties is trivially
# beatable on Brier score, which would make the headline claim hollow.


def test_climatology_never_returns_a_certainty_on_realistic_input(conn):
    """Thin buckets, always-free lots and always-full lots together: exactly the
    mix that produced 96% degenerate cells before shrinkage."""
    base = 1788537600
    for week in range(3):                      # lot A: always a space
        write(conn, base + week * 7 * 86400, lot="A", free=5)
    for week in range(3):                      # lot B: always full
        write(conn, base + week * 7 * 86400, lot="B", free=0)
    for i in range(20):                        # some mixed history for the city
        write(conn, base + 3600 + i * 300, lot="C", free=i % 2)

    c = Climatology(load_history(conn))
    seen = []
    for lot_id in ("A", "B", "C"):
        for bucket in range(0, 336, 7):        # spread across the week
            p = c.predict(lot_id, base + bucket * 1800, 30)
            assert p is not None
            seen.append(p)
            assert 0.0 < p < 1.0, f"{lot_id} bucket {bucket} returned {p}"
    assert min(seen) < max(seen), "shrinkage must not flatten every lot together"


def test_climatology_shrinks_a_lone_observation_most_of_the_way_to_its_parent(conn):
    """One reading in a bucket is 1/9 of the answer, not all of it."""
    base = 1788537600
    for i in range(40):
        write(conn, 1000 + i * 300, lot="A", free=5)   # lot rate ~1
    write(conn, base, lot="A", free=0)                 # a single full reading

    c = Climatology(load_history(conn))
    lone_bucket = c.predict("A", base + 7 * 86400, 30)
    elsewhere = c.predict("A", base + 3 * 86400, 30)
    assert lone_bucket < elsewhere, "the observation must still move the answer"
    assert lone_bucket > 0.75, "one sample must not drag the bucket to near-zero"


def test_climatology_is_a_no_op_when_every_tier_agrees(conn):
    """Shrinkage toward a parent that already matches must not shift the mean.

    A balanced corpus is the setup where that is exactly true of all three
    tiers: at a rate of 0.5 the Jeffreys prior on the global tier is itself a
    no-op ((2 + 0.5)/(4 + 1) == 0.5), so any movement in the answer is
    shrinkage doing something it should not.
    """
    base = 1788537600
    for week, free in enumerate((5, 5, 0, 0)):
        write(conn, base + week * 7 * 86400, free=free)
    c = Climatology(load_history(conn))
    assert c.predict("A", base + 28 * 86400, 30) == pytest.approx(0.5)


def test_climatology_bucket_and_lot_priors_are_configured(conn):
    """The published grid is sensitive to these two numbers, so a silent edit
    should fail here rather than quietly reshaping every probability."""
    from parkcast import config

    assert config.CLIMATOLOGY_BUCKET_PRIOR == 8
    assert config.CLIMATOLOGY_LOT_PRIOR == 20
    assert not hasattr(config, "CLIMATOLOGY_MIN_SUPPORT"), (
        "the hard support gate is replaced by shrinkage; leaving the constant "
        "around implies a threshold that no longer exists"
    )


def test_published_grid_bytes_are_mostly_probabilities(conn):
    """The end of the chain: what the client actually downloads. Before
    shrinkage 79% of live grid bytes were exactly 0 or 100.

    Blend still rounds to 100 for a lot that has a space now and almost always
    has one, at a horizon where persistence dominates -- that is persistence
    being 0/1, not climatology being degenerate. So the far horizon, where
    climatology carries the weight, is pinned exactly, and the whole grid only
    loosely.
    """
    from parkcast.grid import UNKNOWN, build_grid

    base = 1788537600
    for i in range(60):
        write(conn, base + i * 300, lot="A", free=(i % 7 != 0))
        write(conn, base + i * 300, lot="B", free=5)
    h = load_history(conn)
    lot_ids = ["A", "B"]
    grid = build_grid(Blend(h), lot_ids, h.latest_ts)

    known = [b for b in grid if b != UNKNOWN]
    assert known
    far = [grid[i * 24 + 23] for i in range(len(lot_ids))]  # +120 min
    assert all(0 < b < 100 for b in far), f"climatology-dominated bytes: {far}"
    certain = [b for b in known if b in (0, 100)]
    assert len(certain) / len(known) < 0.1, (
        f"{len(certain)} of {len(known)} bytes are certainties"
    )


def test_read_cold_missing_dir_returns_normally(conn, tmp_path):
    """cold_dir need not exist yet -- the first daily Parquet file is hours away."""
    h = load_history(conn, cold_dir=tmp_path / "does-not-exist")
    assert h.recent == {}


def test_read_cold_empty_dir_returns_normally(conn, tmp_path):
    cold_dir = tmp_path / "cold"
    cold_dir.mkdir()
    h = load_history(conn, cold_dir=cold_dir)
    assert h.recent == {}


def test_read_cold_skips_files_with_a_non_iso_date_stem(conn, tmp_path):
    cold_dir = tmp_path / "cold"
    cold_dir.mkdir()
    (cold_dir / "not-a-date.parquet").write_bytes(b"garbage, never parsed as parquet")
    h = load_history(conn, cold_dir=cold_dir)
    assert h.recent == {}


def test_read_cold_round_trips_through_compact_day(conn, tmp_path):
    day = date(2026, 9, 1)
    start, _ = day_bounds(day)
    write(conn, start, free=5)
    write(conn, start + 300, free=3)

    cold_dir = tmp_path / "cold"
    compact_day(conn, day, cold_dir)

    hot = store.connect(tmp_path / "hot.sqlite")  # empty hot store
    h = load_history(hot, cold_dir=cold_dir, before_ts=start + 600)
    hot.close()

    assert h.recent["A"] == [(start, 5), (start + 300, 3)]
    assert h.counts.lot["A"] == [2, 2]


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
    assert with_cold.counts.lot["A"] == hot_only.counts.lot["A"] == [10, 10], (
        "a day held by both stores must be counted once, not twice"
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
    assert h.counts.lot["A"] == [20, 20], "10 hot + 10 genuinely older cold"


def test_taipei_day_start_agrees_with_day_bounds():
    """The hot scan runs this per observation instead of building a datetime, so
    the arithmetic shortcut has to give the same answer as the calendar."""
    from parkcast.forecast import _taipei_day_start

    for day in (date(2026, 1, 1), date(2026, 9, 4), date(2026, 12, 31)):
        start, end = day_bounds(day)
        assert _taipei_day_start(start) == start
        assert _taipei_day_start(start + 180) == start
        assert _taipei_day_start(end - 1) == start
        assert _taipei_day_start(end) == end, "midnight belongs to the next day"


def test_compacted_days_lists_the_days_with_a_parquet_file(tmp_path):
    from parkcast.forecast import compacted_days

    assert compacted_days(tmp_path) == frozenset()
    _write_parquet_day(tmp_path, date(2026, 9, 3), {0: 5})
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5})
    assert compacted_days(tmp_path) == {date(2026, 9, 3), date(2026, 9, 4)}


def test_compacted_days_ignores_files_that_are_not_a_day(tmp_path):
    """A stray file must not claim ownership of a day, nor raise."""
    from parkcast.forecast import compacted_days

    (tmp_path / "not-a-date.parquet").write_bytes(b"garbage")
    (tmp_path / "2026-09-04.sqlite").write_bytes(b"not parquet")
    assert compacted_days(tmp_path) == frozenset()


def test_hot_rows_on_a_day_cold_owns_are_counted_once_and_only_once(conn, tmp_path):
    """The overlap rule, pinned where it now lives: in the counts.

    Both stores hold the same three readings -- cold slot-aligned, hot at the
    true feed timestamps -- and the corpus totals must say three, not six. The
    tail is exempt from the rule (see the test below), so it is the counts that
    carry it.
    """
    day = date(2026, 9, 4)
    start, _ = day_bounds(day)
    for slot in range(3):
        write(conn, start + slot * 300 + 180, free=5)   # true feed timestamps
    compact_day(conn, day, tmp_path)

    h = load_history(conn, cold_dir=tmp_path)
    assert h.counts.lot["A"] == [3, 3], "the cold copy counts; the hot one does not"
    assert h.counts.glob == [3, 3]


def test_recent_ignores_the_ownership_rule_and_takes_the_hot_copy(conn, tmp_path):
    """The serving path fills `recent` from the hot store with no ownership skip.

    This is what keeps the map alive across a midnight rollover: cold owns the
    day just compacted, so skipping it would empty `recent` -- and with it
    `current`, `latest_ts` and every Persistence answer -- for hours. Re-seeing
    an observation in a tail is harmless; re-counting one in a rate is not.
    """
    day = date(2026, 9, 4)
    start, _ = day_bounds(day)
    for slot in range(3):
        write(conn, start + slot * 300 + 180, free=5)
    compact_day(conn, day, tmp_path)          # cold now owns the whole day

    h = load_history(conn, cold_dir=tmp_path)
    stamps = [ts for ts, _ in h.recent["A"]]
    assert stamps == [start + 180, start + 480, start + 780], (
        "the hot originals, not the slot-aligned cold copies"
    )
    assert h.latest_ts == start + 780
    assert Persistence(h).predict("A", start + 1080, 5) == 1.0


def test_a_cold_only_lot_keeps_its_counts_but_has_no_recent_tail(conn, tmp_path):
    """The serving path does not re-stream cold, so a lot the hot store has
    pruned past keeps its climatology but loses its current reading.

    Live this shape does not arise -- hot holds 48 hours and every lot reports
    every tick. It is pinned so the split between `counts` (whole corpus) and
    `recent` (hot tail) is explicit rather than incidental.
    """
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
    assert h.counts.lot["A"] == [10, 10], "climatology still sees the cold corpus"
    assert h.recent == {}, "the tail comes from the hot store, which is empty"
    assert Climatology(h).predict("A", start, 30) is not None


from parkcast.forecast import Counts


def test_counts_accumulate_hits_and_totals():
    c = Counts()
    c.add("A", 1000, 5)   # a space -> hit
    c.add("A", 1300, 0)   # full    -> miss
    assert c.glob == [1, 2]
    assert c.lot["A"] == [1, 2]


def test_counts_bucket_by_taipei_time_of_week():
    from parkcast.forecast import week_bucket
    c = Counts()
    c.add("A", 1788537600, 5)
    assert c.bucket[("A", week_bucket(1788537600))] == [1, 1]


def test_counts_zero_free_is_a_miss_not_missing_data():
    """0 means the lot is full - a real observation, and a miss."""
    c = Counts()
    c.add("A", 1000, 0)
    assert c.glob == [0, 1], "the observation counts toward the total"


def test_combined_sums_elementwise_without_mutating_either_side():
    a = Counts(); a.add("A", 1000, 5)
    b = Counts(); b.add("A", 1000, 0)
    merged = a.combined(b)
    assert merged.glob == [1, 2]
    assert a.glob == [1, 1], "combined must not mutate the receiver"
    assert b.glob == [0, 1], "combined must not mutate the argument"


def test_combined_keeps_keys_present_in_only_one_side():
    a = Counts(); a.add("A", 1000, 5)
    b = Counts(); b.add("B", 1000, 5)
    merged = a.combined(b)
    assert merged.lot["A"] == [1, 1] and merged.lot["B"] == [1, 1]


from parkcast.forecast import ColdCountCache


def _write_parquet_day(tmp_path, day, free_by_slot, lot="A"):
    """Compact a throwaway store into one daily Parquet file."""
    start, _ = day_bounds(day)
    src = store.connect(tmp_path / f"src-{day}.sqlite")
    for slot, free in free_by_slot.items():
        ts = start + slot * 300 + 180
        store.insert_snapshot(
            src, FeedSnapshot(ts, ts + 200, (Observation(lot, free, None),)), {lot: 50}
        )
    compact_day(src, day, tmp_path)
    src.close()


def test_cache_folds_each_file_exactly_once(tmp_path):
    """A second call must not double-count - that would silently skew every rate."""
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 5, 2: 0})
    cache = ColdCountCache()
    first = cache.counts_through(tmp_path, None)
    second = cache.counts_through(tmp_path, None)
    assert first.glob == [2, 3]
    assert second.glob == [2, 3], "re-reading the same files must not double-count"


def test_cache_folds_in_a_newly_appearing_day(tmp_path):
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 5})
    cache = ColdCountCache()
    assert cache.counts_through(tmp_path, None).glob == [2, 2]
    _write_parquet_day(tmp_path, date(2026, 9, 5), {0: 0})
    assert cache.counts_through(tmp_path, None).glob == [2, 3], (
        "a new day must be folded in without re-reading the old ones"
    )


def test_cache_does_not_reread_files_it_has_seen(tmp_path, monkeypatch):
    """The whole point: per-tick cost must not grow with corpus age."""
    import pyarrow.parquet as pq
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 5})
    cache = ColdCountCache()
    cache.counts_through(tmp_path, None)

    reads = []
    real = pq.read_table
    monkeypatch.setattr(pq, "read_table", lambda *a, **k: reads.append(a) or real(*a, **k))
    cache.counts_through(tmp_path, None)
    assert reads == [], "an already-folded file must never be read again"


def test_cache_replaces_a_restamped_day_rather_than_adding_to_it(tmp_path, caplog):
    """A re-stamped file REPLACES its old contribution. It must not stack on it.

    Byte-identical content is the sharp case, and a realistic one: restoring
    `data/cold` from a backup, or rsyncing it into place, rewrites the same rows
    under a new mtime. Folding them a second time on top of the first doubled
    every counter -- which leaves the raw rates untouched and so shows up nowhere
    obvious, but halves the effective weight of CLIMATOLOGY_BUCKET_PRIOR and
    CLIMATOLOGY_LOT_PRIOR against n, sharpening every published probability. A
    partial restore skews the rates between lots and buckets outright.
    """
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 5, 2: 0})
    path = tmp_path / "2026-09-04.parquet"
    cache = ColdCountCache()
    assert cache.counts_through(tmp_path, None).glob == [2, 3]

    # Identical bytes, new mtime. Stamped explicitly rather than relying on the
    # clock to tick between two writes -- Windows file times move in ~15ms steps.
    blob = path.read_bytes()
    path.unlink()
    path.write_bytes(blob)
    os.utime(path, ns=(0, 1_600_000_000_000_000_000))

    with caplog.at_level(logging.WARNING, logger="parkcast.forecast"):
        assert cache.counts_through(tmp_path, None).glob == [2, 3], (
            "a re-stamped file replaces what it gave before; it does not add to it"
        )
    assert "2026-09-04.parquet" in caplog.text, (
        "re-folding the whole corpus is too much work to do silently, and the "
        "file that triggered it is the one thing worth naming"
    )


def test_cache_refolds_a_recompacted_day_at_its_new_contents(tmp_path):
    """Same rule where the content really did change: the day counts once, at
    what the file says now -- not the sum of both versions."""
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 5})
    cache = ColdCountCache()
    assert cache.counts_through(tmp_path, None).glob == [2, 2]

    (tmp_path / "src-2026-09-04.sqlite").unlink()
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 5, 2: 5, 3: 5})
    assert cache.counts_through(tmp_path, None).glob == [4, 4]


def test_refolding_one_changed_day_keeps_the_days_beside_it(tmp_path):
    """The re-fold discards the whole directory's counts, so every other file
    has to be read again -- an untouched neighbour must come back at its own
    weight, neither dropped to zero nor left double."""
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 0})
    _write_parquet_day(tmp_path, date(2026, 9, 5), {0: 5, 1: 5, 2: 5})
    cache = ColdCountCache()
    assert cache.counts_through(tmp_path, None).glob == [4, 5]

    (tmp_path / "src-2026-09-04.sqlite").unlink()
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5})
    assert cache.counts_through(tmp_path, None).glob == [4, 4], (
        "2026-09-05 is counted exactly once across the re-fold"
    )


def test_cache_respects_before_ts(tmp_path):
    start, _ = day_bounds(date(2026, 9, 4))
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 5, 2: 5})
    counts = ColdCountCache().counts_through(tmp_path, before_ts=start + 300)
    assert counts.glob == [1, 1], "only the slot strictly before the cutoff counts"


def test_cache_keeps_directories_apart(tmp_path):
    """One cache, two cold stores: neither may inherit the other's totals."""
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(); b.mkdir()
    _write_parquet_day(a, date(2026, 9, 4), {0: 5, 1: 5})
    _write_parquet_day(b, date(2026, 9, 4), {0: 0})
    cache = ColdCountCache()
    assert cache.counts_through(a, None).glob == [2, 2]
    assert cache.counts_through(b, None).glob == [0, 1]
    assert cache.counts_through(a, None).glob == [2, 2], "unchanged by the other dir"


def test_a_compacted_day_survives_the_hot_store_pruning_past_it(conn, tmp_path):
    """The bug a timestamp cutoff would have caused: a day folded while it was
    still in the hot window must not vanish once the hot window moves past it."""
    day = date(2026, 9, 4)
    _write_parquet_day(tmp_path, day, {0: 5, 1: 5, 2: 0})

    # Fold while a hot store still covers that day...
    start, _ = day_bounds(day)
    write(conn, start + 180, free=5)
    load_history(conn, cold_dir=tmp_path)

    # ...then with the hot store empty, as if it had pruned past the day.
    empty = store.connect(tmp_path / "empty.sqlite")
    h = load_history(empty, cold_dir=tmp_path)
    empty.close()
    assert h.counts.glob == [2, 3], (
        "the compacted day must still be counted after hot prunes past it"
    )


# --- the retained tail is bounded; the counts are not ------------------------
#
# Holding every observation reached 1.2 GB by day 30 for a series nothing reads
# past its end. `recent` is now the newest config.HISTORY_TAIL readings per lot
# and `counts` carries the corpus, so memory stops tracking corpus age without
# narrowing what climatology learned.


def test_recent_is_bounded_to_the_tail(conn):
    """Memory must not grow with corpus age - this is the whole point of Plan 2b."""
    for i in range(config.HISTORY_TAIL * 3):
        write(conn, 1000 + i * 300, free=5)
    h = load_history(conn)
    assert len(h.recent["A"]) == config.HISTORY_TAIL


def test_recent_keeps_the_NEWEST_observations_not_the_oldest(conn):
    for i in range(config.HISTORY_TAIL * 2):
        write(conn, 1000 + i * 300, free=i % 7)
    h = load_history(conn)
    stamps = [ts for ts, _ in h.recent["A"]]
    assert stamps == sorted(stamps), "still ordered"
    assert max(stamps) == 1000 + (config.HISTORY_TAIL * 2 - 1) * 300
    assert h.latest_ts == max(stamps)


def test_recent_keeps_the_newest_by_timestamp_not_by_arrival_order():
    """The hot scan carries no ORDER BY, so which rows survive the bound cannot
    depend on the order the storage engine hands them over.

    The same hostile connection as above, but with more rows than the tail: a
    `deque(maxlen=...)` would keep the oldest here, and every existing fixture
    is too small to notice.
    """
    n = config.HISTORY_TAIL * 2
    rows = [("A", 1000 + i * 300, i % 7) for i in range(n)]
    h = load_history(_HostileConn(rows))          # returned newest-first
    stamps = [ts for ts, _ in h.recent["A"]]
    assert stamps == sorted(ts for _, ts, _ in rows)[-config.HISTORY_TAIL:]
    assert h.latest_ts == 1000 + (n - 1) * 300


def test_counts_cover_the_whole_corpus_not_just_the_tail(conn):
    """Truncating `recent` must not truncate what climatology learned."""
    n = config.HISTORY_TAIL * 3
    for i in range(n):
        write(conn, 1000 + i * 300, free=5)
    h = load_history(conn)
    assert len(h.recent["A"]) == config.HISTORY_TAIL
    assert h.counts.lot["A"] == [n, n], "every observation still counted"


def test_climatology_learns_from_the_whole_corpus_not_the_retained_tail(conn):
    """The other half of the same rule, at the forecaster: a Climatology rebuilt
    from `recent` would be trained on the last two hours of the city."""
    n = config.HISTORY_TAIL
    for i in range(2 * n):
        write(conn, 1000 + i * 300, free=0)       # always full...
    for i in range(2 * n, 3 * n):
        write(conn, 1000 + i * 300, free=5)       # ...until the retained tail
    h = load_history(conn)
    assert len(h.recent["A"]) == n

    # An unseen lot reads the global tier straight off the corpus counts: n hits
    # in 3n observations, Jeffreys-smoothed. From the tail alone it would be
    # n/n, i.e. ~0.98 -- the corpus says the opposite.
    assert Climatology(h).predict("UNSEEN", 1000, 30) == pytest.approx(
        (n + 0.5) / (3 * n + 1)
    )


def test_the_serving_path_does_not_reread_the_cold_store(conn, tmp_path, monkeypatch):
    """A warm tick must not touch a Parquet file at all.

    The counts come from the folded cache and the tail comes from the hot store,
    so there is nothing left for a second pass over the cold corpus to supply --
    and that pass cost a full re-read of every day, every five minutes.
    """
    import pyarrow.parquet as pq

    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 5, 2: 0})
    write(conn, day_bounds(date(2026, 9, 5))[0] + 180, free=5)
    load_history(conn, cold_dir=tmp_path)          # cold tick: folds the file

    reads = []
    real = pq.read_table
    monkeypatch.setattr(pq, "read_table", lambda *a, **k: reads.append(a) or real(*a, **k))
    h = load_history(conn, cold_dir=tmp_path)

    assert reads == [], "a warm serving tick must read no Parquet at all"
    assert h.counts.glob == [3, 4], "and must still see the whole corpus"


def test_a_backtest_cutoff_does_not_poison_the_serving_cache(conn, tmp_path):
    """A `before_ts` load must not leave the shared cold cache truncated."""
    _write_parquet_day(tmp_path, date(2026, 9, 4), {0: 5, 1: 5, 2: 5})
    start, _ = day_bounds(date(2026, 9, 4))
    load_history(conn, cold_dir=tmp_path, before_ts=start + 300)
    full = load_history(conn, cold_dir=tmp_path)
    assert full.counts.glob[1] == 3, "the serving path must still see every observation"
