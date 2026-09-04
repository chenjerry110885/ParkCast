"""Encode and atomically publish the two static artifacts the client reads."""
import json
import struct
from collections.abc import Sequence
from pathlib import Path

from parkcast import config
from parkcast.metadata import Lot

MAGIC = b"PCG1"
VERSION = 1
HEADER_FORMAT = "<4sBIIHBB"          # magic, version, generated_at, base_data_ts,
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)   # n_lots, n_horizons, horizon_step_min


def encode_grid(
    grid: bytes, *, generated_at: int, base_data_ts: int, n_lots: int
) -> bytes:
    """Prefix the matrix with a self-describing header.

    `generated_at` and `base_data_ts` are both carried so the client can show
    how stale the underlying reading is, rather than implying the forecast is
    as fresh as the file.
    """
    expected = n_lots * config.HORIZON_COUNT
    if len(grid) != expected:
        raise ValueError(f"grid is {len(grid)} bytes, expected {expected}")
    header = struct.pack(
        HEADER_FORMAT, MAGIC, VERSION, generated_at, base_data_ts,
        n_lots, config.HORIZON_COUNT, config.HORIZON_STEP_MIN,
    )
    return header + grid


def decode_header(blob: bytes) -> dict:
    magic, version, generated_at, base_data_ts, n_lots, n_horizons, step = struct.unpack(
        HEADER_FORMAT, blob[:HEADER_SIZE]
    )
    return {
        "magic": magic, "version": version, "generated_at": generated_at,
        "base_data_ts": base_data_ts, "n_lots": n_lots,
        "n_horizons": n_horizons, "horizon_step_min": step,
    }


def build_lots_json(
    lots: Sequence[Lot], *, generated_at: int, base_data_ts: int, n_lots: int
) -> bytes:
    """Compact metadata, index-aligned with the grid's rows.

    Carries the same three identity fields as the grid header. Row order is
    dynamic -- a lot joins the set on its first usable reading and leaves after
    a 48h all-null window -- and the two files are written independently, so a
    client that pairs a fresh grid with a stale lots.json would read every lot
    after the inserted row under its neighbour's name and map pin. Stamping
    both lets the client detect that and refuse the pair instead.

    Short keys and unescaped UTF-8: at ~1,100 lots this is the difference
    between a 234 KB file and something several times larger.
    """
    if len(lots) != n_lots:
        raise ValueError(f"n_lots is {n_lots} but {len(lots)} lots were given")
    payload = {
        "generated_at": generated_at,
        "base_data_ts": base_data_ts,
        "n_lots": n_lots,
        "lots": [
            {
                "i": i, "id": lot.id, "n": lot.name, "a": lot.area,
                "y": round(lot.lat, 5), "x": round(lot.lon, 5),
                "c": lot.capacity_car, "t": lot.lot_type,
            }
            for i, lot in enumerate(lots)
        ]
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def publish(out_dir: Path, *, grid_blob: bytes, lots_blob: bytes) -> None:
    """Write both artifacts, each via a temp file and rename.

    A reader polling grid.bin must never observe a partial write. The pair is
    not atomic *together* -- a client can still fetch one file either side of a
    republish -- which is why both blobs carry the same generation stamp for the
    client to compare.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, blob in (("grid.bin", grid_blob), ("lots.json", lots_blob)):
        tmp = out_dir / f"{name}.tmp"
        tmp.write_bytes(blob)
        tmp.replace(out_dir / name)
