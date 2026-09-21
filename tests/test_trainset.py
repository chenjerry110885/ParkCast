"""Building training rows: sampled, frozen-filtered, and leak-free.

The corpus is never modified here. `liveness.py` states the rule this file
obeys: "The readings are still collected and stored exactly as the feed sent
them." Judging a reading unfit to train on is a decision about what to *read*,
and `test_a_frozen_run_is_filtered_not_deleted` is what keeps it one.
"""
import pytest

from parkcast import config, features, liveness, store, trainset
from parkcast.evaluate import load_labels, reading_series
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.forecast import Climatology, load_history
from parkcast.metadata import Lot

ORIGIN = 1_700_000_000 - 1_700_000_000 % 300
SLOT = 300


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


def lot(lot_id="taipei:A"):
    return Lot(id=lot_id, name="n", area="大安區", lot_type="平面", capacity_car=50,
               lat=25.03, lon=121.54, service_time="", fare_text="每小時30元")


def build(conn, lots=None, **kw):
    """Rows the way the trainer builds them: with the frozen filter armed.

    `reading_series` is always supplied here, because `rows` refuses to run the
    filter without it rather than quietly skipping it.
    """
    history = load_history(conn)
    kw.setdefault("reading_series", reading_series(load_labels(conn, None)))
    return trainset.rows(history, Climatology(history), lots or [lot()], **kw)

def series(conn, lot_id="taipei:A"):
    rows = conn.execute(
        "SELECT data_ts, free_car FROM observations WHERE lot_id = ? ORDER BY data_ts",
        (lot_id,)).fetchall()
    return [t for t, _ in rows], [v for _, v in rows]


# --- frozen runs ------------------------------------------------------------


def test_a_run_shorter_than_the_threshold_is_not_frozen():
    stamps = list(range(0, 6 * 3600, SLOT))       # six hours unchanged
    assert trainset.frozen_spans(stamps, [7] * len(stamps)) == []


def test_a_run_past_the_threshold_is_frozen():
    """`NOT_UPDATING_AFTER_SEC` is 24 hours, so a frozen run spans day
    boundaries -- which is exactly why this detection lives in the trainer,
    where an ordered pass over a lot's whole series is affordable, rather than
    in `load_history`, whose scan is deliberately unordered."""
    span_sec = config.NOT_UPDATING_AFTER_SEC + 3600
    stamps = list(range(0, span_sec, SLOT))

    assert trainset.frozen_spans(stamps, [34] * len(stamps)) == [(0, stamps[-1])]


def test_the_readings_either_side_of_a_frozen_run_are_untouched():
    """Excluding the whole lot would discard the evidence that matters most:
    what it did before it stuck, and what it did when it came back."""
    frozen = config.NOT_UPDATING_AFTER_SEC + 3600
    stamps = list(range(0, frozen + 4 * SLOT, SLOT))
    values = [3] + [34] * (len(stamps) - 2) + [9]

    spans = trainset.frozen_spans(stamps, values)
    assert len(spans) == 1
    assert spans[0][0] == stamps[1]
    assert spans[0][1] == stamps[-2]


def test_a_zero_run_is_frozen_too():
    """陽明山花鐘停車場 sat at 34 free all weekend; 40 other lots sat at 0 and
    published as a 0% chance. Both are a feed that stopped moving."""
    stamps = list(range(0, config.NOT_UPDATING_AFTER_SEC + SLOT, SLOT))
    assert trainset.frozen_spans(stamps, [0] * len(stamps))


def test_the_trailing_span_agrees_with_the_serving_rule(conn):
    """The rule is `liveness`'s and must not fork. `unchanged_run` only reports
    the run ending at the newest reading, which is all publishing needs;
    `frozen_spans` generalises it to every run in the series. Where they
    overlap they have to say the same thing."""
    frozen = config.NOT_UPDATING_AFTER_SEC + 3600
    for ts in range(ORIGIN - frozen, ORIGIN + SLOT, SLOT):
        write(conn, ts, free=34)

    stamps, values = series(conn)
    run = liveness.unchanged_run(reversed(list(zip(stamps, values))))
    assert trainset.frozen_spans(stamps, values)[-1] == (run.since_ts, run.newest_ts)


# --- what gets a row --------------------------------------------------------


def test_a_row_inside_a_frozen_run_is_not_trained_on(conn):
    """A stuck feed repeating one number teaches the model that lot is
    perfectly predictable, and it learns to be confident exactly where the data
    is fictional."""
    frozen = config.NOT_UPDATING_AFTER_SEC + 4 * 3600
    for ts in range(ORIGIN - frozen, ORIGIN + SLOT, SLOT):
        write(conn, ts, free=34)

    built = build(conn, origins=[ORIGIN], horizons=[15])
    assert built == []


def test_a_row_outside_any_frozen_run_is_kept(conn):
    for i in range(24, -1, -1):
        write(conn, ORIGIN - i * SLOT, free=i % 7)

    built = build(conn, origins=[ORIGIN], horizons=[15])
    assert len(built) == 1
    assert built[0].lot_id == "taipei:A"


def test_a_frozen_run_is_filtered_not_deleted(conn):
    """The corpus stays a faithful record of the feed. After building a
    training set the store must hold exactly what it held before."""
    frozen = config.NOT_UPDATING_AFTER_SEC + 3600
    for ts in range(ORIGIN - frozen, ORIGIN + SLOT, SLOT):
        write(conn, ts, free=34)
    before = conn.execute("SELECT count(*), sum(free_car) FROM observations").fetchone()

    build(conn, origins=[ORIGIN], horizons=[15])

    assert conn.execute("SELECT count(*), sum(free_car) FROM observations").fetchone() == before


# --- labels -----------------------------------------------------------------


def test_the_label_is_whether_a_space_existed_at_the_target(conn):
    for i in range(24, -1, -1):
        write(conn, ORIGIN - i * SLOT, free=i % 7)
    write(conn, ORIGIN + 15 * 60, free=0)          # full at the target

    built = build(conn, origins=[ORIGIN], horizons=[15],
                          labels={ORIGIN + 15 * 60: {"taipei:A": 0}})
    assert built[0].label == 0


def test_a_row_with_no_label_still_exists_for_serving(conn):
    """The same function builds serving rows, where there is no label by
    definition. The trainer drops them; nothing else should have to."""
    for i in range(24, -1, -1):
        write(conn, ORIGIN - i * SLOT, free=i % 7)

    built = build(conn, origins=[ORIGIN], horizons=[15])
    assert built[0].label is None


# --- the leak ---------------------------------------------------------------


def test_no_row_uses_a_reading_at_or_after_its_own_origin(conn):
    """At the level rows are built, not just features: two origins in one call
    must each see only their own past."""
    for i in range(40, -1, -1):
        write(conn, ORIGIN - i * SLOT, free=i % 7)

    early, late = ORIGIN - 20 * SLOT, ORIGIN
    built = {r.origin_ts: r for r in build(
        conn, origins=[early, late], horizons=[15])}

    at_origin = features.FEATURES.index("free_now")
    assert built[early].values[at_origin] == 20 % 7
    assert built[late].values[at_origin] == 0


# --- sampling ---------------------------------------------------------------


def test_the_row_count_is_lots_times_origins_times_horizons(conn):
    """A change in sampling shows up as a number here rather than as a fit that
    got slower. The plan's arithmetic: 1,082 lots x 48 origins x 17 days x 5
    horizons is ~4.4M rows, against ~127M if every slot were expanded."""
    for name in ("taipei:A", "taipei:B", "taipei:C"):
        for i in range(24, -1, -1):
            write(conn, ORIGIN - i * SLOT, lot=name, free=i % 7)

    lots = [lot("taipei:A"), lot("taipei:B"), lot("taipei:C")]
    built = build(conn, lots, origins=[ORIGIN - SLOT, ORIGIN],
                          horizons=[5, 15, 30])
    assert len(built) == 3 * 2 * 3


def test_origins_are_spaced_by_the_sampling_cadence():
    labels = {t: {"taipei:A": 1} for t in range(ORIGIN, ORIGIN + 6 * 3600, SLOT)}
    chosen = trainset.sample_origins(labels, every_minutes=30)

    assert all(b - a >= 1800 for a, b in zip(chosen, chosen[1:]))




def test_arming_the_filter_without_the_series_raises(conn):
    """A filter that silently does nothing when its input is missing produces a
    confidently wrong model and no failure anywhere. This is the one case where
    being noisy is worth more than being convenient."""
    write(conn, ORIGIN, free=5)
    history = load_history(conn)

    with pytest.raises(ValueError, match="reading_series"):
        trainset.rows(history, Climatology(history), [lot()],
                      origins=[ORIGIN], horizons=[15])


def test_serving_opts_out_of_the_filter_explicitly(conn):
    """`liveness` has already withheld the frozen lots on the serving path, so
    there is nothing left to filter -- but it has to say so."""
    write(conn, ORIGIN, free=5)
    history = load_history(conn)

    built = trainset.rows(history, Climatology(history), [lot()],
                          origins=[ORIGIN], horizons=[15], exclude_frozen=False)
    assert len(built) == 1


def test_rows_are_produced_one_at_a_time(conn):
    """`iter_rows` is a generator because materialising a real training set is
    4,414,560 rows at 913 bytes each -- 3.8 GB, against the trainer's 2 GB cap.
    Streaming them into a float32 array costs 459 MB for the same rows.
    """
    import types

    write(conn, ORIGIN, free=5)
    history = load_history(conn)
    stream = trainset.iter_rows(history, Climatology(history), [lot()],
                                origins=[ORIGIN], horizons=[15], exclude_frozen=False)

    assert isinstance(stream, types.GeneratorType)
    assert next(stream).lot_id == "taipei:A"


def test_a_row_whose_label_falls_in_a_frozen_run_is_dropped(conn):
    """A lot can be live at the origin and stuck by the time it is scored. The
    features would be real and the label fictional, which teaches the model
    that a moving lot becomes predictable -- the worst of both.

    Dropping on the origin alone would keep this row. Mutation-testing found
    the gap: removing the target-side check broke nothing until this existed.
    """
    for i in range(24, 0, -1):
        write(conn, ORIGIN - i * SLOT, free=i % 7)
    write(conn, ORIGIN, free=3)                       # live, and not 34
    frozen = config.NOT_UPDATING_AFTER_SEC + 3600
    for ts in range(ORIGIN + SLOT, ORIGIN + SLOT + frozen, SLOT):
        write(conn, ts, free=34)                      # stuck from here on

    assert build(conn, origins=[ORIGIN], horizons=[15]) == []


def test_a_row_is_kept_when_only_a_later_horizon_is_frozen(conn):
    """The drop is per (origin, horizon), not per origin: a five-minute
    forecast is still answerable when the two-hour one is not."""
    for i in range(24, 0, -1):
        write(conn, ORIGIN - i * SLOT, free=i % 7)
    write(conn, ORIGIN, free=3)
    frozen = config.NOT_UPDATING_AFTER_SEC + 3600
    for ts in range(ORIGIN + 10 * SLOT, ORIGIN + 10 * SLOT + frozen, SLOT):
        write(conn, ts, free=34)

    kept = build(conn, origins=[ORIGIN], horizons=[5, 120])
    assert [r.horizon_min for r in kept] == [5]
