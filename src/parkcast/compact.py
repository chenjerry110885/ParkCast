"""Roll a completed day out of SQLite into a compact Parquet file.

One row per (lot, day), holding a 288-slot array at 5-minute resolution.
Unobserved slots stay null: interpolated data that looks real is worse than
missing data that looks missing.
"""
from datetime import date, datetime, time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from parkcast import config

SLOTS_PER_DAY = 288
SLOT_SECONDS = 300

_SCHEMA = pa.schema([
    ("lot_id", pa.string()),
    ("date", pa.string()),
    ("free_car", pa.list_(pa.int32(), SLOTS_PER_DAY)),
    ("quality", pa.list_(pa.int16(), SLOTS_PER_DAY)),
])


def day_bounds(day: date) -> tuple[int, int]:
    """[start, end) epoch seconds for a calendar day in Taipei."""
    start = int(datetime.combine(day, time.min, config.TAIPEI_TZ).timestamp())
    return start, start + SLOTS_PER_DAY * SLOT_SECONDS


def compact_day(conn, day: date, out_dir: Path) -> Path | None:
    start, end = day_bounds(day)
    rows = conn.execute(
        """
        SELECT lot_id, data_ts, free_car, quality
        FROM observations
        WHERE data_ts >= ? AND data_ts < ?
        ORDER BY lot_id, data_ts
        """,
        (start, end),
    ).fetchall()

    if not rows:
        return None

    free: dict[str, list[int | None]] = {}
    flags: dict[str, list[int | None]] = {}
    for lot_id, data_ts, free_car, quality in rows:
        slot = (data_ts - start) // SLOT_SECONDS
        if not 0 <= slot < SLOTS_PER_DAY:
            continue
        free.setdefault(lot_id, [None] * SLOTS_PER_DAY)[slot] = free_car
        flags.setdefault(lot_id, [None] * SLOTS_PER_DAY)[slot] = quality

    lot_ids = sorted(free)
    table = pa.table(
        {
            "lot_id": lot_ids,
            "date": [day.isoformat()] * len(lot_ids),
            "free_car": [free[k] for k in lot_ids],
            "quality": [flags[k] for k in lot_ids],
        },
        schema=_SCHEMA,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{day.isoformat()}.parquet"
    pq.write_table(table, path, compression="zstd")
    return path
