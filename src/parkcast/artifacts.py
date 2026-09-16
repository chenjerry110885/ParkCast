"""Encode and atomically publish the static artifacts the client reads.

One pair per city -- `grid-{city}.bin` and `lots-{city}.json` -- plus a
`cities.json` index naming them. Taipei's pair keeps the original unsuffixed
names, because the deployed app already fetches them.
"""
import json
import math
import struct
import zlib
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path

from parkcast import config, ids
from parkcast.metadata import Lot
from parkcast.pricing import Price, parse_fare

MAGIC = b"PCG1"
VERSION = 1
HEADER_FORMAT = "<4sBIIHBBI"         # magic, version, generated_at, base_data_ts,
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)   # n_lots, n_horizons,
                                               # horizon_step_min, roster_id

CITIES_NAME = "cities.json"
# The one city whose shard keeps the original, unsuffixed filenames. The live
# site has been fetching grid.bin and lots.json since before there was a second
# city, and every deployed client has those URLs baked in; moving them to
# grid-taipei.bin would break every copy of the app in the wild for the sake of
# symmetry. Sharding is additive on purpose -- see `publish`.
UNSUFFIXED_CITY = "taipei"


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

    The ids it hashes are the BARE, published ones (`ids.bare`), never the
    store's namespaced form. A shard is always exactly one city, so a bare id is
    already unique within the file this hash describes -- and hashing the
    namespaced form would move Taipei's published `roster_id`, which the client
    compares between grid.bin and lots.json, for no gain at all.
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
    lots: Sequence[Lot], *, generated_at: int, base_data_ts: int,
    not_updating: Mapping[str, int] | None = None,
    free: Mapping[str, int | None] | None = None,
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

    `u` is present only on a lot whose feed is not updating (`liveness`): the
    unix time of its last update, while every cell of its grid row is UNKNOWN.
    Absent on a live lot, so there is no value to misread. Additive rather than
    a schema change: a client that ignores it shows "no data" for that row,
    which is still true, so `v` stays where it is.

    `f` is the lot's observed free_car at `base_data_ts` -- the reading the
    forecast was made from -- and is present only for a lot that was observed at
    that reading; None means observed but reporting nothing. It is the one
    *observed* number on the card, and the client labels it with the reading's
    age so it is never mistaken for a forecast. Additive: `v` stays where it is.

    `id` is the feed's own id, stripped of the store's city namespace. The file
    is one city's shard and says so in its name, so the namespace would be a
    constant prefix repeated on every row -- and, far more importantly, the
    app's stored recents key on the id it already knows. A namespaced id here
    would orphan every saved lot and change every published byte.

    `not_updating` and `free` are keyed by the STORED (namespaced) id, because
    that is what the store and `liveness` deal in. Only the published `id`
    field and `roster_id` are bare.
    """
    lot_ids = [ids.bare(lot.id) for lot in lots]
    withheld = not_updating or {}
    rows = []
    for i, lot in enumerate(lots):
        row = {
            "i": i, "id": lot_ids[i], "n": lot.name, "a": lot.area,
            "y": round(lot.lat, 5), "x": round(lot.lon, 5),
            "c": lot.capacity_car, "t": lot.lot_type,
            "p": _price_field(parse_fare(lot.fare_text)),
        }
        if lot.id in withheld:
            row["u"] = withheld[lot.id]
        if free is not None and lot.id in free:
            row["f"] = free[lot.id]
        rows.append(row)
    payload = {
        "v": VERSION,
        "generated_at": generated_at,
        "base_data_ts": base_data_ts,
        "n_lots": len(lot_ids),
        "roster_id": roster_id(lot_ids),
        "lots": rows,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def grid_name(city: str) -> str:
    """The published grid filename for one city's shard."""
    return "grid.bin" if city == UNSUFFIXED_CITY else f"grid-{city}.bin"


def lots_name(city: str) -> str:
    """The published metadata filename for one city's shard."""
    return "lots.json" if city == UNSUFFIXED_CITY else f"lots-{city}.json"


def _write_atomic(out_dir: Path, name: str, blob: bytes) -> None:
    """One file, via a temp file in the same directory and a rename."""
    tmp = out_dir / f"{name}.tmp"
    tmp.write_bytes(blob)
    tmp.replace(out_dir / name)


def publish(out_dir: Path, city: str, *, grid_blob: bytes, lots_blob: bytes) -> None:
    """Write one city's two artifacts, each via a temp file and rename.

    A reader polling grid.bin must never observe a partial write. The pair is
    not atomic *together* -- a client can still fetch one file either side of a
    republish -- which is why both blobs carry the same stamps for the client to
    compare: `generated_at` / `base_data_ts` say which publish each came from,
    and `roster_id` says whether that even matters, since a lots.json from an
    earlier tick with an identical roster pairs safely with this grid.

    Nor is the *set* of shards atomic, which is the same property one notch up:
    each city is written independently, so a tick can leave one city republished
    and another still holding last tick's bytes. That is deliberate -- the
    alternative is one city's collapse blocking every other city's publish --
    and it is safe because a shard is self-describing: nothing in grid-tainan.bin
    is interpreted against anything in grid.bin.

    Taipei keeps the unsuffixed names; see `UNSUFFIXED_CITY`.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, blob in ((grid_name(city), grid_blob), (lots_name(city), lots_blob)):
        _write_atomic(out_dir, name, blob)


def bbox(lots: Sequence[Lot]) -> list[float]:
    """[west, south, east, north] over `lots`, rounded like their coordinates.

    Rounded to the same 5 decimals `build_lots_json` rounds `y`/`x` to, so the
    box cannot exclude a published lot by a rounding step: the min is rounded
    down and the max up, never to nearest.
    """
    lats = [lot.lat for lot in lots]
    lons = [lot.lon for lot in lots]
    step = 10 ** 5
    return [
        math.floor(min(lons) * step) / step, math.floor(min(lats) * step) / step,
        math.ceil(max(lons) * step) / step, math.ceil(max(lats) * step) / step,
    ]


def city_entry(city: str, lots: Sequence[Lot], *, base_data_ts: int) -> dict:
    """One city's row in cities.json, derived from the shard just published.

    `lots` is the exact roster written to that shard, so the count and the box
    describe the file rather than the intention -- the same reason `n_lots` and
    `roster_id` are derived inside the encoders.
    """
    return {
        "city": city,
        "lots": len(lots),
        "base_data_ts": base_data_ts,
        "bbox": bbox(lots),
    }


def build_cities_json(entries: Iterable[Mapping], *, generated_at: int) -> bytes:
    """The index of published shards: which cities exist and where they are.

    A client cannot discover grid-tainan.bin by guessing, and must not have the
    list compiled into it -- a city added here would then need an app release
    before anyone could see it. This is the one file it fetches without knowing
    what is in it.

    `bbox` is what makes it useful before anything is downloaded: the app can
    tell from a location which shard (if any) covers it, and fetch only that
    one, instead of pulling every city's lots.json to find out.

    Sorted by city name so an unchanged set of shards produces an unchanged
    list, leaving `generated_at` the only field that moves tick to tick.
    """
    payload = {
        "v": VERSION,
        "generated_at": generated_at,
        "cities": sorted(entries, key=lambda entry: entry["city"]),
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def read_cities(path: Path) -> dict[str, dict]:
    """The entries of an already-published cities.json, keyed by city.

    Empty covers every "nothing trustworthy to carry forward" case -- no file,
    unreadable, not JSON, or JSON of the wrong shape -- exactly as
    `read_header` does for the grid, so a caller can treat a missing index as
    "nothing to preserve" without knowing the format.
    """
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        entries = payload["cities"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    if not isinstance(entries, list):
        return {}
    return {
        entry["city"]: entry
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("city"), str)
    }


def publish_cities(out_dir: Path, blob: bytes) -> None:
    """Write cities.json via a temp file and rename, like the shards."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_atomic(out_dir, CITIES_NAME, blob)
