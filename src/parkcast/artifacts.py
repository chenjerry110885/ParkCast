"""Encode and atomically publish the two static artifacts the client reads."""
import json
import struct
import zlib
from collections.abc import Sequence
from pathlib import Path

from parkcast import config
from parkcast.metadata import Lot
from parkcast.pricing import Price, parse_fare

MAGIC = b"PCG1"
VERSION = 1
HEADER_FORMAT = "<4sBIIHBBI"         # magic, version, generated_at, base_data_ts,
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)   # n_lots, n_horizons,
                                               # horizon_step_min, roster_id


def roster_id(lot_ids: Sequence[str]) -> int:
    """A stable 32-bit identity for one ordered sequence of lot ids.

    `generated_at` changes every five minutes; the roster almost never does.
    A client that refused every stamp mismatch would therefore refuse every
    cross-tick pair even though it is safe, leaving it a choice between
    re-fetching ~300 KB of lots.json each tick and dropping the check entirely.
    This hashes the only thing that actually has to match -- the row order --
    so lots.json stays cacheable and a mismatch means the rows really moved.

    Order is part of the identity: the ids are joined on a separator rather
    than concatenated, so a permutation, an insertion and a deletion all change
    the value. That covers the case `n_lots` cannot see, where one lot joins as
    another leaves and every row between them shifts under an unchanged count.

    One function, called by both encoders, because two copies of this
    computation could drift and a roster that disagrees with itself is worse
    than no roster at all.
    """
    return zlib.crc32("\n".join(lot_ids).encode("utf-8")) & 0xFFFFFFFF


def encode_grid(
    grid: bytes, *, generated_at: int, base_data_ts: int, lot_ids: Sequence[str]
) -> bytes:
    """Prefix the matrix with a self-describing header.

    `generated_at` and `base_data_ts` are both carried so the client can show
    how stale the underlying reading is, rather than implying the forecast is
    as fresh as the file.

    `n_lots` and `roster_id` are *derived* from the same `lot_ids` the grid's
    rows were built from, never passed in alongside them, so the header cannot
    describe a roster the payload does not have.
    """
    n_lots = len(lot_ids)
    expected = n_lots * config.HORIZON_COUNT
    if len(grid) != expected:
        raise ValueError(f"grid is {len(grid)} bytes, expected {expected}")
    header = struct.pack(
        HEADER_FORMAT, MAGIC, VERSION, generated_at, base_data_ts,
        n_lots, config.HORIZON_COUNT, config.HORIZON_STEP_MIN, roster_id(lot_ids),
    )
    return header + grid


def decode_header(blob: bytes) -> dict:
    (magic, version, generated_at, base_data_ts, n_lots, n_horizons, step,
     roster) = struct.unpack(HEADER_FORMAT, blob[:HEADER_SIZE])
    return {
        "magic": magic, "version": version, "generated_at": generated_at,
        "base_data_ts": base_data_ts, "n_lots": n_lots,
        "n_horizons": n_horizons, "horizon_step_min": step, "roster_id": roster,
    }


def read_header(path: Path) -> dict | None:
    """The header of an already-published grid, or None if there isn't one.

    None covers every "nothing trustworthy to compare against" case -- no file,
    a truncated one, or bytes that are not a grid at all -- so callers can treat
    a missing baseline as "publish" without knowing the format.
    """
    try:
        blob = Path(path).read_bytes()[:HEADER_SIZE]
        header = decode_header(blob)
    except (OSError, struct.error):
        return None
    return header if header["magic"] == MAGIC else None


def _price_field(price: Price) -> dict:
    """The compact `"p"` object for one lot's parsed fare.

    `lo`/`hi` are omitted entirely for `unknown` rather than sent as `null`,
    so a client cannot read a number that was never parsed -- there is no key
    to misread in the first place.
    """
    if price.kind == "unknown":
        return {"k": "unknown"}
    return {"k": price.kind, "lo": price.low, "hi": price.high}


def build_lots_json(
    lots: Sequence[Lot], *, generated_at: int, base_data_ts: int
) -> bytes:
    """Compact metadata, index-aligned with the grid's rows.

    Carries the same identity fields as the grid header. Row order is dynamic
    -- a lot joins the set on its first usable reading and leaves after a 48h
    all-null window -- and the two files are written independently, so a client
    that pairs a fresh grid with a stale lots.json would read every lot after
    the inserted row under its neighbour's name and map pin. Stamping both lets
    the client detect that and refuse the pair instead.

    `n_lots` and `roster_id` are derived from `lots` rather than accepted as
    arguments: a stamp that can disagree with the rows beneath it is worse than
    no stamp, and deriving both makes that disagreement unrepresentable instead
    of merely rejected.

    `v` is the schema version of this document. grid.bin already carries one in
    its header; without the same here, a future client could not tell a v1
    lots.json from a v2 one and would have to guess from the keys present.

    `p` carries the fare already parsed into numbers by `pricing.parse_fare`,
    never the raw Chinese `fare_text` -- the browser has no reason to parse
    prose, and shipping it at ~57 chars per lot would roughly double the file.

    Short keys and unescaped UTF-8: at ~1,100 lots this is the difference
    between a 234 KB file and something several times larger.
    """
    lot_ids = [lot.id for lot in lots]
    payload = {
        "v": VERSION,
        "generated_at": generated_at,
        "base_data_ts": base_data_ts,
        "n_lots": len(lot_ids),
        "roster_id": roster_id(lot_ids),
        "lots": [
            {
                "i": i, "id": lot.id, "n": lot.name, "a": lot.area,
                "y": round(lot.lat, 5), "x": round(lot.lon, 5),
                "c": lot.capacity_car, "t": lot.lot_type,
                "p": _price_field(parse_fare(lot.fare_text)),
            }
            for i, lot in enumerate(lots)
        ]
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def publish(out_dir: Path, *, grid_blob: bytes, lots_blob: bytes) -> None:
    """Write both artifacts, each via a temp file and rename.

    A reader polling grid.bin must never observe a partial write. The pair is
    not atomic *together* -- a client can still fetch one file either side of a
    republish -- which is why both blobs carry the same stamps for the client to
    compare: `generated_at` / `base_data_ts` say which publish each came from,
    and `roster_id` says whether that even matters, since a lots.json from an
    earlier tick with an identical roster pairs safely with this grid.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, blob in (("grid.bin", grid_blob), ("lots.json", lots_blob)):
        tmp = out_dir / f"{name}.tmp"
        tmp.write_bytes(blob)
        tmp.replace(out_dir / name)
