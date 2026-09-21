"""End-to-end check against a snapshot of the live database, when one exists."""
import json
import sqlite3

import pytest

from parkcast import config, ids, store
from parkcast.artifacts import HEADER_SIZE, build_lots_json, decode_header, encode_grid
from parkcast.forecast import Blend, by_city, load_history
from parkcast.grid import UNKNOWN, build_grid
from parkcast.metadata import Lot

LIVE_DB = config.DB_PATH


def _snapshot(dest) -> None:
    """Copy the live store via SQLite's own backup API, not a file copy.

    The live database is in WAL mode and a collector may be writing to it
    every 5 minutes. A plain file copy can land mid-write and capture a torn
    snapshot -- this test flaked once for exactly that reason. `backup` takes
    a consistent snapshot instead, and the source is opened read-only so this
    never touches the live database read-write.
    """
    src = sqlite3.connect(f"file:{LIVE_DB}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


@pytest.mark.skipif(not LIVE_DB.exists(), reason="no collected data on this machine")
def test_end_to_end_over_real_observations(tmp_path):
    copy = tmp_path / "snap.sqlite"
    _snapshot(copy)
    conn = store.connect(copy)

    # One city's shard, not the whole store. `load_history` takes `latest_ts` as
    # a single maximum over every lot in it, and the store now holds six cities
    # -- two of which stamp `data_ts = now` and so always own that maximum. Read
    # unscoped, `current` comes back holding only their lots, `Persistence`
    # answers None for all ~1,082 of Taipei's, and `Blend` quietly degrades to
    # climatology alone: a grid full of plausible numbers with the short-horizon
    # signal gone. The roster would be six cities wide as well, which is not a
    # shape `publish_city` ever builds. See `forecast.by_city`.
    history = by_city(load_history(conn))[ids.LEGACY_CITY]
    assert history.latest_ts > 0
    assert len(history.recent) > 500, "expected a citywide history"
    assert history.current, (
        "no Taipei lot sits at Taipei's own latest reading -- the degradation "
        "`by_city` exists to prevent, and one that shows up as plausible numbers"
    )

    # Three id conventions meet here, exactly as they do in `publish_city`, and
    # the live snapshot may be either side of the startup migration:
    #   * `history.recent` is keyed however the store holds it -- bare on a
    #     pre-migration snapshot, namespaced after -- so the grid's lookups use
    #     those keys verbatim;
    #   * a `Lot.id` is always namespaced, which is what `as_stored` guarantees
    #     for a key that may still be legacy;
    #   * the published roster is always bare, on both sides of the pair.
    # Hashing the bare form on both sides is what makes the assertion below a
    # statement about the roster rather than about which convention it is
    # spelled in.
    lot_ids = sorted(history.recent)
    namespaced = [ids.as_stored(i) for i in lot_ids]
    published = [ids.bare(i) for i in namespaced]
    grid = build_grid(Blend(history), lot_ids, history.latest_ts)
    blob = encode_grid(grid, generated_at=history.latest_ts + 30,
                       base_data_ts=history.latest_ts, lot_ids=published)

    header = decode_header(blob)
    assert header["n_lots"] == len(lot_ids)
    assert len(blob) == HEADER_SIZE + len(lot_ids) * 24
    doc = json.loads(build_lots_json(
        [Lot(id=i, name=i, area="", lot_type="", capacity_car=None,
             lat=25.0, lon=121.5, service_time="", fare_text="") for i in namespaced],
        generated_at=history.latest_ts + 30, base_data_ts=history.latest_ts,
    ))
    assert doc["roster_id"] == header["roster_id"], (
        "a citywide roster must hash identically on both sides"
    )

    known = [b for b in grid if b != UNKNOWN]
    assert known, "a real snapshot must produce some known probabilities"
    assert all(0 <= b <= 100 for b in known)
    # Blend must decay toward climatology, so horizon 0 and 23 cannot be identical
    # for every lot unless the two components agree everywhere.
    first = [grid[i * 24] for i in range(len(lot_ids))]
    last = [grid[i * 24 + 23] for i in range(len(lot_ids))]
    assert first != last, "probabilities must vary across the horizon"
