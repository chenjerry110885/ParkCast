"""Forecasters producing P(free_car >= 1) for a lot at a future time.

Three implementations share one protocol so Plan 4 can evaluate them against
each other and against a trained model on identical inputs.
"""
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from parkcast import config


@dataclass(frozen=True, slots=True)
class History:
    latest_ts: int
    current: dict[str, int]                     # newest reading per lot
    by_lot: dict[str, list[tuple[int, int]]]    # (data_ts, free_car), ordered


class Forecaster(Protocol):
    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        """P(free_car >= 1), or None when there is no basis for an answer."""
        ...


def load_history(conn, *, cold_dir: Path | None = None) -> History:
    """Read the hot store, optionally extended by the cold Parquet corpus.

    Missing readings are absent rather than zero: a NULL means the feed said
    nothing, and coercing it to 0 would assert the lot was full.
    """
    by_lot: dict[str, list[tuple[int, int]]] = defaultdict(list)

    row = conn.execute("SELECT MIN(data_ts) FROM observations").fetchone()
    earliest_hot = row[0]
    cold_cutoff = _snap_to_slot(earliest_hot) if earliest_hot is not None else None

    if cold_dir is not None:
        for lot_id, ts, free in _read_cold(cold_dir):
            # The hot store is authoritative for anything it still retains; taking
            # the cold copy too would count the same reading twice at a different
            # timestamp, silently double-weighting the most recent 48 hours.
            if cold_cutoff is None or ts < cold_cutoff:
                by_lot[lot_id].append((ts, free))

    # Deliberately unordered. `idx_obs_data_ts` is non-covering, so ORDER BY
    # data_ts turns a table scan into one random primary-key lookup per row:
    # measured on the live store at 85,735 rows, 11.19s with the ORDER BY
    # against 0.16s without, and the cost grows with the window. The sort below
    # is what actually guarantees the order, and it has to run anyway because
    # cold rows are read before hot ones.
    for lot_id, ts, free in conn.execute(
        "SELECT lot_id, data_ts, free_car FROM observations "
        "WHERE free_car IS NOT NULL"
    ):
        by_lot[lot_id].append((ts, free))

    for series in by_lot.values():
        series.sort()

    row = conn.execute("SELECT MAX(data_ts) FROM observations").fetchone()
    latest_ts = row[0] or 0
    current = {
        lot_id: free
        for lot_id, free in conn.execute(
            "SELECT lot_id, free_car FROM observations "
            "WHERE data_ts = ? AND free_car IS NOT NULL",
            (latest_ts,),
        )
    }
    return History(latest_ts, current, dict(by_lot))


def _snap_to_slot(ts: int) -> int:
    """Round a timestamp down to the 5-minute slot grid the cold store uses.

    compact_day writes slot-aligned timestamps, so comparing a hot timestamp
    against cold ones is only exact once the hot side is snapped the same way.
    """
    from datetime import datetime

    from parkcast.compact import SLOT_SECONDS, day_bounds

    day = datetime.fromtimestamp(ts, config.TAIPEI_TZ).date()
    start, _ = day_bounds(day)
    return start + ((ts - start) // SLOT_SECONDS) * SLOT_SECONDS


def _read_cold(cold_dir: Path):
    """Yield (lot_id, data_ts, free_car) from daily Parquet files, skipping nulls."""
    import pyarrow.parquet as pq

    from parkcast.compact import SLOTS_PER_DAY, SLOT_SECONDS, day_bounds
    from datetime import date

    for path in sorted(Path(cold_dir).glob("*.parquet")):
        try:
            day = date.fromisoformat(path.stem)
        except ValueError:
            continue
        start, _ = day_bounds(day)
        for row in pq.read_table(path, columns=["lot_id", "free_car"]).to_pylist():
            for slot, free in enumerate(row["free_car"]):
                if free is not None and slot < SLOTS_PER_DAY:
                    yield row["lot_id"], start + slot * SLOT_SECONDS, free


BUCKETS_PER_WEEK = 7 * 24 * 60 // config.CLIMATOLOGY_BUCKET_MIN


def week_bucket(ts: int) -> int:
    """Index of the Taipei time-of-week bucket containing `ts`.

    Taipei is a whole-hour offset with no DST, so shifting the epoch by 8h and
    bucketing is exact -- no calendar arithmetic needed.
    """
    local_min = (ts + 8 * 3600) // 60
    return int(local_min // config.CLIMATOLOGY_BUCKET_MIN) % BUCKETS_PER_WEEK


def _shrink(counter: list[int], prior_rate: float, strength: float) -> float:
    """Blend a [hits, n] counter toward `prior_rate` with `strength` pseudo-obs.

    Equivalent to a Beta(strength * prior_rate, strength * (1 - prior_rate))
    posterior mean. At n = 0 it returns the prior exactly, which is what makes
    a missing tier fall through to its parent without a special case.
    """
    hits, n = counter
    return (hits + strength * prior_rate) / (n + strength)


class Climatology:
    """P = this lot's historical rate at this time of week, shrunk toward the
    rates above it.

    The tiers are still lot+bucket -> lot -> global, but each one is a
    Beta-smoothed version of the one above rather than a raw fraction:

        lot_rate    = (lot_hits    + BETA  * global_rate) / (lot_n    + BETA)
        bucket_rate = (bucket_hits + ALPHA * lot_rate)    / (bucket_n + ALPHA)

    A 30-minute bucket at a 5-minute cadence sees 6 observations a week, so a
    raw hits/total is 0.0 or 1.0 in 96% of cells -- a baseline that answers a
    probability question with a certainty, and one a model would beat on Brier
    score without being any good. Spec section 8 makes climatology the bar to
    clear, so it has to be a real forecast.

    Shrinkage replaces the old CLIMATOLOGY_MIN_SUPPORT gate rather than joining
    it: a thin bucket is now pulled most of the way to its parent instead of
    being discarded at a threshold, and a bucket with no observations at all
    evaluates to exactly the lot rate, so the fallback chain is continuous
    rather than a cliff. A hard gate on top would only discard smoothed
    evidence that is already mostly its parent's.

    The global tier stays raw: it is the fallback of last resort and has
    nothing above it to shrink toward.
    """

    def __init__(self, history: History) -> None:
        self._bucket: dict[tuple[str, int], list[int]] = defaultdict(lambda: [0, 0])
        self._lot: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        self._global = [0, 0]

        for lot_id, series in history.by_lot.items():
            for ts, free in series:
                hit = 1 if free >= 1 else 0
                for counter in (self._bucket[(lot_id, week_bucket(ts))],
                                self._lot[lot_id], self._global):
                    counter[0] += hit
                    counter[1] += 1

    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        if not self._global[1]:
            return None
        rate = self._global[0] / self._global[1]

        lot = self._lot.get(lot_id)
        if lot is None:
            return rate
        rate = _shrink(lot, rate, config.CLIMATOLOGY_LOT_PRIOR)

        bucket = self._bucket.get((lot_id, week_bucket(target_ts)))
        if bucket is None:
            return rate
        return _shrink(bucket, rate, config.CLIMATOLOGY_BUCKET_PRIOR)


class Persistence:
    """P = 1 if the lot currently has a space, else 0. Ignores the horizon.

    Deliberately naive and uncalibrated: this is the bar a real model has to
    clear, not a forecast anyone should ship on its own.
    """

    def __init__(self, history: History) -> None:
        self._current = history.current

    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        free = self._current.get(lot_id)
        return None if free is None else (1.0 if free >= 1 else 0.0)


class Blend:
    """Persistence decaying exponentially toward climatology as the horizon grows.

    The current reading is strong evidence about the next few minutes and
    almost none about two hours from now. Weighting it by 0.5**(h/half_life)
    expresses exactly that, and degrades to whichever component is available
    when the other has no answer.
    """

    def __init__(self, history: History) -> None:
        self._persistence = Persistence(history)
        self._climatology = Climatology(history)

    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        near = self._persistence.predict(lot_id, target_ts, horizon_min)
        far = self._climatology.predict(lot_id, target_ts, horizon_min)
        if near is None:
            return far
        if far is None:
            return near
        weight = 0.5 ** (horizon_min / config.BLEND_HALF_LIFE_MIN)
        return weight * near + (1.0 - weight) * far
