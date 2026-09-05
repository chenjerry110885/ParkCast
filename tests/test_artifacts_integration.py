"""End-to-end check against a snapshot of the live database, when one exists."""
import json
import sqlite3

import pytest

from parkcast import config, store
from parkcast.artifacts import HEADER_SIZE, build_lots_json, decode_header, encode_grid
from parkcast.forecast import Blend, load_history
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

    history = load_history(conn)
    assert history.latest_ts > 0
    assert len(history.recent) > 500, "expected a citywide history"

    lot_ids = sorted(history.recent)
    grid = build_grid(Blend(history), lot_ids, history.latest_ts)
    blob = encode_grid(grid, generated_at=history.latest_ts + 30,
                       base_data_ts=history.latest_ts, lot_ids=lot_ids)

    header = decode_header(blob)
    assert header["n_lots"] == len(lot_ids)
    assert len(blob) == HEADER_SIZE + len(lot_ids) * 24
    doc = json.loads(build_lots_json(
        [Lot(id=i, name=i, area="", lot_type="", capacity_car=None,
             lat=25.0, lon=121.5, service_time="", fare_text="") for i in lot_ids],
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
