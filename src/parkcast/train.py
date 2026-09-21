"""Fit a model, and write it somewhere the collector can safely load it.

Three properties, each pinned by a test, each protecting something that fails
quietly rather than loudly.

**Determinism.** The backtest claims to reconstruct the model as it would have
been at a past origin. A fit that varies between runs cannot be reconstructed,
so every skill number would carry noise nobody could bound -- and nothing would
say so, because a slightly different model still returns probabilities between
0 and 1. LightGBM's multi-threaded histogram construction is the known source,
so `PARAMS` pins `num_threads: 1` alongside `deterministic` and
`force_row_wise`. The cost is wall-clock on a fit that already takes well under
a minute.

**A digest.** This file is written by a background job and read by the collector
at publish time, so a corrupted or substituted model would otherwise be served
as if it were the real one. The manifest carries a SHA-256 and `model.load`
checks it.

**An atomic write.** A reader must never see half a model, and a crash
mid-write must not cost the one that was working. Everything is written to a
temporary name in the same directory and renamed into place; the previous model
moves to `history/` first, so a rollback is a file copy.

And one thing this module never does: **pickle**. `pickle` and `joblib`
deserialise to arbitrary code, which makes the format of this particular file a
code-execution decision rather than a convenience. LightGBM's own text dump has
no executable content, and `test_the_model_is_never_a_pickle` keeps it that way.
"""
import hashlib
import json
from pathlib import Path
from typing import Iterable

import lightgbm as lgb
import numpy as np

from parkcast import features
from parkcast.trainset import Row

#: How many previous models stay on disk. A rollback reaches back about a week;
#: keeping every one would grow without bound beside a corpus measured in tens
#: of megabytes.
KEEP_MODELS = 7

#: Rows per block when streaming into the feature array. 65,536 x 26 float32 is
#: ~6.8 MB, small enough to be noise against the 934 MB total and large enough
#: that the per-block overhead disappears.
BLOCK = 1 << 16

PARAMS: dict = {
    "objective": "binary",
    "verbosity": -1,
    # The three that buy reproducibility. `deterministic` alone is not enough:
    # it constrains the algorithm, while threading decides the order floats are
    # summed in, and float addition is not associative.
    "deterministic": True,
    "force_row_wise": True,
    "num_threads": 1,
    "seed": 20260921,
    # Modest capacity on purpose. The corpus is weeks old, and `Blend` is
    # already strong; a model that overfits a thin corpus would pass a nightly
    # gate on the day it was fitted and fail the week after.
    "num_leaves": 31,
    "min_data_in_leaf": 200,
    "learning_rate": 0.05,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.9,
    "bagging_freq": 1,
}

NUM_ROUNDS = 300


def to_arrays(rows: Iterable[Row]) -> tuple[np.ndarray, np.ndarray]:
    """Labelled rows as a `float32` feature matrix and an `int8` label vector.

    Streamed in blocks rather than materialised: a real training set is
    4,414,560 rows, which is 3,844 MB as `Row` objects and 934 MB this way.

    `None` becomes `NaN`, which LightGBM reads as absent. It must not become
    `0.0` -- that would say a lot has no spaces, or costs nothing, or was last
    seen this instant, depending on the column.

    Unlabelled rows are dropped. Every serving row is unlabelled by definition,
    and a missed slot leaves some training rows without one; neither is an
    example of anything.
    """
    width = len(features.FEATURES)
    blocks: list[np.ndarray] = []
    labels: list[np.ndarray] = []
    block = np.empty((BLOCK, width), dtype=np.float32)
    label = np.empty(BLOCK, dtype=np.int8)
    filled = 0

    for row in rows:
        if row.label is None:
            continue
        block[filled] = [np.nan if v is None else v for v in row.values]
        label[filled] = row.label
        filled += 1
        if filled == BLOCK:
            blocks.append(block.copy())
            labels.append(label.copy())
            filled = 0

    blocks.append(block[:filled].copy())
    labels.append(label[:filled].copy())
    return np.concatenate(blocks), np.concatenate(labels)


def fit(x: np.ndarray, y: np.ndarray, *, params: dict | None = None,
        num_rounds: int = NUM_ROUNDS) -> lgb.Booster:
    """One booster, reproducibly.

    The categorical columns are named rather than positional so that reordering
    `features.FEATURES` cannot silently turn a district into a number line.
    """
    data = lgb.Dataset(
        x, label=y,
        feature_name=list(features.FEATURES),
        categorical_feature=list(features.CATEGORICAL),
        free_raw_data=False,
    )
    return lgb.train(params or PARAMS, data, num_boost_round=num_rounds)


def _write_atomically(path: Path, text: str) -> None:
    """Write via a temporary name in the same directory, then rename.

    Same directory because a rename is only atomic within a filesystem, and
    `/tmp` is frequently a different one.
    """
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def manifest(model_dir: Path) -> dict:
    """The live model's manifest, or `{}` when there is none."""
    path = Path(model_dir) / "manifest.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}          # a truncated manifest is no manifest


def save(
    booster: lgb.Booster,
    model_dir: Path,
    *,
    trained_through: int,
    feature_order: tuple[str, ...],
    scores: dict,
) -> Path:
    """Write the model and its manifest, keeping the previous one for rollback.

    The manifest is written after the model and read before it, so a crash
    between the two leaves a model no loader will accept rather than one it
    accepts wrongly. `trained_through` is the cutoff the model was fitted on --
    the boundary of the day before the one it will serve, per the adoption gate
    -- and `model.load` refuses anything older than its staleness bound.
    """
    model_dir = Path(model_dir)
    history = model_dir / "history"
    history.mkdir(parents=True, exist_ok=True)

    current = model_dir / "current.txt"
    previous = manifest(model_dir)
    if current.exists() and previous.get("trained_through") is not None:
        keep = history / f"{previous['trained_through']}.txt"
        keep.write_bytes(current.read_bytes())
        (history / f"{previous['trained_through']}.json").write_text(
            json.dumps(previous, indent=2), encoding="utf-8")

    text = booster.model_to_string()
    _write_atomically(current, text)
    _write_atomically(model_dir / "manifest.json", json.dumps({
        "trained_through": trained_through,
        "features": list(feature_order),
        "sha256": hashlib.sha256(current.read_bytes()).hexdigest(),
        "scores": scores,
        "params": {k: v for k, v in PARAMS.items() if k != "verbosity"},
        "num_rounds": NUM_ROUNDS,
    }, indent=2))

    for old in sorted(history.glob("*.txt"))[:-KEEP_MODELS]:
        old.unlink()
        old.with_suffix(".json").unlink(missing_ok=True)
    return current
