"""Tests for the backtest.

The evaluation is the one part of this project whose failure mode is a *good*
number rather than a bad one, so the leak tests below matter more than the
arithmetic ones. A backtest that quietly scores a forecaster on its own labels
does not crash, does not look wrong, and invalidates every claim built on it.
"""
import pytest

from parkcast import config, store
from parkcast.compact import compact_day, day_bounds
from parkcast.evaluate import (
    Prediction,
    _hot_window_start,
    backtest,
    brier,
    calibration,
    choose_origins,
    hard_lots,
    load_labels,
    reading_series,
    skill,
    withheld_at,
)
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.liveness import not_updating
from datetime import date


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    # Some tests below write hundreds of ticks; durability is not under test.
    c.execute("PRAGMA synchronous=OFF")
    yield c
    c.close()


def write(conn, ts, lot="A", free=5, capacity=50):
    store.insert_snapshot(
        conn, FeedSnapshot("taipei", ts + 200, (Observation(lot, free, None, ts, TS_FEED),)), {lot: capacity}
    )


def p(prob, outcome, horizon=15, lot="A", support=100):
    return Prediction(lot, horizon, prob, outcome, support)


# --- scoring ---------------------------------------------------------------


def test_brier_is_mean_squared_error():
    # A confident right answer, a confident wrong one: (0.1^2 + 0.9^2) / 2.
    assert brier([p(0.9, 1), p(0.9, 0)]) == pytest.approx((0.01 + 0.81) / 2)


def test_brier_of_a_perfect_forecast_is_zero():
    assert brier([p(1.0, 1), p(0.0, 0)]) == 0.0


def test_brier_of_nothing_is_none_not_zero():
    # An unmeasured cell and a perfect one must never print the same number.
    assert brier([]) is None


def test_skill_is_positive_when_the_model_beats_the_reference():
    assert skill(0.05, 0.10) == pytest.approx(0.5)


def test_skill_is_negative_when_the_model_is_worse():
    assert skill(0.20, 0.10) == pytest.approx(-1.0)


def test_skill_is_none_against_a_perfect_reference():
    # Dividing by a zero reference would raise, and reporting 0 would read as
    # "no better", which is the opposite of the truth.
    assert skill(0.05, 0.0) is None


def test_calibration_reports_observed_against_predicted():
    # Ten forecasts of 0.85, of which 8 happen: well calibrated.
    bins = calibration([p(0.85, 1)] * 8 + [p(0.85, 0)] * 2, bins=10)
    assert len(bins) == 1
    assert bins[0].count == 10
    assert bins[0].mean_predicted == pytest.approx(0.85)
    assert bins[0].observed_rate == pytest.approx(0.8)


def test_calibration_puts_certainty_in_the_last_bin():
    # p == 1.0 would index one past the end without the clamp.
    bins = calibration([p(1.0, 1)], bins=10)
    assert bins[0].low == pytest.approx(0.9)


# --- labels ----------------------------------------------------------------


def test_labels_from_cold_reconstruct_the_true_timestamp(conn, tmp_path):
    day = date(2026, 9, 6)
    start, _ = day_bounds(day)
    ts = start + 300 * 100 + 180          # slot 100, on the feed's phase
    write(conn, ts, lot="taipei:A", free=7)
    compact_day(conn, day, tmp_path)

    labels = load_labels(conn, tmp_path)
    assert labels[ts]["taipei:A"] == 7, (
        "a cold slot must map back to the reading's real data_ts"
    )


def test_a_day_in_both_stores_is_not_counted_twice(conn, tmp_path):
    day = date(2026, 9, 6)
    start, _ = day_bounds(day)
    ts = start + 300 * 50 + 180
    write(conn, ts, lot="taipei:A", free=3)
    compact_day(conn, day, tmp_path)      # now in cold AND still in hot

    labels = load_labels(conn, tmp_path)
    assert labels[ts] == {"taipei:A": 3}, "the overlap must be idempotent, not duplicated"


def test_a_pre_namespacing_cold_label_is_keyed_the_way_the_model_is_asked(conn, tmp_path):
    """`load_labels` reads Parquet on its own -- it does not go through
    `forecast._read_parquet_day` -- so it needs the same `ids.as_stored`
    normalisation, and would not inherit it.

    Everything downstream joins on this key: `withheld_at` against
    `liveness`, `hard_lots` against `history.counts.lot`, and `model.predict`,
    which is called with the label's own key. A bare cold id splits the lot in
    two, so a backtest would be scored on half a corpus -- silently, with
    entirely plausible numbers, which is the one failure mode the evaluation
    cannot afford.
    """
    day = date(2026, 9, 6)
    start, _ = day_bounds(day)
    ts = start + 300 * 50 + 180
    legacy = store.connect(tmp_path / "legacy.sqlite")     # bare, as on disk
    legacy.execute(
        "INSERT INTO observations (lot_id, city, data_ts, observed_at, free_car,"
        " free_motor, quality) VALUES ('TPE0001', '', ?, ?, 3, NULL, 0)",
        (ts, ts + 200),
    )
    compact_day(legacy, day, tmp_path)
    legacy.close()

    labels = load_labels(conn, tmp_path)                   # conn is empty

    assert labels[ts] == {"taipei:TPE0001": 3}


def test_missing_slots_are_absent_rather_than_zero(conn, tmp_path):
    day = date(2026, 9, 6)
    start, _ = day_bounds(day)
    write(conn, start + 300 * 10 + 180, free=4)
    compact_day(conn, day, tmp_path)

    labels = load_labels(conn, tmp_path)
    # Slot 11 was never collected. A zero there would assert the lot was full.
    assert (start + 300 * 11 + 180) not in labels


# --- origins ---------------------------------------------------------------


def test_origins_are_spaced_and_start_after_the_cutoff():
    labels = {t: {"A": 1} for t in range(1000, 5000, 300)}
    chosen = choose_origins(labels, start_ts=2000, every_minutes=30)
    assert chosen[0] >= 2000
    assert all(b - a >= 1800 for a, b in zip(chosen, chosen[1:]))


def test_origins_only_come_from_timestamps_that_have_readings():
    labels = {1000: {"A": 1}, 9000: {"A": 1}}
    assert choose_origins(labels, start_ts=0, every_minutes=1) == [1000, 9000]


# --- the leak tests --------------------------------------------------------


def test_climatology_cannot_see_the_outcome_it_is_scored_on(conn):
    """The test that makes every other number in the report meaningful.

    The lot is always free before the cutoff and always full after it. A
    climatology that respects the cutoff has only "free" in its counts and must
    predict high while the outcome is 0. One that leaked would have counted the
    zeros it is being scored against and would predict low -- scoring well for
    exactly the wrong reason.
    """
    origin = 1_700_000_000
    for i in range(40):                                   # before: always free
        write(conn, origin - (i + 1) * 300, free=9)
    for i in range(1, 30):                                # after: always full
        write(conn, origin + i * 300, free=0)

    result = backtest(conn, cold_dir=None, origins=[origin], horizons=[15])
    clim = result.by_model["climatology"]
    assert clim, "the backtest produced no climatology predictions to check"
    assert all(x.outcome == 0 for x in clim), "the labels should be the full readings"
    assert all(x.probability > 0.5 for x in clim), (
        "climatology saw the post-cutoff zeros -- the train/test cutoff leaked"
    )


def test_persistence_reads_the_origin_not_the_target(conn):
    """`before_ts=origin + 1` has to include the origin reading itself.

    It is the forecaster's input, not one of its labels. Off by one the other
    way and Persistence answers from a reading five minutes staler than the one
    a driver would actually have.
    """
    origin = 1_700_000_000
    write(conn, origin - 300, free=0)
    write(conn, origin, free=9)            # the reading available at prediction time
    write(conn, origin + 900, free=0)      # the label, 15 min later

    result = backtest(conn, cold_dir=None, origins=[origin], horizons=[15])
    persistence = result.by_model["persistence"]
    assert [x.probability for x in persistence] == [1.0], (
        "persistence must answer from the origin reading (free=9), not the one before it"
    )
    assert [x.outcome for x in persistence] == [0]


def test_hard_subset_is_chosen_from_training_data_only(conn):
    """Selecting the hard lots on test outcomes would be the same leak, recoated."""
    cutoff = 1_700_000_000
    for i in range(20):
        write(conn, cutoff - (i + 1) * 300, lot="ALWAYS_FREE", free=9)
        write(conn, cutoff - (i + 1) * 300, lot="OFTEN_FULL", free=0 if i % 2 else 5)
    # After the cutoff the easy lot fills up -- invisible to the selection.
    for i in range(1, 20):
        write(conn, cutoff + i * 300, lot="ALWAYS_FREE", free=0)

    hard = hard_lots(conn, cold_dir=None, before_ts=cutoff, threshold=0.9)
    assert "OFTEN_FULL" in hard
    assert "ALWAYS_FREE" not in hard, "the subset used post-cutoff outcomes"


def test_backtest_scores_every_forecaster_on_the_same_inputs(conn):
    origin = 1_700_000_000
    for i in range(30):
        write(conn, origin - i * 300, free=5)
    write(conn, origin + 900, free=5)

    result = backtest(conn, cold_dir=None, origins=[origin], horizons=[15])
    counts = {name: len(preds) for name, preds in result.by_model.items()}
    assert counts["persistence"] == counts["climatology"] == counts["blend"] == 1, (
        "a fair comparison needs the same predictions from each, not a different sample"
    )


def _two_city_corpus(conn, origin, *, with_kaohsiung):
    """Taipei fills up regularly; Kaohsiung never does and is six times its size.

    Both cities stamp the same timestamps, so every origin and every label is
    shared: the only thing the second city can change is what the corpus looks
    like in aggregate, which is exactly what the test is about.
    """
    for i in range(60, -1, -1):
        ts = origin - i * 300
        write(conn, ts, lot="taipei:A", free=0 if i % 5 else 7)
        for n in range(6 if with_kaohsiung else 0):
            write(conn, ts, lot=f"kaohsiung:B{n}", free=9)
    write(conn, origin + 900, lot="taipei:A", free=7)
    for n in range(6 if with_kaohsiung else 0):
        write(conn, origin + 900, lot=f"kaohsiung:B{n}", free=9)


def test_a_second_city_cannot_move_the_climatology_the_backtest_scores(conn, tmp_path):
    """The backtest has to score the forecaster that actually ships.

    Climatology's top tier shrinks toward `counts.glob`, and every published
    shard gets a `glob` summed from its own city's lots -- that is what makes a
    shard identical to what a store holding only that city would serve
    (`forecast.by_city`). Loading the corpus unscoped shrinks Taipei toward a
    global spanning all six cities instead, so the baseline in the report is one
    no client ever receives, and the trained model in Plan 4 would be measured
    against a bar that does not exist. Measured on this fixture before the fix:
    0.367 where the published answer is 0.247.

    Two stores rather than one assertion about a recomputed number: the property
    is that a neighbouring city is invisible, and comparing against Taipei alone
    states it without restating the arithmetic.
    """
    origin = 1_700_000_000
    alone = store.connect(tmp_path / "alone.sqlite")
    _two_city_corpus(alone, origin, with_kaohsiung=False)
    _two_city_corpus(conn, origin, with_kaohsiung=True)

    solo = backtest(alone, cold_dir=None, city="taipei", origins=[origin], horizons=[15])
    both = backtest(conn, cold_dir=None, city="taipei", origins=[origin], horizons=[15])
    taipei_probs = lambda r: [x.probability for x in r.by_model["climatology"]
                              if x.lot_id == "taipei:A"]

    assert taipei_probs(solo), "the fixture produced no Taipei prediction to compare"
    assert taipei_probs(both) == taipei_probs(solo), (
        "Kaohsiung moved Taipei's climatology: the backtest is scoring a "
        "forecaster no published shard contains"
    )


def test_a_scoped_run_scores_only_its_own_city(conn, tmp_path):
    """A city's report must contain that city and nothing else."""
    origin = 1_700_000_000
    _two_city_corpus(conn, origin, with_kaohsiung=True)

    result = backtest(conn, cold_dir=None, city="taipei", origins=[origin], horizons=[15])
    for name, preds in result.by_model.items():
        assert {x.lot_id for x in preds} == {"taipei:A"}, f"{name} scored another city"


def test_origins_and_labels_come_from_the_same_clock(conn):
    """The failure a review run actually produced: every origin one city's, every
    label another's, and zero predictions scored.

    Kaohsiung and Taoyuan stamp `data_ts = now`, which lands on no fixed phase,
    while Taipei's feed publishes 180s into each five-minute slot. A label is
    joined by its exact timestamp, so an origin on one clock finds nothing on the
    other -- and `choose_origins` over the unscoped store picks whichever
    timestamps sort first, not whichever city is being scored.
    """
    base = 1_700_000_000 - 1_700_000_000 % 300
    for i in range(40):
        write(conn, base + i * 300 + 180, lot="taipei:A", free=0 if i % 4 else 7)
        write(conn, base + i * 300 + 37 + i % 11, lot="kaohsiung:B", free=0 if i % 3 else 9)

    scoped = load_labels(conn, None, city="taipei")
    assert {ts % 300 for ts in scoped} == {180}, "a scoped run must see one clock"

    origins = choose_origins(scoped, start_ts=base + 20 * 300, every_minutes=30)
    result = backtest(conn, cold_dir=None, city="taipei", origins=origins, horizons=[15])
    assert result.by_model["blend"], (
        "no prediction was scored: the origins and the labels are on different clocks"
    )
    assert all(x.lot_id == "taipei:A" for x in result.by_model["blend"])


def test_an_unscoped_load_still_sees_the_whole_store(conn):
    """`city=None` is what the single-city fixtures rely on, and must not filter."""
    write(conn, 1_700_000_000, lot="taipei:A", free=3)
    write(conn, 1_700_000_000, lot="kaohsiung:B", free=4)

    assert load_labels(conn, None)[1_700_000_000] == {"taipei:A": 3, "kaohsiung:B": 4}
    assert load_labels(conn, None, city="kaohsiung")[1_700_000_000] == {"kaohsiung:B": 4}


# --- the not-updating rule -------------------------------------------------


def test_a_lot_not_updating_at_the_origin_is_withheld_from_every_forecaster(conn):
    """The app publishes no forecast for it, so there is nothing to score -- and
    persistence is perfect on a reading that never moves, so scoring it anyway
    flatters the baseline."""
    origin = 1_700_000_000
    for i in range(26 * 12 + 1):
        write(conn, origin - i * 300, lot="FROZEN", free=34)
        write(conn, origin - i * 300, lot="LIVE", free=i % 5)
    write(conn, origin + 900, lot="FROZEN", free=34)
    write(conn, origin + 900, lot="LIVE", free=3)

    result = backtest(conn, cold_dir=None, origins=[origin], horizons=[15])
    for name, preds in result.by_model.items():
        assert {x.lot_id for x in preds} == {"LIVE"}, f"{name} scored a withheld lot"
    assert result.withheld == 1


def test_withholding_cannot_see_past_the_origin(conn):
    """Deciding to withhold is as bound by the cutoff as forecasting is. A lot
    that froze only *after* the origin was live at it and must be scored."""
    origin = 1_700_000_000
    for i in range(6):
        write(conn, origin - i * 300, lot="A", free=i)
    for i in range(1, 26 * 12 + 1):
        write(conn, origin + i * 300, lot="A", free=9)

    result = backtest(conn, cold_dir=None, origins=[origin], horizons=[15])
    assert result.withheld == 0
    assert len(result.by_model["blend"]) == 1


def test_withholding_can_be_turned_off_to_compare(conn):
    origin = 1_700_000_000
    for i in range(26 * 12 + 1):
        write(conn, origin - i * 300, lot="FROZEN", free=34)
    write(conn, origin + 900, lot="FROZEN", free=34)

    result = backtest(conn, cold_dir=None, origins=[origin], horizons=[15],
                      withhold_not_updating=False)
    assert result.withheld == 0
    assert len(result.by_model["blend"]) == 1


def test_the_hot_window_starts_at_the_oldest_reading_it_would_hold():
    ret = config.HOT_RETENTION_SEC
    origin = 1_700_000_000
    stamps = [origin - ret - 300, origin - ret + 300, origin - 600, origin, origin + 300]
    assert _hot_window_start(stamps, origin) == origin - ret + 300


def test_the_hot_window_never_starts_after_the_origin():
    """A collector gap longer than the retention window, ending after the origin:
    nothing was collected in [origin - retention, origin], so the store would be
    empty. The window must not start in the future."""
    ret = config.HOT_RETENTION_SEC
    origin = 1_700_000_000
    stamps = [origin - ret - 3600, origin + 300, origin + 600]
    assert _hot_window_start(stamps, origin) == origin


def test_a_corpus_younger_than_the_window_starts_at_its_first_reading():
    origin = 1_700_000_000
    stamps = [origin - 3600, origin - 300, origin]
    assert _hot_window_start(stamps, origin) == origin - 3600


def test_the_backtest_withholds_exactly_what_publishing_would(conn):
    """Serving and replay are one rule over two data paths: the hot store
    (`liveness.not_updating`) and the corpus labels (`withheld_at` from
    `_hot_window_start`). On a store inside the retention window they must agree
    lot for lot, down to when each lot last updated."""
    origin = 1_700_000_000
    for i in range(30 * 12 + 1):                  # 30 h, inside the 48 h window
        ts = origin - i * 300
        write(conn, ts, lot="FROZEN", free=34)
        write(conn, ts, lot="LIVE", free=i % 5)
        if i >= 26 * 12:                          # silent for the newest 26 h
            write(conn, ts, lot="SILENT", free=7)
        if i % 5 == 0:                            # too sparse to trust
            write(conn, ts, lot="SPARSE", free=9)

    labels = load_labels(conn, None)
    lots = ["FROZEN", "LIVE", "SILENT", "SPARSE"]
    served = not_updating(conn, lots, as_of=origin)
    replayed = withheld_at(reading_series(labels), origin=origin,
                           window_start=_hot_window_start(sorted(labels), origin))

    assert served == replayed
    assert set(served) == {"FROZEN", "SILENT"}, "the comparison must not be vacuous"
