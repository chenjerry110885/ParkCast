"""Scoring the trained model alongside the three baselines.

This is what turns "we don't know" into a deploy decision. The nightly gate
computes one citywide Brier, which is the number `evaluate.py`'s second refusal
exists to reject -- ~85-90% of lots have a space at any moment, so the aggregate
is dominated by easy cases. The tables in `evaluate-forecast.py` already break
out the hard subset, every horizon and the calibration bands; wiring the trained
model into them is how those tables start covering it too.

The load-bearing test here is the cutoff guard. A model trained through T scored
at an origin before T is scored on its own training data, and it would come back
looking extraordinary.
"""
import numpy as np
import pytest

from parkcast import features, store, train
from parkcast.evaluate import backtest
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.metadata import Lot

ORIGIN = 1_700_000_000 - 1_700_000_000 % 300
SLOT = 300


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    c.execute("PRAGMA synchronous=OFF")
    yield c
    c.close()


def lot(lot_id="taipei:A"):
    return Lot(id=lot_id, name="n", area="大安區", lot_type="平面", capacity_car=50,
               lat=25.03, lon=121.54, service_time="", fare_text="每小時30元")


LOTS = [lot()]


def write(conn, ts, free=5):
    store.insert_snapshot(
        conn, FeedSnapshot("taipei", ts + 5,
                           (Observation("taipei:A", free, None, ts, TS_FEED),)),
        {"taipei:A": 50})


def corpus(conn, *, spans=80):
    for i in range(spans, -1, -1):
        write(conn, ORIGIN - i * SLOT, free=i % 7)
    for i in range(1, 12):
        write(conn, ORIGIN + i * SLOT, free=i % 5)


def model_at(tmp_path, trained_through):
    """A real model file, trained through `trained_through`."""
    rng = np.random.default_rng(0)
    x = rng.normal(size=(400, len(features.FEATURES))).astype(np.float32)
    y = (x[:, 0] + rng.normal(scale=0.5, size=400) > 0).astype(np.int8)
    out = tmp_path / "models" / "taipei"
    train.save(train.fit(x, y), out, trained_through=trained_through,
               feature_order=features.FEATURES, scores={})
    return out


def run(conn, **kw):
    return backtest(conn, cold_dir=None, city="taipei", horizons=[15], **kw)


# --- the trained model joins the table --------------------------------------


def test_the_trained_model_is_scored_beside_the_baselines(conn, tmp_path):
    corpus(conn)
    models = model_at(tmp_path, ORIGIN - 60 * SLOT)

    result = run(conn, origins=[ORIGIN], model_dir=models, lots=LOTS,
                 now=ORIGIN + 86400)

    assert "trained" in result.by_model
    assert result.by_model["trained"], "the trained model scored nothing"


def test_without_a_model_there_is_no_trained_row_at_all(conn):
    """An absent model must not appear as an empty row. A table that prints
    `--` for a forecaster nobody ran reads as a forecaster that had nothing to
    say, which is a different claim."""
    corpus(conn)

    result = run(conn, origins=[ORIGIN])

    assert "trained" not in result.by_model
    assert set(result.by_model) == {"persistence", "climatology", "blend"}


def test_every_forecaster_including_the_trained_one_scores_the_same_rows(conn, tmp_path):
    """The property the whole module exists to protect: they differ in what they
    do with the data, never in which data they got."""
    corpus(conn)
    models = model_at(tmp_path, ORIGIN - 60 * SLOT)

    result = run(conn, origins=[ORIGIN], model_dir=models, lots=LOTS,
                 now=ORIGIN + 86400)

    counts = {name: len(preds) for name, preds in result.by_model.items()}
    assert len(set(counts.values())) == 1, counts


# --- the cutoff guard -------------------------------------------------------


def test_an_origin_before_the_training_cutoff_is_not_scored(conn, tmp_path):
    """A model trained through T scored at an origin before T is scored on its
    own training data, and would come back looking extraordinary. Every origin
    here precedes the cutoff, so there is nothing honest to report."""
    corpus(conn)
    models = model_at(tmp_path, ORIGIN + 10 * SLOT)      # cutoff after every origin

    result = run(conn, origins=[ORIGIN - 4 * SLOT, ORIGIN], model_dir=models,
                 lots=LOTS, now=ORIGIN + 86400)

    assert result.by_model.get("trained", []) == []
    assert result.origins_before_cutoff == 2


def test_the_baselines_are_dropped_with_it_rather_than_scored_alone(conn, tmp_path):
    """Dropping only the trained model would leave the baselines scored on
    origins it never saw, and every comparison in the report would be between
    different samples."""
    corpus(conn)
    models = model_at(tmp_path, ORIGIN + 10 * SLOT)

    result = run(conn, origins=[ORIGIN - 4 * SLOT, ORIGIN], model_dir=models,
                 lots=LOTS, now=ORIGIN + 86400)

    assert result.origins == []
    assert result.by_model["blend"] == []


def test_an_origin_after_the_cutoff_is_scored(conn, tmp_path):
    corpus(conn)
    models = model_at(tmp_path, ORIGIN - 60 * SLOT)

    result = run(conn, origins=[ORIGIN], model_dir=models, lots=LOTS,
                 now=ORIGIN + 86400)

    assert result.origins == [ORIGIN]
    assert result.origins_before_cutoff == 0


def test_how_many_origins_the_cutoff_cost_is_reported(conn, tmp_path):
    """Silently shrinking the test period would make a report about a shorter
    span than its header claims."""
    corpus(conn)
    models = model_at(tmp_path, ORIGIN - 2 * SLOT)

    result = run(conn, origins=[ORIGIN - 6 * SLOT, ORIGIN - 4 * SLOT, ORIGIN],
                 model_dir=models, lots=LOTS, now=ORIGIN + 86400)

    assert result.origins == [ORIGIN]
    assert result.origins_before_cutoff == 2


def test_a_model_that_will_not_load_leaves_the_baselines_alone(conn, tmp_path):
    """An unreadable model must cost its own row, not the whole report."""
    corpus(conn)
    models = model_at(tmp_path, ORIGIN - 60 * SLOT)
    (models / "current.txt").write_text("tampered\n")

    result = run(conn, origins=[ORIGIN], model_dir=models, lots=LOTS,
                 now=ORIGIN + 86400)

    assert "trained" not in result.by_model
    assert result.by_model["blend"], "the baselines still have to be scored"
    assert result.origins == [ORIGIN], "no cutoff applies when no model loaded"
