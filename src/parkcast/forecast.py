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

    if cold_dir is not None:
        for lot_id, ts, free in _read_cold(cold_dir):
            by_lot[lot_id].append((ts, free))

    for lot_id, ts, free in conn.execute(
        "SELECT lot_id, data_ts, free_car FROM observations "
        "WHERE free_car IS NOT NULL ORDER BY data_ts"
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


class Climatology:
    """P = the historical fraction of readings where this lot had a space.

    Falls back lot+bucket -> lot -> global, so a lot with thin history still
    gets an answer grounded in something rather than a coin flip. Both the
    bucket and lot tiers are only trusted once they have CLIMATOLOGY_MIN_SUPPORT
    observations behind them; the global tier is ungated beyond having any
    observation at all, since it is the fallback of last resort.
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
        for counter in (self._bucket.get((lot_id, week_bucket(target_ts))),
                        self._lot.get(lot_id)):
            if counter and counter[1] >= config.CLIMATOLOGY_MIN_SUPPORT:
                return counter[0] / counter[1]
        return self._global[0] / self._global[1] if self._global[1] else None


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
