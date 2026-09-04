"""End-to-end check against a snapshot of the live database, when one exists."""
import shutil
from pathlib import Path

import pytest

from parkcast import config, store
from parkcast.artifacts import HEADER_SIZE, build_lots_json, decode_header, encode_grid
from parkcast.forecast import Blend, load_history
from parkcast.grid import UNKNOWN, build_grid

LIVE_DB = config.DB_PATH


@pytest.mark.skipif(not LIVE_DB.exists(), reason="no collected data on this machine")
def test_end_to_end_over_real_observations(tmp_path):
    copy = tmp_path / "snap.sqlite"
    shutil.copy(LIVE_DB, copy)
    conn = store.connect(copy)

    history = load_history(conn)
    assert history.latest_ts > 0
    assert len(history.by_lot) > 500, "expected a citywide history"

    lot_ids = sorted(history.by_lot)
    grid = build_grid(Blend(history), lot_ids, history.latest_ts)
    blob = encode_grid(grid, generated_at=history.latest_ts + 30,
                       base_data_ts=history.latest_ts, n_lots=len(lot_ids))

    header = decode_header(blob)
    assert header["n_lots"] == len(lot_ids)
    assert len(blob) == HEADER_SIZE + len(lot_ids) * 24

    known = [b for b in grid if b != UNKNOWN]
    assert known, "a real snapshot must produce some known probabilities"
    assert all(0 <= b <= 100 for b in known)
    # Blend must decay toward climatology, so horizon 0 and 23 cannot be identical
    # for every lot unless the two components agree everywhere.
    first = [grid[i * 24] for i in range(len(lot_ids))]
    last = [grid[i * 24 + 23] for i in range(len(lot_ids))]
    assert first != last, "probabilities must vary across the horizon"
