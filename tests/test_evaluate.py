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
    write(conn, ts, free=7)
    compact_day(conn, day, tmp_path)

    labels = load_labels(conn, tmp_path)
    assert labels[ts]["A"] == 7, "a cold slot must map back to the reading's real data_ts"


def test_a_day_in_both_stores_is_not_counted_twice(conn, tmp_path):
    day = date(2026, 9, 6)
    start, _ = day_bounds(day)
    ts = start + 300 * 50 + 180
    write(conn, ts, free=3)
    compact_day(conn, day, tmp_path)      # now in cold AND still in hot

    labels = load_labels(conn, tmp_path)
    assert labels[ts] == {"A": 3}, "the overlap must be idempotent, not duplicated"


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
