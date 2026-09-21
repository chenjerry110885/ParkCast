"""One row of features, and the properties that keep it honest.

The two that matter most are the leak test and, in `test_trainset.py`, the skew
test. Everything else here is arithmetic; those two are the reasons this module
is a single shared function rather than whatever each caller found convenient.
"""
import pytest

from parkcast import features, store
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.forecast import Climatology, load_history
from parkcast.metadata import Lot

ORIGIN = 1_700_000_000 - 1_700_000_000 % 300      # a clean five-minute grid point


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    c.execute("PRAGMA synchronous=OFF")
    yield c
    c.close()


def write(conn, ts, lot="taipei:A", free=5, capacity=50):
    store.insert_snapshot(
        conn, FeedSnapshot("taipei", ts + 5, (Observation(lot, free, None, ts, TS_FEED),)),
        {lot: capacity},
    )


def lot(lot_id="taipei:A", **kw):
    fields = dict(id=lot_id, name="n", area="大安區", lot_type="平面", capacity_car=50,
                  lat=25.03, lon=121.54, service_time="", fare_text="每小時30元")
    fields.update(kw)
    return Lot(**fields)


def built(conn, *, at=ORIGIN, horizon=15, the_lot=None, neighbours=()):
    """The row as a dict, which is how every assertion below wants to read it."""
    history = load_history(conn, before_ts=at + 1)
    values = features.row(history, Climatology(history), the_lot or lot(),
                          origin_ts=at, horizon_min=horizon, neighbours=neighbours)
    return dict(zip(features.FEATURES, values))


# --- the shape of a row -----------------------------------------------------


def test_the_feature_order_is_fixed_and_unique():
    """The manifest records this order and the loader refuses a model whose
    order differs. A silent reordering would feed every value to the wrong
    split and still return perfectly plausible probabilities."""
    assert features.FEATURES[0] == "horizon_min"
    assert len(set(features.FEATURES)) == len(features.FEATURES)


def test_a_row_has_one_value_per_named_feature(conn):
    write(conn, ORIGIN, free=9)
    assert len(features.FEATURES) == len(
        features.row(load_history(conn, before_ts=ORIGIN + 1),
                     Climatology(load_history(conn, before_ts=ORIGIN + 1)),
                     lot(), origin_ts=ORIGIN, horizon_min=15, neighbours=())
    )


def test_every_categorical_is_a_named_feature():
    assert set(features.CATEGORICAL) <= set(features.FEATURES)


# --- missing stays missing --------------------------------------------------


def test_an_unknown_capacity_stays_missing_rather_than_zero(conn):
    """`0` means this lot has no car spaces. `None` means we do not know how
    many it has. Imputing the second to the first teaches the model that a lot
    we know nothing about is permanently full."""
    write(conn, ORIGIN, free=9, capacity=None)

    r = built(conn, the_lot=lot(capacity_car=None))
    assert r["capacity_car"] is None
    assert r["free_ratio"] is None, "a ratio against an unknown denominator is not 0"


def test_a_lot_with_no_reading_still_produces_a_row(conn):
    """Climatology may still have something to say about it. The row exists and
    the persistence-derived features are missing, which is exactly the
    distinction `Blend` already makes."""
    write(conn, ORIGIN, lot="taipei:OTHER", free=9)

    r = built(conn, the_lot=lot("taipei:UNSEEN"))
    assert r["free_now"] is None
    assert r["staleness_min"] is None
    assert r["clim_support"] == 0


def test_a_full_lot_reads_zero_not_missing(conn):
    """The distinction in the other direction, and the one the whole project
    turns on: 0 free is a real reading."""
    write(conn, ORIGIN, free=0)

    r = built(conn)
    assert r["free_now"] == 0
    assert r["is_free_now"] == 0
    assert r["free_ratio"] == 0.0


# --- the leak ---------------------------------------------------------------


TAIL_DERIVED = ("free_now", "free_ratio", "is_free_now", "staleness_min",
                "trend_15", "trend_30", "trend_60")


def _contaminated(conn):
    """A history holding readings after the origin, and the same one cut at it."""
    for i in range(12, 0, -1):
        write(conn, ORIGIN - i * 300, free=3)
    write(conn, ORIGIN, free=7)
    write(conn, ORIGIN + 300, free=0)         # the future
    write(conn, ORIGIN + 600, free=0)

    cut = load_history(conn, before_ts=ORIGIN + 1)
    whole = load_history(conn)                # everything, future included
    take = lambda h: dict(zip(features.FEATURES, features.row(
        h, Climatology(cut), lot(), origin_ts=ORIGIN, horizon_min=15, neighbours=())))
    return take(cut), take(whole)


def test_the_readings_a_row_uses_stop_at_the_origin(conn):
    """Every tail-derived feature is identical whether or not the history it is
    handed contains the future.

    Callers are supposed to pass a history built with `before_ts`, and the
    backtest does. Serving does not: it hands over the live history, and
    `quality.data_ts_plausible` accepts a stamp up to DATA_TS_MAX_AHEAD_SEC
    ahead of the fetch, so a reading later than the origin genuinely can be
    sitting in the tail. Cutting here rather than trusting the caller is what
    makes the two paths agree in that case instead of differing invisibly.
    """
    honest, tempted = _contaminated(conn)

    for name in TAIL_DERIVED:
        assert honest[name] == tempted[name], name


def test_the_counts_cannot_defend_themselves_and_this_records_that(conn):
    """The boundary of what this module can guarantee, pinned so that nobody
    later assumes `row` makes a leaky history safe.

    `Counts` is an aggregate with no timestamps left in it -- `add` folds a
    reading into three counters and the reading is gone. So a future
    observation that has already been counted cannot be subtracted here, at any
    price. `load_history(before_ts=...)` is the only thing that can prevent it,
    which is why the train/test contract lives there and not in this file.
    """
    honest, tempted = _contaminated(conn)

    assert honest["clim_support"] != tempted["clim_support"], (
        "if this ever passes, either Counts grew timestamps or the fixture "
        "stopped contaminating them -- check which before deleting the test"
    )


# --- the reading, and how it is moving --------------------------------------


def test_the_trend_is_the_change_since_that_many_minutes_back(conn):
    for i in range(12, 0, -1):
        write(conn, ORIGIN - i * 300, free=10 - i)     # climbing by 1 per slot
    write(conn, ORIGIN, free=10)

    r = built(conn)
    assert r["free_now"] == 10
    assert r["trend_15"] == pytest.approx(3.0)
    assert r["trend_30"] == pytest.approx(6.0)


def test_a_trend_with_nothing_to_compare_against_is_missing(conn):
    """One reading is not a direction. 0 would say "not moving", which is a
    claim about a lot we have seen exactly once."""
    write(conn, ORIGIN, free=10)

    r = built(conn)
    assert r["trend_15"] is None
    assert r["trend_60"] is None


def test_staleness_is_how_old_the_reading_is_at_the_origin(conn):
    write(conn, ORIGIN - 1800, free=4)

    assert built(conn)["staleness_min"] == pytest.approx(30.0)


# --- climatology, carried in rather than relearnt ---------------------------


def test_the_climatology_probability_is_the_one_climatology_would_give(conn):
    """Stacking, not reimplementation. If these ever disagree, the model is
    being fed a number no published shard contains."""
    for i in range(40, 0, -1):
        write(conn, ORIGIN - i * 1800, free=0 if i % 4 else 6)

    history = load_history(conn, before_ts=ORIGIN + 1)
    clim = Climatology(history)
    target = ORIGIN + 15 * 60
    r = dict(zip(features.FEATURES,
                 features.row(history, clim, lot(), origin_ts=ORIGIN, horizon_min=15,
                              neighbours=())))
    assert r["clim_p"] == clim.predict("taipei:A", target, 15)


def test_support_is_the_bucket_count_behind_that_probability(conn):
    """The lever the evaluations identified: bucket n = 0 scored Brier 0.1013,
    n = 6-19 scored 0.0157. A model told the support can learn to distrust a
    thin bucket, which `Blend`'s fixed half-life cannot express."""
    for i in range(3):
        write(conn, ORIGIN + 15 * 60 - (i + 1) * 7 * 86400, free=5)

    assert built(conn)["clim_support"] == 3


# --- the clock --------------------------------------------------------------


def test_time_of_day_is_cyclic_so_midnight_is_next_to_itself(conn):
    """23:59 and 00:01 are two minutes apart, and a raw minute-of-day would
    make them the furthest apart of any pair."""
    write(conn, ORIGIN, free=5)
    day = 86400
    before = built(conn, at=ORIGIN - ORIGIN % day + day - 300)["tod_sin"]
    after = built(conn, at=ORIGIN - ORIGIN % day + 300)["tod_sin"]

    assert abs(before - after) < 0.1


def test_the_day_of_week_is_taipeis_and_is_anchored_where_it_claims(conn):
    """Bucket 0 of the week is THURSDAY 00:00 Taipei, not Monday: the buckets
    are anchored on the Unix epoch and 1970-01-01 was a Thursday. Getting this
    wrong shifts every weekday feature by three days, and the numbers stay
    entirely plausible."""
    write(conn, ORIGIN, free=5)
    thursday_midnight_taipei = 0          # the epoch itself
    assert features.day_of_week(thursday_midnight_taipei) == 0
    assert features.day_of_week(thursday_midnight_taipei + 86400) == 1


# --- categories -------------------------------------------------------------


def test_a_category_maps_to_the_same_integer_in_every_process():
    """Python's builtin hash() for str is salted per process by PYTHONHASHSEED,
    so using it would make the trainer and the collector disagree about what
    "大安區" means -- silently, and only across process boundaries, which is
    where nothing would catch it. crc32 is stable by definition."""
    import subprocess
    import sys

    out = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0, 'src');"
         "from parkcast import features; print(features.category('大安區'))"],
        capture_output=True, text=True, env={"PYTHONHASHSEED": "1", "PATH": ""},
    )
    assert out.stdout.strip() == str(features.category("大安區")), out.stderr


def test_an_absent_category_is_missing_rather_than_a_bucket(conn):
    write(conn, ORIGIN, free=5)
    assert built(conn, the_lot=lot(area=""))["area"] is None


# --- the neighbourhood ------------------------------------------------------


def test_the_neighbourhood_is_how_full_the_lots_around_it_are(conn):
    """District demand is what a per-lot model structurally cannot see, and it
    is what makes "everything around here is filling up" available as evidence."""
    write(conn, ORIGIN, lot="taipei:A", free=5)
    write(conn, ORIGIN, lot="taipei:N1", free=0, capacity=10)
    write(conn, ORIGIN, lot="taipei:N2", free=10, capacity=10)

    r = built(conn, neighbours=("taipei:N1", "taipei:N2"))
    assert r["nbr_free"] == pytest.approx(0.5)
    assert r["nbr_seen"] == 2


def test_a_neighbourhood_nobody_reported_is_missing_not_full(conn):
    write(conn, ORIGIN, lot="taipei:A", free=5)

    r = built(conn, neighbours=("taipei:GONE",))
    assert r["nbr_free"] is None
    assert r["nbr_seen"] == 0


# --- the skew test ----------------------------------------------------------


def test_training_and_serving_build_the_identical_row(conn):
    """The reason `features.row` exists at all.

    Training/serving skew produces a model that scores well offline and badly
    in production with nothing raising: the trainer computes a feature one way,
    the server another, and every probability in between stays between 0 and 1.
    This asserts the trainer has not grown its own copy -- not that the two are
    similar, that they are the same list.

    Written in Task 2 as an xfail, before `trainset` existed, and un-xfailed in
    Task 3 when it did: an xfail that turns into a pass is a signal, where a
    test added later is one somebody has to remember.

    `exclude_frozen=False` is the serving path's own setting -- `liveness` has
    already withheld the frozen lots there -- and it is what makes this a
    comparison of the two paths rather than of two filters.
    """
    from parkcast import trainset

    for i in range(12, 0, -1):
        write(conn, ORIGIN - i * 300, free=i)
    write(conn, ORIGIN, free=6)
    history = load_history(conn, before_ts=ORIGIN + 1)
    clim = Climatology(history)

    serving = features.row(history, clim, lot(), origin_ts=ORIGIN, horizon_min=15,
                           neighbours=())
    training = trainset.rows(history, clim, [lot()], origins=[ORIGIN], horizons=[15],
                             exclude_frozen=False)

    assert [r.values for r in training] == [serving]
