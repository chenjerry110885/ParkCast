"""The adoption gate: the thing that is allowed to say no.

A model that retrains itself nightly can degrade itself nightly, unattended,
while every log stays green. This is the only component standing between that
and the published grid, so its own leak test matters more than any other test
in Stage B: a candidate scored on data it trained on would pass every night,
which is strictly worse than having no gate at all.
"""
import json

import pytest

from parkcast import features, store, train
from parkcast.compact import day_bounds
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.metadata import Lot
from datetime import date

DAY = date(2026, 9, 20)
START, END = day_bounds(DAY)


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    c.execute("PRAGMA synchronous=OFF")
    yield c
    c.close()


def lot(lot_id):
    return Lot(id=lot_id, name="n", area="大安區", lot_type="平面", capacity_car=50,
               lat=25.03, lon=121.54, service_time="", fare_text="每小時30元")


LOTS = [lot(f"taipei:L{i}") for i in range(6)]


def fill(conn, *, days=6, pattern=None):
    """A corpus ending at the close of DAY, with a learnable daily rhythm."""
    pattern = pattern or (lambda slot, i: 0 if 36 <= slot % 288 <= 120 else 5 + i)
    for d in range(days, -1, -1):
        for slot in range(0, 288, 3):
            ts = START - d * 86400 + slot * 300 + 180
            for i, l in enumerate(LOTS):
                store.insert_snapshot(
                    conn,
                    FeedSnapshot("taipei", ts + 5,
                                 (Observation(l.id, pattern(slot, i), None, ts, TS_FEED),)),
                    {l.id: 50})


# --- the window -------------------------------------------------------------


def test_the_validation_day_is_the_one_before_the_day_being_served():
    """Training on < D-1 and validating on [D-1, D) ships a model one day
    staler than it could be. The alternative -- validate one fit, refit on < D,
    ship that -- ships a model nobody ever scored. Freshness comes from the
    features, not the weights, so the stale day costs nothing and never
    shipping an unvalidated artifact is worth more."""
    cutoff, val_start, val_end = train.validation_window(DAY)

    assert val_end == START
    assert val_start == START - 86400
    assert cutoff == val_start


def test_nothing_in_the_validation_window_is_inside_the_training_cutoff():
    """The gate's own leak test, at the level of the arithmetic."""
    cutoff, val_start, val_end = train.validation_window(DAY)

    assert cutoff <= val_start < val_end


# --- the decision -----------------------------------------------------------


def run(conn, tmp_path, **kw):
    return train.nightly(conn, None, city="taipei", day=DAY,
                         model_dir=tmp_path / "models", lots=LOTS, **kw)


#: Scores where the candidate clears every bar. The adoption-path tests below
#: use these rather than hoping a GBT beats persistence on six synthetic lots
#: over six days. What those tests are about is the gate's machinery -- write,
#: digest, rotate, record -- and driving it with real scores would mean tuning
#: the fixture until it produced the answer the test wanted, which is fitting
#: the evidence to the conclusion. Whether a model actually wins is a question
#: for real data, and `test_a_real_fit_is_scored_honestly` is where the honest
#: path is exercised without prejudging which way it goes.
WINS = {"candidate": 0.02, "persistence": 0.10, "climatology": 0.09, "incumbent": None}


def test_a_first_model_is_adopted_when_it_clears_the_baselines(conn, tmp_path):
    fill(conn)

    decision = run(conn, tmp_path, _force_scores=WINS)

    assert decision.adopted, decision.reason
    assert (tmp_path / "models" / "current.txt").exists()
    assert decision.scores["candidate"] is not None


def test_a_candidate_that_loses_to_persistence_is_not_adopted(conn, tmp_path):
    """Beating the incumbent is not enough if both are worse than the baseline
    the spec gates on."""
    fill(conn)

    decision = run(conn, tmp_path, beat_baselines=True,
                   _force_scores={"candidate": 0.30, "persistence": 0.10,
                                  "climatology": 0.20, "incumbent": None})

    assert not decision.adopted
    assert "persistence" in decision.reason


def test_a_candidate_worse_than_the_incumbent_is_not_adopted(conn, tmp_path):
    fill(conn)

    decision = run(conn, tmp_path,
                   _force_scores={"candidate": 0.20, "persistence": 0.30,
                                  "climatology": 0.30, "incumbent": 0.10})

    assert not decision.adopted
    assert "incumbent" in decision.reason


def test_a_rejection_leaves_the_incumbent_byte_for_byte(conn, tmp_path):
    fill(conn)
    run(conn, tmp_path, _force_scores=WINS)               # adopt a first model
    current = tmp_path / "models" / "current.txt"
    before, manifest_before = current.read_bytes(), train.manifest(tmp_path / "models")

    decision = run(conn, tmp_path,
                   _force_scores={"candidate": 0.9, "persistence": 0.1,
                                  "climatology": 0.1, "incumbent": 0.05})

    assert not decision.adopted
    assert current.read_bytes() == before
    assert train.manifest(tmp_path / "models") == manifest_before


def test_the_artifact_validated_is_the_artifact_written(conn, tmp_path):
    """No refit between validating and shipping. A model scored on the
    validation day and then re-fitted on one more day before writing is a model
    nobody ever scored."""
    fill(conn)

    decision = run(conn, tmp_path, _force_scores=WINS)

    assert decision.adopted
    assert decision.digest == train.manifest(tmp_path / "models")["sha256"]


def test_the_written_model_was_trained_through_the_validated_cutoff(conn, tmp_path):
    fill(conn)
    cutoff, _, _ = train.validation_window(DAY)

    run(conn, tmp_path, _force_scores=WINS)

    assert train.manifest(tmp_path / "models")["trained_through"] == cutoff


# --- visibility -------------------------------------------------------------


def test_every_decision_is_recorded_where_the_report_can_read_it(conn, tmp_path):
    """A run of rejections is itself a signal. A log line nobody reads is not
    where it belongs."""
    fill(conn)
    run(conn, tmp_path, _force_scores=WINS)
    run(conn, tmp_path, _force_scores={"candidate": 0.9, "persistence": 0.1,
                                       "climatology": 0.1, "incumbent": 0.05})

    lines = [json.loads(l) for l in
             (tmp_path / "models" / "decisions.jsonl").read_text().splitlines()]
    assert [d["adopted"] for d in lines] == [True, False]
    assert all("reason" in d and "day" in d for d in lines)


def test_a_corpus_too_thin_to_train_on_declines_rather_than_fits(conn, tmp_path):
    """A day and a half of data is not a model. Declining is the honest
    outcome, and the reason has to say so -- a thin corpus must never read as a
    rejection on merit, because the two call for opposite responses: wait, or
    investigate."""
    fill(conn, days=2)

    decision = run(conn, tmp_path)

    assert not decision.adopted
    assert "rows" in decision.reason and "floor" in decision.reason
    assert not (tmp_path / "models" / "current.txt").exists()


def test_a_corpus_with_nothing_before_the_cutoff_declines_too(conn, tmp_path):
    """The same outcome one step earlier: everything collected is inside the
    validation day, so there is no training side at all."""
    fill(conn, days=0)

    decision = run(conn, tmp_path)

    assert not decision.adopted
    assert "no history" in decision.reason
    assert not (tmp_path / "models" / "current.txt").exists()


def test_scores_are_reported_even_when_the_candidate_is_rejected(conn, tmp_path):
    """A rejection with no numbers cannot be investigated."""
    fill(conn)

    decision = run(conn, tmp_path,
                   _force_scores={"candidate": 0.9, "persistence": 0.1,
                                  "climatology": 0.1, "incumbent": None})

    assert decision.scores["candidate"] == 0.9
    assert decision.scores["persistence"] == 0.1


# --- scoring ----------------------------------------------------------------


def test_brier_of_nothing_is_none_not_zero():
    """An unmeasured gate and a perfect one must never print the same number."""
    assert train.brier([], []) is None


def test_brier_is_mean_squared_error():
    assert train.brier([0.9, 0.9], [1, 0]) == pytest.approx((0.01 + 0.81) / 2)


# --- the leak the first real run exposed ------------------------------------


def _tick(conn, ts, pairs):
    store.insert_snapshot(
        conn, FeedSnapshot("taipei", ts + 5,
                           tuple(Observation(lid, free, None, ts, TS_FEED) for lid, free in pairs)),
        {l.id: 50 for l in LOTS})


def _corpus(conn, *, afternoon_free):
    """Four training days, then a validation day whose afternoon is a parameter."""
    for d in range(5, 1, -1):
        for slot in range(0, 288, 3):
            ts = START - d * 86400 + slot * 300 + 180
            _tick(conn, ts, [(l.id, (slot + i) % 7) for i, l in enumerate(LOTS)])
    for slot in range(0, 288, 3):
        ts = START - 86400 + slot * 300 + 180
        morning = slot < 144
        _tick(conn, ts, [(l.id, (slot + i) % 7 if morning else afternoon_free)
                         for i, l in enumerate(LOTS)])


def _morning_scores(conn):
    from parkcast.evaluate import load_labels, reading_series

    labels = load_labels(conn, None, city="taipei")
    _, val_start, _ = train.validation_window(DAY)
    origins = [t for t in train.sample_origins(labels)
               if val_start <= t < val_start + 10 * 3600]
    assert origins, "the fixture produced no morning origins to score"
    return train.score_at_origins(
        conn, None, city="taipei", lots=LOTS, origins=origins, horizons=[15],
        labels=labels, series=reading_series(labels))


def test_scoring_an_origin_never_sees_later_readings_from_the_same_day(tmp_path):
    """The defect the first real run against live data exposed.

    The gate scored every forecaster from ONE history cut at the end of the
    validation day -- so every label being scored was already inside the
    history doing the scoring. `evaluate.backtest` has always cut per origin;
    this did not.

    It showed up as an inverted result rather than an error. Climatology had
    counted the outcomes it was graded on and came out at 0.0263 where the
    recorded citywide run had it at 0.0680; persistence answered every origin
    from one end-of-day reading and came out at 0.0654 against a recorded
    0.0557; and blend, which mixes them, landed worse than climatology alone --
    the reverse of every run on record. The candidate, whose climatology
    feature carried the same leak, beat all three.

    Two corpora identical all morning and different all afternoon. Scored on
    morning origins only, the answers must be identical: nothing after an
    origin may reach the forecaster answering it.
    """
    honest = store.connect(tmp_path / "a.sqlite")
    honest.execute("PRAGMA synchronous=OFF")
    _corpus(honest, afternoon_free=0)

    tempted = store.connect(tmp_path / "b.sqlite")
    tempted.execute("PRAGMA synchronous=OFF")
    _corpus(tempted, afternoon_free=9)

    a, b = _morning_scores(honest), _morning_scores(tempted)
    honest.close()
    tempted.close()

    assert a["rows"] == b["rows"], "the morning is identical, so the row count must be"
    for name in ("persistence", "climatology", "blend"):
        assert a[name] == b[name], f"{name} saw the afternoon"


def test_a_real_fit_is_scored_honestly_whichever_way_it_goes(conn, tmp_path):
    """The honest path, with no forced scores and no assertion about who wins.

    It asserts only that every forecaster was measured on the same rows and
    that the verdict follows from those numbers. Asserting the candidate wins
    would mean tuning the fixture until it did -- and on this one it does not:
    persistence is strong on an autocorrelated series, exactly as
    `docs/state-of-play.md` warned, and six synthetic lots over six days is not
    a corpus a gradient-boosted model can beat it on.

    That it loses here is the test working. The leaky version of this gate had
    the candidate winning on the same fixture.
    """
    fill(conn)

    decision = run(conn, tmp_path)
    scores = decision.scores

    assert scores["rows"] > 0
    for name in ("candidate", "persistence", "climatology", "blend"):
        assert scores[name] is not None, f"{name} scored nothing"
        assert 0.0 <= scores[name] <= 1.0

    beats_both = (scores["candidate"] < scores["persistence"]
                  and scores["candidate"] < scores["climatology"])
    assert decision.adopted == beats_both, decision.reason
    assert decision.adopted == (tmp_path / "models" / "current.txt").exists()


def test_a_candidate_that_loses_to_blend_is_not_adopted(conn, tmp_path):
    """Blend is what actually ships, so it is the bar -- not persistence and
    climatology, which are only its components.

    The first honest run against live data found this hole. The candidate beat
    persistence by +12.9% and climatology by +15.9%, so the gate adopted it --
    while sitting 16.2% WORSE than the blend already serving every visitor.
    Beating the parts is not beating the whole: a blend routinely beats both
    its components, which is the entire reason it is what ships.
    """
    fill(conn)

    decision = run(conn, tmp_path, _force_scores={
        "candidate": 0.0348, "persistence": 0.0400,
        "climatology": 0.0414, "blend": 0.0299, "incumbent": None,
    })

    assert not decision.adopted
    assert "blend" in decision.reason
    assert not (tmp_path / "models" / "current.txt").exists()


def test_a_candidate_that_beats_blend_is_adopted(conn, tmp_path):
    """The same bar, cleared."""
    fill(conn)

    decision = run(conn, tmp_path, _force_scores={
        "candidate": 0.0250, "persistence": 0.0400,
        "climatology": 0.0414, "blend": 0.0299, "incumbent": None,
    })

    assert decision.adopted, decision.reason
