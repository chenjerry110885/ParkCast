"""Backtest the forecasters against what actually happened.

This is the section of the spec that decides whether the project has a claim to
make. Everything else measures the *system*; this measures the *forecast*.

What it does
------------
For each origin timestamp it rebuilds the forecasters from
`load_history(conn, before_ts=origin + 1)` -- the train/test contract in
`forecast.py` -- and scores their predictions against observations strictly
later than that cutoff. Walking the origins forward lets climatology grow the
way it does in production, and no forecaster ever counts a reading it is about
to be scored on.

Three things it refuses to do, each because the number would otherwise flatter
itself:

1. **No random splits.** Origins advance through time. A random split leaks the
   future backwards through climatology's counts, which are an aggregate over
   the whole corpus.
2. **No citywide-only headline.** ~85-90% of lots have a space at any moment, so
   "always yes" scores well. `hard_subset` restricts to lots that actually fill
   up, which is where a driver needs the answer and where a model has to earn
   its place.
3. **No skill number without support.** Every prediction records how many
   training observations backed its climatology bucket, so a good score on
   six observations is visible as such rather than averaged into a headline.

Labels come from both stores through one rule. Cold Parquet is slot-snapped --
`compact_day` keeps 288 slots a day and discards the original `data_ts` -- so a
slot is converted back with `slot_start + FEED_PHASE_SEC`. That reconstruction
was checked against the hot store on a day held in both: it recovers the true
`data_ts` exactly, because the feed publishes on a fixed phase.
"""
import sqlite3
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import pyarrow.parquet as pq

from parkcast import config
from parkcast.compact import SLOTS_PER_DAY, SLOT_SECONDS, day_bounds
from parkcast.forecast import Blend, Climatology, Persistence, load_history, week_bucket

# Feed publishes at data_ts minutes = 3 (mod 5), i.e. 180s into each 5-minute
# slot. Verified against the hot store, not assumed -- see the module docstring.
FEED_PHASE_SEC = 180

#: (name, factory) for every forecaster under test. A trained model joins here.
FORECASTERS = (
    ("persistence", Persistence),
    ("climatology", Climatology),
    ("blend", Blend),
)


@dataclass(frozen=True, slots=True)
class Prediction:
    """One scored forecast. `support` is the training count behind its bucket."""
    lot_id: str
    horizon_min: int
    probability: float
    outcome: int
    support: int


def brier(predictions: Sequence[Prediction]) -> float | None:
    """Mean squared error of a probabilistic forecast. Lower is better; 0 is perfect.

    Returns None rather than 0.0 for an empty set: an unmeasured cell and a
    perfectly-forecast one must not print the same number.
    """
    if not predictions:
        return None
    return sum((p.probability - p.outcome) ** 2 for p in predictions) / len(predictions)


def skill(model: float | None, reference: float | None) -> float | None:
    """Brier skill score: the fraction of the reference's error removed.

    Positive means better than the reference, 0 means indistinguishable,
    negative means worse. This is the number the spec gates the model on.
    """
    if model is None or reference is None or reference == 0:
        return None
    return 1.0 - model / reference


@dataclass(frozen=True, slots=True)
class Bin:
    low: float
    high: float
    count: int
    mean_predicted: float
    observed_rate: float


def calibration(predictions: Sequence[Prediction], bins: int = 10) -> list[Bin]:
    """Do the stated probabilities happen at the stated rate?

    Accuracy and calibration are different virtues and this project claims the
    second one: "21% chance" has to mean a space is there about 21% of the time,
    or the ranking underneath it is sorting on a number that means nothing.
    """
    buckets: list[list[Prediction]] = [[] for _ in range(bins)]
    for p in predictions:
        index = min(int(p.probability * bins), bins - 1)
        buckets[index].append(p)
    out = []
    for i, bucket in enumerate(buckets):
        if not bucket:
            continue
        out.append(Bin(
            low=i / bins,
            high=(i + 1) / bins,
            count=len(bucket),
            mean_predicted=sum(p.probability for p in bucket) / len(bucket),
            observed_rate=sum(p.outcome for p in bucket) / len(bucket),
        ))
    return out


def load_labels(conn: sqlite3.Connection, cold_dir: Path | None) -> dict[int, dict[str, int]]:
    """Every observation the corpus holds, as `{data_ts: {lot_id: free_car}}`.

    Both stores, one timestamp convention. A reading present in both (cold owns
    a day the hot window still covers) lands on the same key with the same
    value, so the overlap is idempotent rather than double-counted.
    """
    labels: dict[int, dict[str, int]] = {}

    # `cold_dir=None` means a hot-only store -- the shape `load_history` already
    # accepts, and the shape every test fixture has.
    for path in sorted(Path(cold_dir).glob("*.parquet")) if cold_dir else ():
        day = date.fromisoformat(path.stem)
        start, _ = day_bounds(day)
        table = pq.read_table(path, columns=["lot_id", "free_car"]).to_pylist()
        for row in table:
            lot_id = row["lot_id"]
            for slot, free in enumerate(row["free_car"]):
                if free is None or not 0 <= slot < SLOTS_PER_DAY:
                    continue
                ts = start + slot * SLOT_SECONDS + FEED_PHASE_SEC
                labels.setdefault(ts, {})[lot_id] = free

    for lot_id, data_ts, free in conn.execute(
        "SELECT lot_id, data_ts, free_car FROM observations WHERE free_car IS NOT NULL"
    ):
        labels.setdefault(data_ts, {})[lot_id] = free

    return labels


def hard_lots(conn, cold_dir: Path | None, *, before_ts: int, threshold: float) -> set[str]:
    """Lots that actually fill up, judged only on data before the test period.

    "At or near capacity" has to be decided from the training side: choosing the
    hard subset using test-period outcomes would be selecting the cases on the
    labels being scored, which is the same leak in a different coat.
    """
    history = load_history(conn, cold_dir=cold_dir, before_ts=before_ts)
    return {
        lot_id for lot_id, (hits, total) in history.counts.lot.items()
        if total and hits / total < threshold
    }


@dataclass
class Result:
    origins: list[int] = field(default_factory=list)
    by_model: dict[str, list[Prediction]] = field(default_factory=dict)

    @property
    def n_predictions(self) -> int:
        return sum(len(v) for v in self.by_model.values())


def backtest(
    conn,
    cold_dir: Path | None,
    *,
    origins: Iterable[int],
    horizons: Sequence[int],
) -> Result:
    """Score every forecaster at every origin, on identical inputs.

    One `load_history` per origin, so the cost is linear in origins rather than
    in predictions. All three forecasters share that history, which is what
    makes the comparison fair: they differ in what they do with the data, never
    in which data they got.
    """
    labels = load_labels(conn, cold_dir)
    result = Result(by_model={name: [] for name, _ in FORECASTERS})

    for origin in origins:
        # +1 so the reading *at* the origin is inside the history -- it is the
        # forecaster's input, not one of its labels. Everything scored below is
        # strictly later.
        history = load_history(conn, cold_dir=cold_dir, before_ts=origin + 1)
        if not history.counts.glob[1]:
            continue
        models = [(name, cls(history)) for name, cls in FORECASTERS]
        result.origins.append(origin)

        for horizon in horizons:
            target = origin + horizon * 60
            actual = labels.get(target)
            if not actual:
                continue
            bucket_counts = history.counts.bucket
            key_bucket = week_bucket(target)
            for lot_id, free in actual.items():
                outcome = 1 if free >= 1 else 0
                support = bucket_counts.get((lot_id, key_bucket), (0, 0))[1]
                for name, model in models:
                    p = model.predict(lot_id, target, horizon)
                    if p is None:
                        continue
                    result.by_model[name].append(
                        Prediction(lot_id, horizon, p, outcome, support)
                    )
    return result


def choose_origins(
    labels: dict[int, dict[str, int]],
    *,
    start_ts: int,
    every_minutes: int,
    limit: int | None = None,
) -> list[int]:
    """Origins in the test period that actually have a reading behind them.

    Spaced rather than consecutive: neighbouring origins five minutes apart
    predict almost the same thing from almost the same history, so they inflate
    the sample size without adding evidence.
    """
    step = every_minutes * 60
    candidates = sorted(ts for ts in labels if ts >= start_ts)
    chosen: list[int] = []
    for ts in candidates:
        if not chosen or ts - chosen[-1] >= step:
            chosen.append(ts)
        if limit is not None and len(chosen) >= limit:
            break
    return chosen


def taipei(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, config.TAIPEI_TZ)


def day_start_ts(day: date) -> int:
    return day_bounds(day)[0]


def next_day(day: date) -> date:
    return day + timedelta(days=1)
