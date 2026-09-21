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
import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import lightgbm as lgb
import numpy as np

from parkcast import features
from parkcast.compact import day_bounds

log = logging.getLogger(__name__)
from parkcast.trainset import Row, iter_rows, sample_origins

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


# --- the adoption gate ------------------------------------------------------
#
# A model that retrains itself nightly can degrade itself nightly, unattended,
# with every log staying green. This is the only thing standing between that
# and the published grid, and it is allowed to say no.


@dataclass(frozen=True)
class Decision:
    adopted: bool
    reason: str
    scores: dict
    #: The digest of what was written, so a caller can prove the artifact it
    #: validated is the artifact that shipped. None when nothing was written.
    digest: str | None = None


#: Minimum labelled rows before a fit is attempted at all. Below this the
#: honest outcome is "not enough corpus", which must not be mistaken for a
#: rejection on merit -- see `Decision.reason`.
MIN_TRAIN_ROWS = 5_000


def brier(probabilities: Sequence[float], labels: Sequence[int]) -> float | None:
    """Mean squared error. None for an empty set, never 0.0.

    An unmeasured gate and a perfect one must not print the same number -- the
    same distinction `evaluate.brier` makes, for the same reason.
    """
    if not probabilities:
        return None
    return sum((p - y) ** 2 for p, y in zip(probabilities, labels)) / len(probabilities)


def validation_window(day: date) -> tuple[int, int, int]:
    """`(train_cutoff, validation_start, validation_end)` for serving `day`.

    Training stops at the start of the previous day and validation runs over
    that whole day, so the candidate is scored on 24 hours it has never seen.

    This ships a model one day staler than it could be. The alternative --
    validate one fit, then refit on everything and ship that -- ships a model
    nobody ever scored. Freshness comes from the features, which are seconds
    old, not from the weights, so the stale day costs almost nothing and never
    shipping an unvalidated artifact is worth more.
    """
    start, _ = day_bounds(day)
    return start - 86400, start - 86400, start


def _scored(forecaster, rows: Sequence[Row]) -> tuple[list[float], list[int]]:
    """One forecaster's answers over exactly the rows every other one gets."""
    probabilities, labels = [], []
    for row in rows:
        p = forecaster.predict(row.lot_id, row.origin_ts + row.horizon_min * 60,
                               row.horizon_min)
        if p is None:
            continue
        probabilities.append(p)
        labels.append(row.label)
    return probabilities, labels


def _candidate_brier(booster, rows: Sequence[Row]) -> float | None:
    if not rows:
        return None
    x = np.array([[np.nan if v is None else v for v in r.values] for r in rows],
                 dtype=np.float32)
    return brier(list(booster.predict(x)), [r.label for r in rows])


def _verdict(scores: dict, *, beat_baselines: bool) -> str | None:
    """Why the candidate is refused, or None to adopt it."""
    candidate = scores["candidate"]
    if candidate is None:
        return "the candidate scored no predictions on the validation day"
    incumbent = scores.get("incumbent")
    if incumbent is not None and candidate > incumbent:
        return f"worse than the incumbent ({candidate:.4f} against {incumbent:.4f})"
    if not beat_baselines:
        return None
    for name in ("persistence", "climatology"):
        reference = scores.get(name)
        if reference is not None and candidate >= reference:
            return f"does not beat {name} ({candidate:.4f} against {reference:.4f})"
    return None


def _record(model_dir: Path, day: date, decision: Decision) -> Decision:
    """Append the decision where `report.py` can find it.

    A run of consecutive rejections is itself a signal, and a log line nobody
    reads is not where it belongs.
    """
    model_dir.mkdir(parents=True, exist_ok=True)
    with (model_dir / "decisions.jsonl").open("a", encoding="utf-8") as out:
        out.write(json.dumps({
            "day": day.isoformat(),
            "adopted": decision.adopted,
            "reason": decision.reason,
            "scores": decision.scores,
        }) + "\n")
    return decision


def nightly(
    conn,
    cold_dir,
    *,
    city: str,
    day: date,
    model_dir,
    lots: Sequence,
    horizons: Sequence[int] = (5, 15, 30, 60, 120),
    beat_baselines: bool = True,
    now: int | None = None,
    _force_scores: dict | None = None,
) -> Decision:
    """Fit a candidate, score it on a day it has never seen, adopt it or not.

    Adopted only when it is no worse than the incumbent AND beats both
    `Persistence` and `Climatology` -- the two the spec gates on. Beating the
    incumbent alone is not enough if both have drifted below the baselines.

    Nothing is written unless the candidate is adopted, and what is written is
    the object that was scored: there is no refit between the two.

    `_force_scores` exists for the tests, which need to drive the decision
    without constructing six plausible corpora. It replaces the measured scores
    and nothing else -- the fit, the write and the bookkeeping all still happen
    exactly as they would.
    """
    from parkcast import model as model_module
    from parkcast.evaluate import load_labels, reading_series
    from parkcast.forecast import Blend, Climatology, Persistence, by_city, load_history

    model_dir = Path(model_dir)
    cutoff, val_start, val_end = validation_window(day)

    labels = load_labels(conn, cold_dir, city=city)
    series = reading_series(labels)

    train_history = by_city(load_history(conn, cold_dir=cold_dir, before_ts=cutoff)).get(city)
    if train_history is None:
        return _record(model_dir, day, Decision(False, "no history for this city", {}))

    train_clim = Climatology(train_history)
    train_origins = [t for t in sample_origins(labels) if t < cutoff]
    x, y = to_arrays(iter_rows(train_history, train_clim, lots, origins=train_origins,
                               horizons=horizons, labels=labels, reading_series=series))
    if len(y) < MIN_TRAIN_ROWS:
        return _record(model_dir, day, Decision(
            False, f"only {len(y)} labelled rows, below the {MIN_TRAIN_ROWS} floor", {}))

    candidate = fit(x, y)

    # Validation: one history for every forecaster, cut at the end of the day
    # the candidate did NOT train on, so they all answer from identical inputs.
    val_history = by_city(load_history(conn, cold_dir=cold_dir, before_ts=val_end)).get(city)
    val_clim = Climatology(val_history)
    val_origins = [t for t in sample_origins(labels) if val_start <= t < val_end]
    val_rows = [r for r in iter_rows(val_history, val_clim, lots, origins=val_origins,
                                     horizons=horizons, labels=labels, reading_series=series)
                if r.label is not None]

    roster = {l.id: l for l in lots}
    incumbent = model_module.Trained(val_history, model_dir=model_dir, lots=roster,
                                     clim=val_clim, now=now)
    scores = {
        "candidate": _candidate_brier(candidate, val_rows),
        "persistence": brier(*_scored(Persistence(val_history), val_rows)),
        "climatology": brier(*_scored(Climatology(val_history), val_rows)),
        "blend": brier(*_scored(Blend(val_history), val_rows)),
        "incumbent": brier(*_scored(incumbent, val_rows)) if incumbent.available else None,
        "rows": len(val_rows),
    }
    if _force_scores is not None:
        scores.update(_force_scores)

    verdict = _verdict(scores, beat_baselines=beat_baselines)
    if verdict is not None:
        return _record(model_dir, day, Decision(False, verdict, scores))

    path = save(candidate, model_dir, trained_through=cutoff,
                feature_order=features.FEATURES, scores=scores)
    return _record(model_dir, day, Decision(
        True, "beat the incumbent and both baselines", scores,
        digest=hashlib.sha256(path.read_bytes()).hexdigest()))


# --- the nightly entry point ------------------------------------------------


def latest_roster(meta_dir: Path, *, before_ts: int, city: str = "taipei") -> tuple:
    """The newest dated metadata snapshot at or before `before_ts`.

    Capacity and lot membership change over time, which is why
    `metadata.snapshot_metadata` writes one raw payload per day. Training rows
    from three weeks ago should be joined against the roster as it was then,
    not as it is now -- using today's would be a mild look-ahead, and would
    describe a lot that has since left the feed as though it were still there.

    Only Taipei has this history: `snapshot_metadata` is called once, on
    `config.METADATA_URL`, and the other five cities carry their rosters in the
    tick and never write them dated. That is why Stage B ships Taipei first;
    see the spec's risks.
    """
    from parkcast.metadata import parse_metadata

    best = None
    for path in sorted(Path(meta_dir).glob("*.json")):
        try:
            day = date.fromisoformat(path.stem)
        except ValueError:
            continue
        if day_bounds(day)[0] <= before_ts:
            best = path
    if best is None:
        return ()
    return parse_metadata(json.loads(best.read_text(encoding="utf-8")), city)


def main(argv: Sequence[str] | None = None) -> int:
    """One night's work: fit, validate, adopt or decline.

    Runs in its own container with no network, the corpus mounted read-only and
    write access to nothing but the model directory. It is emphatically NOT run
    inside `scheduler.run_forever`: a fit there would eat the 300-second poll
    slot and, by the deadline logic, possibly the one after it -- trading
    collected data for a model trained on less of it. A crash here cannot stop
    collection, which is the property that matters most.
    """
    import argparse

    from parkcast import config, ids, store

    parser = argparse.ArgumentParser(description="Fit and gate one night's model.")
    parser.add_argument("--city", default=ids.LEGACY_CITY)
    parser.add_argument("--day", type=date.fromisoformat, default=None,
                        help="the day to serve; defaults to today in Taipei")
    parser.add_argument("--hot", default=str(config.DB_PATH))
    parser.add_argument("--cold", default=str(config.PARQUET_DIR))
    parser.add_argument("--models", default=str(config.DATA_DIR / "models"))
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    day = args.day or datetime.now(config.TAIPEI_TZ).date()
    cutoff, _, _ = validation_window(day)

    lots = latest_roster(Path(args.cold) / "meta", before_ts=cutoff, city=args.city)
    if not lots:
        log.error("no dated roster at or before %s for %s; nothing to train on",
                  cutoff, args.city)
        return 1

    conn = store.connect_readonly(args.hot)
    try:
        decision = nightly(conn, Path(args.cold), city=args.city, day=day,
                           model_dir=Path(args.models) / args.city, lots=list(lots))
    finally:
        conn.close()

    log.info("%s %s: %s | %s", day, args.city,
             "ADOPTED" if decision.adopted else "declined", decision.reason)
    # Zero either way. Declining is a normal outcome, not a failure, and a
    # non-zero exit would make a restart policy fight a healthy gate.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
