"""Loading a model, and everything it must refuse.

This is the one file in the project written by a background job and read by the
collector, which makes what the loader accepts a security decision rather than
an ergonomic one. Every refusal below is silent and safe: `load` returns None,
the caller falls back to `Blend`, and the site keeps publishing. A model that
cannot be trusted must cost a worse forecast, never an outage.
"""
import json
import pickle

import numpy as np
import pytest

from parkcast import features, model, store, train
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.forecast import Climatology, load_history
from parkcast.metadata import Lot

NOW = 1_700_000_000
ORIGIN = NOW - NOW % 300


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    c.execute("PRAGMA synchronous=OFF")
    yield c
    c.close()


def lot(lot_id="taipei:A"):
    return Lot(id=lot_id, name="n", area="大安區", lot_type="平面", capacity_car=50,
               lat=25.03, lon=121.54, service_time="", fare_text="每小時30元")


@pytest.fixture
def model_dir(tmp_path):
    """A real, freshly-trained model on disk."""
    rng = np.random.default_rng(0)
    x = rng.normal(size=(400, len(features.FEATURES))).astype(np.float32)
    y = (x[:, 0] + rng.normal(scale=0.5, size=400) > 0).astype(np.int8)
    out = tmp_path / "models"
    train.save(train.fit(x, y), out, trained_through=NOW - 86400,
               feature_order=features.FEATURES, scores={})
    return out


def rewrite_manifest(model_dir, **changes):
    path = model_dir / "manifest.json"
    data = json.loads(path.read_text())
    data.update(changes)
    path.write_text(json.dumps(data))


# --- what loads -------------------------------------------------------------


def test_a_well_formed_model_loads(model_dir):
    assert model.load(model_dir, now=NOW) is not None


# --- what does not ----------------------------------------------------------


def test_a_tampered_model_is_refused(model_dir):
    """The digest is the difference between serving a substituted model and
    noticing one. Appending a line is the mildest possible tamper and still has
    to fail."""
    current = model_dir / "current.txt"
    current.write_text(current.read_text() + "\n")

    assert model.load(model_dir, now=NOW) is None


def test_a_pickle_is_never_loaded(model_dir):
    """pickle and joblib deserialise to arbitrary code. This file is written by
    a background job and read by the collector, so its format is a
    code-execution decision -- pinned by a test rather than by intent.

    The manifest is rewritten to match, so the digest alone would pass: the
    header check is what refuses it.
    """
    payload = pickle.dumps({"anything": "at all"})
    (model_dir / "current.txt").write_bytes(payload)
    import hashlib
    rewrite_manifest(model_dir, sha256=hashlib.sha256(payload).hexdigest())

    assert model.load(model_dir, now=NOW) is None


def test_a_missing_model_is_not_an_error(tmp_path):
    """A collector starting before the first nightly fit is the normal case,
    not a failure."""
    assert model.load(tmp_path / "nothing", now=NOW) is None


def test_a_model_with_no_manifest_is_refused(model_dir):
    (model_dir / "manifest.json").unlink()
    assert model.load(model_dir, now=NOW) is None


def test_a_truncated_manifest_is_refused(model_dir):
    (model_dir / "manifest.json").write_text('{"sha256": "abc"')
    assert model.load(model_dir, now=NOW) is None


def test_a_model_past_the_staleness_bound_is_refused(model_dir):
    """A trainer dead for a fortnight should stop serving. Fourteen days is
    longer than the longest intentional pause -- the collector is paused while
    the machine is gaming -- and far shorter than a season."""
    rewrite_manifest(model_dir, trained_through=NOW - model.STALE_AFTER_SEC - 1)

    assert model.load(model_dir, now=NOW) is None


def test_a_model_just_inside_the_staleness_bound_still_serves(model_dir):
    rewrite_manifest(model_dir, trained_through=NOW - model.STALE_AFTER_SEC + 60)

    assert model.load(model_dir, now=NOW) is not None


def test_a_feature_order_mismatch_is_refused(model_dir):
    """The worst failure available: every value fed to the wrong split, and
    plausible probabilities out the other side."""
    rewrite_manifest(model_dir, features=list(reversed(features.FEATURES)))

    assert model.load(model_dir, now=NOW) is None


def test_a_manifest_naming_fewer_features_is_refused(model_dir):
    rewrite_manifest(model_dir, features=list(features.FEATURES[:-1]))

    assert model.load(model_dir, now=NOW) is None


def test_garbage_in_the_model_file_is_refused_rather_than_raised(model_dir):
    """Whatever LightGBM's parser does with nonsense, the collector must
    survive it: the fallback is a worse forecast, never an outage."""
    import hashlib
    payload = b"tree\nnot actually a model at all\n"
    (model_dir / "current.txt").write_bytes(payload)
    rewrite_manifest(model_dir, sha256=hashlib.sha256(payload).hexdigest())

    assert model.load(model_dir, now=NOW) is None


# --- predicting -------------------------------------------------------------


def write(conn, ts, lot_id="taipei:A", free=5):
    store.insert_snapshot(
        conn, FeedSnapshot("taipei", ts + 5, (Observation(lot_id, free, None, ts, TS_FEED),)),
        {lot_id: 50})


def trained(conn, model_dir, **kw):
    history = load_history(conn)
    return model.Trained(history, model_dir=model_dir, lots={"taipei:A": lot()},
                         clim=Climatology(history), now=NOW, **kw)


def test_a_probability_comes_back_in_range(conn, model_dir):
    for i in range(24, -1, -1):
        write(conn, ORIGIN - i * 300, free=i % 7)

    p = trained(conn, model_dir).predict("taipei:A", ORIGIN + 900, 15)
    assert p is not None and 0.0 <= p <= 1.0


def test_a_lot_with_no_basis_gets_none_not_a_number(conn, model_dir):
    """`0%` and `no data` are different statements, and the grid writes UNKNOWN
    for the second.

    "No basis" is narrower than it first looks, and the test that assumed
    otherwise was wrong rather than the code. `Climatology` shrinks through
    lot and then global, with a Jeffreys prior at the top, so on any non-empty
    corpus it answers for a lot it has never seen -- deliberately, because the
    fallback chain is continuous rather than a cliff. So the only state with no
    basis at all is one where climatology itself has nothing, and that is
    exactly where `Blend` goes silent too.
    """
    history = load_history(conn)                      # nothing written at all
    assert Climatology(history).predict("taipei:A", ORIGIN + 900, 15) is None

    assert trained(conn, model_dir).predict("taipei:A", ORIGIN + 900, 15) is None


def test_the_trained_model_is_silent_exactly_where_blend_is(conn, model_dir):
    """The invariant behind the test above, stated directly: a fourth
    forecaster must not disagree with the other three about when there is
    nothing to say. If it answered where `Blend` does not, the app would
    publish a number for a lot it has no evidence about."""
    from parkcast.forecast import Blend

    empty = load_history(conn)
    assert Blend(empty).predict("taipei:A", ORIGIN + 900, 15) is None
    assert trained(conn, model_dir).predict("taipei:A", ORIGIN + 900, 15) is None

    for i in range(24, -1, -1):
        write(conn, ORIGIN - i * 300, free=i % 7)
    filled = load_history(conn)
    assert Blend(filled).predict("taipei:A", ORIGIN + 900, 15) is not None
    assert trained(conn, model_dir).predict("taipei:A", ORIGIN + 900, 15) is not None


def test_an_unknown_lot_gets_none(conn, model_dir):
    """A lot the roster does not describe has no features to build a row from."""
    for i in range(24, -1, -1):
        write(conn, ORIGIN - i * 300, free=i % 7)

    assert trained(conn, model_dir).predict("taipei:NOPE", ORIGIN + 900, 15) is None


def test_an_unavailable_model_says_so_rather_than_answering_none(conn, tmp_path):
    """The caller has to tell "the model has nothing to say about this lot" from
    "there is no model", because the second means fall back to Blend for
    everything and the first does not."""
    for i in range(24, -1, -1):
        write(conn, ORIGIN - i * 300, free=i % 7)
    absent = trained(conn, tmp_path / "nothing")

    assert absent.available is False
    assert absent.predict("taipei:A", ORIGIN + 900, 15) is None


def test_an_available_model_says_so(conn, model_dir):
    write(conn, ORIGIN, free=5)
    assert trained(conn, model_dir).available is True


def test_untrusted_bytes_never_reach_the_deserialiser(model_dir, monkeypatch):
    """Not merely that a pickle is refused -- LightGBM's parser refuses it too,
    by failing -- but that it is refused BEFORE anything tries to parse it.

    That distinction is the whole point of a format check, and mutation testing
    found the gap: deleting the header check broke nothing, because the pickle
    still failed one layer down. It was being caught by the thing it is meant
    never to reach.

    A flag rather than a raising sentinel, because `load` catches `Exception`
    by design -- so a sentinel that raised would be swallowed and the test would
    pass for a third wrong reason.
    """
    import hashlib

    payload = pickle.dumps({"anything": "at all"})
    (model_dir / "current.txt").write_bytes(payload)
    rewrite_manifest(model_dir, sha256=hashlib.sha256(payload).hexdigest())

    reached = []
    monkeypatch.setattr(model.lgb, "Booster", lambda *a, **k: reached.append(a))

    assert model.load(model_dir, now=NOW) is None
    assert reached == [], "the loader handed untrusted bytes to LightGBM"
