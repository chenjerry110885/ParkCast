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
