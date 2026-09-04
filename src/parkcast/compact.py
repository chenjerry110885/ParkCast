"""Roll a completed day out of SQLite into a compact Parquet file.

One row per (lot, day), holding four parallel 288-slot arrays at 5-minute
resolution. Unobserved slots stay null in every array: interpolated data that
looks real is worse than missing data that looks missing.

Parquet is the permanent record — SQLite keeps only a rolling 48 hours — so a
column dropped here is a column that can never be trained on. `lag` carries the
observation staleness the model needs (spec section 7) and `free_motor` carries
the 466 motorcycle-reporting lots that phase 2 wants (spec section 13); both
exist only inside the hot window otherwise.
"""
from datetime import date, datetime, time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from parkcast import config

SLOTS_PER_DAY = 288
SLOT_SECONDS = 300

# The per-slot arrays, in the order they are written.
ARRAY_COLUMNS = ("free_car", "free_motor", "lag", "quality")

_SCHEMA = pa.schema([
    ("lot_id", pa.string()),
    ("date", pa.string()),
    ("free_car", pa.list_(pa.int32(), SLOTS_PER_DAY)),
    ("free_motor", pa.list_(pa.int32(), SLOTS_PER_DAY)),
    # observed_at - data_ts, i.e. how stale the reading already was when we saw
    # it. Stored derived rather than as two absolute timestamps: data_ts is
    # recoverable from the slot index and the date, so the difference is the
    # only part that is not.
    ("lag", pa.list_(pa.int16(), SLOTS_PER_DAY)),
    ("quality", pa.list_(pa.int16(), SLOTS_PER_DAY)),
])

_LAG_MIN, _LAG_MAX = -32768, 32767


def day_bounds(day: date) -> tuple[int, int]:
    """[start, end) epoch seconds for a calendar day in Taipei."""
    start = int(datetime.combine(day, time.min, config.TAIPEI_TZ).timestamp())
    return start, start + SLOTS_PER_DAY * SLOT_SECONDS


def _clamp_lag(seconds: int) -> int:
    """Bound a staleness value into int16.

    The real distribution is 180-500s. Anything outside +-9 hours means a broken
    clock, not a real observation delay, and letting one such row raise would
    block a whole day's compaction permanently.
    """
    return max(_LAG_MIN, min(_LAG_MAX, seconds))


def compact_day(conn, day: date, out_dir: Path) -> Path | None:
    start, end = day_bounds(day)
    rows = conn.execute(
        """
        SELECT lot_id, data_ts, observed_at, free_car, free_motor, quality
        FROM observations
        WHERE data_ts >= ? AND data_ts < ?
        ORDER BY lot_id, data_ts
        """,
        (start, end),
    ).fetchall()

    if not rows:
        return None

    lots: dict[str, dict[str, list[int | None]]] = {}
    for lot_id, data_ts, observed_at, free_car, free_motor, quality in rows:
        slot = (data_ts - start) // SLOT_SECONDS
        if not 0 <= slot < SLOTS_PER_DAY:
            continue
        arrays = lots.get(lot_id)
        if arrays is None:
            arrays = lots[lot_id] = {
                name: [None] * SLOTS_PER_DAY for name in ARRAY_COLUMNS
            }
        arrays["free_car"][slot] = free_car
        arrays["free_motor"][slot] = free_motor
        arrays["lag"][slot] = _clamp_lag(observed_at - data_ts)
        arrays["quality"][slot] = quality

    lot_ids = sorted(lots)
    table = pa.table(
        {
            "lot_id": lot_ids,
            "date": [day.isoformat()] * len(lot_ids),
            **{
                name: [lots[k][name] for k in lot_ids] for name in ARRAY_COLUMNS
            },
        },
        schema=_SCHEMA,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{day.isoformat()}.parquet"
    # Write beside the target and rename: pq.write_table is not atomic, and a
    # half-written file would be indistinguishable from a complete day.
    tmp = path.with_name(path.name + ".tmp")
    pq.write_table(table, tmp, compression="zstd")
    tmp.replace(path)
    return path
