"""Fitting and saving a model, and the three properties that make it safe to load.

Determinism, because the backtest claims to reconstruct the model as it would
have been at a past origin and cannot if a fit varies run to run. The digest,
because this file is written by a background job and read by the collector.
And the atomic write, because a reader must never see half a model.
"""
import hashlib
import json

import numpy as np
import pytest

from parkcast import features, train


def rows(n=400, seed=0):
    """Labelled rows with a real signal, and a missing value in every column."""
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, len(features.FEATURES))).astype(np.float32)
    x[rng.integers(0, n, n // 10), rng.integers(0, x.shape[1], n // 10)] = np.nan
    y = (x[:, 0] + rng.normal(scale=0.5, size=n) > 0).astype(np.int8)
    return x, y


# --- determinism ------------------------------------------------------------


def test_two_fits_on_the_same_data_are_byte_identical():
    """Without this the backtest is meaningless. It claims to rebuild the model
    as it would have been at origin T, and a fit that varies between runs cannot
    be rebuilt -- every skill number would carry noise nobody could bound.

    Multi-threaded histogram construction is the known source, which is why
    `num_threads` is pinned to 1 and not merely left at a default.
    """
    x, y = rows()

    assert train.fit(x, y).model_to_string() == train.fit(x, y).model_to_string()


def test_the_pinned_parameters_are_the_ones_determinism_needs():
    """Named individually so that dropping one is a failing test rather than a
    quietly noisier model."""
    assert train.PARAMS["deterministic"] is True
    assert train.PARAMS["force_row_wise"] is True
    assert train.PARAMS["num_threads"] == 1
    assert isinstance(train.PARAMS["seed"], int)
    assert train.PARAMS["objective"] == "binary"


def test_a_different_seed_is_still_reproducible():
    """Pinning the seed is not the same as pinning one value of it."""
    x, y = rows()
    other = dict(train.PARAMS, seed=train.PARAMS["seed"] + 1)

    assert (train.fit(x, y, params=other).model_to_string()
            == train.fit(x, y, params=other).model_to_string())


# --- turning rows into arrays -----------------------------------------------


def test_an_unlabelled_row_is_not_trained_on():
    """Serving rows have no label by definition, and a missed slot leaves some
    training rows without one. Neither can be an example."""
    from parkcast.trainset import Row

    x, y = train.to_arrays([
        Row([1.0] * len(features.FEATURES), 1, "taipei:A", 0, 15),
        Row([2.0] * len(features.FEATURES), None, "taipei:A", 0, 30),
        Row([3.0] * len(features.FEATURES), 0, "taipei:A", 0, 60),
    ])

    assert x.shape == (2, len(features.FEATURES))
    assert list(y) == [1, 0]


def test_a_missing_feature_stays_missing_rather_than_becoming_zero():
    """LightGBM reads NaN as absent and learns what absence means. 0.0 would
    say a lot has no spaces, or costs nothing, depending on the column."""
    from parkcast.trainset import Row

    values = [None] * len(features.FEATURES)
    x, _ = train.to_arrays([Row(values, 1, "taipei:A", 0, 15)])

    assert np.isnan(x).all()


def test_the_arrays_are_float32_not_float64():
    """459 MB against 918 MB for a real training set, for a feature set whose
    precision is minutes and counts."""
    from parkcast.trainset import Row

    x, _ = train.to_arrays([Row([1.0] * len(features.FEATURES), 1, "taipei:A", 0, 15)])
    assert x.dtype == np.float32


# --- saving -----------------------------------------------------------------


def saved(tmp_path, **kw):
    x, y = rows()
    return train.save(train.fit(x, y), tmp_path,
                      **{"trained_through": 1_700_000_000,
                         "feature_order": features.FEATURES, "scores": {"brier": 0.04}, **kw})


def test_the_manifest_digest_matches_the_model_on_disk(tmp_path):
    """The difference between serving a corrupted or substituted model and
    noticing one."""
    path = saved(tmp_path)

    recorded = json.loads((tmp_path / "manifest.json").read_text())["sha256"]
    assert recorded == hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_manifest_records_the_feature_order(tmp_path):
    """A model whose feature order differs from the caller's would feed every
    value to the wrong split and still return plausible probabilities."""
    saved(tmp_path)

    assert train.manifest(tmp_path)["features"] == list(features.FEATURES)


def test_the_manifest_records_what_the_model_was_trained_through(tmp_path):
    """`model.load` refuses one older than the staleness bound, so the date has
    to survive alongside the bytes."""
    saved(tmp_path, trained_through=1_699_999_999)

    assert train.manifest(tmp_path)["trained_through"] == 1_699_999_999


def test_the_model_is_never_a_pickle(tmp_path):
    """pickle and joblib deserialise to arbitrary code, and this file is written
    by a background job and read by the collector, so its format is a
    code-execution decision. LightGBM's own text dump has no executable content.
    """
    path = saved(tmp_path)
    head = path.read_bytes()[:64]

    assert head.startswith(b"tree"), head[:16]
    assert b"__reduce__" not in path.read_bytes()


def test_a_failed_write_leaves_the_previous_model_serving(tmp_path, monkeypatch):
    """A reader must never see half a model, and a crash must not cost the one
    that was working."""
    first = saved(tmp_path)
    before = first.read_bytes()

    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(train.Path, "replace", boom)
    with pytest.raises(OSError):
        saved(tmp_path, trained_through=1_700_009_999)

    assert first.read_bytes() == before
    assert train.manifest(tmp_path)["trained_through"] == 1_700_000_000


def test_no_temporary_file_is_left_behind(tmp_path):
    saved(tmp_path)

    assert [p.name for p in tmp_path.iterdir() if p.suffix == ".tmp"] == []


def test_the_previous_models_are_kept_for_rollback(tmp_path):
    for i in range(3):
        saved(tmp_path, trained_through=1_700_000_000 + i * 86400)

    kept = sorted(p.name for p in (tmp_path / "history").glob("*.txt"))
    assert kept == ["1700000000.txt", "1700086400.txt"], kept


def test_only_the_last_seven_are_kept(tmp_path):
    """A rollback reaches back a week; keeping every model would grow without
    bound beside a corpus measured in tens of megabytes."""
    for i in range(10):
        saved(tmp_path, trained_through=1_700_000_000 + i * 86400)

    assert len(list((tmp_path / "history").glob("*.txt"))) == train.KEEP_MODELS


# --- weights and column subsets ---------------------------------------------


def _constant(n_neg=200, n_pos=200, width=None):
    """No feature carries any signal, so the fitted model can only predict its
    starting point: the (weighted) share of positives."""
    width = len(features.FEATURES) if width is None else width
    x = np.zeros((n_neg + n_pos, width), dtype=np.float32)
    y = np.array([0] * n_neg + [1] * n_pos, dtype=np.int8)
    return x, y


def test_fit_weighs_each_row_by_the_weight_it_is_given():
    """Weight 3 on every positive is three times as many positives: the share
    moves from 1/2 to 3/4. A `weight` that never reached LightGBM would leave
    it at 1/2 and every weighted variant in the ablation would be a copy of
    the unweighted one."""
    x, y = _constant()
    plain = train.fit(x, y, num_rounds=5)
    weighted = train.fit(x, y, num_rounds=5, weight=np.where(y == 1, 3.0, 1.0))

    assert plain.predict(x[:1])[0] == pytest.approx(0.5, abs=1e-3)
    assert weighted.predict(x[:1])[0] == pytest.approx(0.75, abs=1e-3)


def test_fit_takes_a_named_subset_of_the_columns():
    """The ablation's `base` variant is the first 26 columns: the ones every
    earlier model was fitted on. The categoricals it names must be the ones
    that subset actually has."""
    names = list(features.FEATURES[:26])
    x, y = _constant(width=len(names))
    booster = train.fit(x, y, num_rounds=5, feature_names=names)

    assert booster.feature_name() == names
