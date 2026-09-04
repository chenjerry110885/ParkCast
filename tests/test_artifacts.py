import json
import struct

import pytest

from parkcast.artifacts import (HEADER_SIZE, MAGIC, build_lots_json, decode_header,
                                encode_grid, publish)
from parkcast.metadata import Lot


def lot(i):
    return Lot(id=f"TPE{i:04d}", name=f"停車場{i}", area="中正區", lot_type="立體",
               capacity_car=50, lat=25.05 + i / 1000, lon=121.52 + i / 1000,
               service_time="00:00:00-23:59:59", fare_text="每小時30元")


def test_header_round_trips():
    blob = encode_grid(bytes(48), generated_at=1788537600, base_data_ts=1788537300, n_lots=2)
    h = decode_header(blob)
    assert h["magic"] == MAGIC
    assert h["generated_at"] == 1788537600
    assert h["base_data_ts"] == 1788537300
    assert h["n_lots"] == 2
    assert h["n_horizons"] == 24
    assert h["horizon_step_min"] == 5


def test_header_is_17_bytes_and_payload_follows():
    blob = encode_grid(bytes(48), generated_at=1, base_data_ts=1, n_lots=2)
    assert HEADER_SIZE == 17
    assert len(blob) == HEADER_SIZE + 48


def test_base_data_ts_is_kept_separate_from_generated_at():
    """The client must be able to see how stale the underlying reading is."""
    blob = encode_grid(bytes(24), generated_at=2000, base_data_ts=1000, n_lots=1)
    h = decode_header(blob)
    assert h["generated_at"] - h["base_data_ts"] == 1000


def test_encode_rejects_a_grid_of_the_wrong_length():
    with pytest.raises(ValueError):
        encode_grid(bytes(47), generated_at=1, base_data_ts=1, n_lots=2)


def lots_json(lots, *, generated_at=1788537600, base_data_ts=1788537300):
    return build_lots_json(lots, generated_at=generated_at,
                           base_data_ts=base_data_ts, n_lots=len(lots))


def test_lots_json_is_index_aligned_and_compact():
    doc = json.loads(lots_json([lot(1), lot(2)]))
    assert [l["i"] for l in doc["lots"]] == [0, 1], "index i must match grid row order"
    assert doc["lots"][0]["id"] == "TPE0001"
    assert "y" in doc["lots"][0] and "x" in doc["lots"][0], "short keys keep the file small"


def test_lots_json_preserves_chinese_names_unescaped():
    assert "停車場1".encode() in lots_json([lot(1)]), "ensure_ascii would triple the file size"


# --- the two artifacts must be pairable -------------------------------------
#
# Row order is recomputed every tick (a lot joins on its first usable reading,
# leaves after a 48h all-null window), and the two files are written by two
# independent renames. Without a shared stamp a client cannot tell that it has
# paired generation N+1 grid rows with generation N metadata -- one insertion at
# index k shifts every later lot, showing lot A's forecast under lot B's name.


def test_lots_json_carries_the_same_identity_as_the_grid_header():
    grid = encode_grid(bytes(48), generated_at=1788537600, base_data_ts=1788537300, n_lots=2)
    doc = json.loads(lots_json([lot(1), lot(2)]))
    header = decode_header(grid)
    for field in ("generated_at", "base_data_ts", "n_lots"):
        assert doc[field] == header[field], f"{field} must mirror the grid header"


def test_lots_json_rejects_a_lot_count_that_contradicts_the_grid():
    """The stamp is worthless if it can disagree with the rows beneath it."""
    with pytest.raises(ValueError):
        build_lots_json([lot(1)], generated_at=1, base_data_ts=1, n_lots=2)


def test_a_client_can_detect_a_stale_lots_json():
    """Simulates the real failure: a fresh grid paired with last generation's
    metadata, where a lot was inserted at index 0 and shifted every row."""
    fresh_grid = encode_grid(bytes(72), generated_at=2000, base_data_ts=1900, n_lots=3)
    stale_lots = json.loads(lots_json([lot(1), lot(2)], generated_at=1000,
                                      base_data_ts=900))

    header = decode_header(fresh_grid)
    mismatched = [
        f for f in ("generated_at", "base_data_ts", "n_lots")
        if stale_lots[f] != header[f]
    ]
    assert mismatched == ["generated_at", "base_data_ts", "n_lots"], (
        "a client comparing the stamps must see the pair is not from one publish"
    )


def test_a_matched_pair_compares_equal():
    """The detection above must not fire on a good pair."""
    grid = encode_grid(bytes(48), generated_at=2000, base_data_ts=1900, n_lots=2)
    doc = json.loads(lots_json([lot(1), lot(2)], generated_at=2000, base_data_ts=1900))
    header = decode_header(grid)
    assert all(doc[f] == header[f]
               for f in ("generated_at", "base_data_ts", "n_lots"))


def test_publish_is_atomic(tmp_path):
    publish(tmp_path, grid_blob=b"GRID", lots_blob=b"LOTS")
    assert (tmp_path / "grid.bin").read_bytes() == b"GRID"
    assert (tmp_path / "lots.json").read_bytes() == b"LOTS"
    assert list(tmp_path.glob("*.tmp")) == [], "temp files must not survive"


def test_publish_overwrites_cleanly(tmp_path):
    publish(tmp_path, grid_blob=b"OLD", lots_blob=b"OLD")
    publish(tmp_path, grid_blob=b"NEW", lots_blob=b"NEW")
    assert (tmp_path / "grid.bin").read_bytes() == b"NEW"
