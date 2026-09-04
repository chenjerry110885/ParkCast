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
    """Returns every SELECT in an order chosen to break an unsorted reader.

    Only two queries are answered. `latest_ts` and `current` are derived from
    the assembled series, not queried, so any third SELECT here means that
    derivation has silently gone back to the hot store -- which is exactly what
    made both come back empty for a backtest cutoff older than 48 hours.
    """

    def __init__(self, rows):  # rows: (lot_id, data_ts, free_car)
        self._rows = list(rows)

    def execute(self, sql, params=()):
        if "MIN(data_ts)" in sql:
            return _Rows([(min(ts for _, ts, _ in self._rows),)])
        if "data_ts, free_car" in sql:  # the by_lot scan
            return _Rows(sorted(self._rows, key=lambda r: -r[1]))
        raise AssertionError(f"load_history issued an unexpected query: {sql}")


def test_by_lot_series_are_sorted_ascending_by_timestamp():
    rows = [("A", 3000, 1), ("A", 1000, 5), ("A", 2000, 3),
            ("B", 2500, 0), ("B", 500, 7)]
    h = load_history(_HostileConn(rows))
    for lot_id, series in h.by_lot.items():
        stamps = [ts for ts, _ in series]
        assert stamps == sorted(stamps), f"{lot_id} came back out of order"
    assert h.by_lot["A"] == [(1000, 5), (2000, 3), (3000, 1)]


def test_latest_ts_and_current_are_derived_not_queried():
    """Pinned against the same stub: the newest reading and the lots that
    reported it come out of `by_lot`, so a store the hot query cannot see (a
    cold-only backtest window) still produces both."""
    rows = [("A", 3000, 1), ("A", 1000, 5), ("B", 3000, 0), ("C", 2500, 7)]
    h = load_history(_HostileConn(rows))
    assert h.latest_ts == 3000
    assert h.current == {"A": 1, "B": 0}, "C did not report in the newest tick"


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
    assert h.by_lot["A"] == [(1000, 5), (1300, 5)], "the cutoff is strict: >= is excluded"


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
    assert [ts for ts, _ in h.by_lot["A"]] == [start + i * 300 for i in range(5)]


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


def test_current_is_populated_from_a_cold_only_history(conn, tmp_path):
    """The regression: an empty hot store plus a cold corpus must still yield a
    working Persistence, or the backtest silently compares against climatology
    alone and reports a 'win' the model never had to earn."""
    stamps = _cold_day(tmp_path, date(2026, 9, 4))

    h = load_history(conn, cold_dir=tmp_path)   # conn is empty: pruned past 48h
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
    assert max(ts for ts, _ in h.by_lot["A"]) < cutoff


def test_current_matches_the_hot_store_query_it_replaced(conn):
    """The live path is claimed to be unchanged, so it is checked rather than
    asserted: with the hot store holding the newest tick, deriving `current`
    from `by_lot` must agree with the MAX(data_ts) query it replaced, exactly.
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
    assert len(load_history(conn).by_lot["A"]) == 3
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
