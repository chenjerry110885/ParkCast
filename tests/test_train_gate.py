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


def test_a_first_model_is_adopted_when_it_clears_the_baselines(conn, tmp_path):
    fill(conn)

    decision = run(conn, tmp_path)

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
    run(conn, tmp_path)                                   # adopt a first model
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

    decision = run(conn, tmp_path)

    assert decision.adopted
    assert decision.digest == train.manifest(tmp_path / "models")["sha256"]


def test_the_written_model_was_trained_through_the_validated_cutoff(conn, tmp_path):
    fill(conn)
    cutoff, _, _ = train.validation_window(DAY)

    run(conn, tmp_path)

    assert train.manifest(tmp_path / "models")["trained_through"] == cutoff


# --- visibility -------------------------------------------------------------


def test_every_decision_is_recorded_where_the_report_can_read_it(conn, tmp_path):
    """A run of rejections is itself a signal. A log line nobody reads is not
    where it belongs."""
    fill(conn)
    run(conn, tmp_path)
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
