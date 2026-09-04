import json
import struct

import pytest

from parkcast.artifacts import (HEADER_SIZE, MAGIC, VERSION, build_lots_json,
                                decode_header, encode_grid, publish, roster_id)
from parkcast.metadata import Lot


def lot(i):
    return Lot(id=f"TPE{i:04d}", name=f"停車場{i}", area="中正區", lot_type="立體",
               capacity_car=50, lat=25.05 + i / 1000, lon=121.52 + i / 1000,
               service_time="00:00:00-23:59:59", fare_text="每小時30元")


def ids(*numbers):
    return [f"TPE{i:04d}" for i in numbers]


def test_header_round_trips():
    blob = encode_grid(bytes(48), generated_at=1788537600, base_data_ts=1788537300,
                       lot_ids=ids(1, 2))
    h = decode_header(blob)
    assert h["magic"] == MAGIC
    assert h["generated_at"] == 1788537600
    assert h["base_data_ts"] == 1788537300
    assert h["n_lots"] == 2
    assert h["n_horizons"] == 24
    assert h["horizon_step_min"] == 5
    assert h["roster_id"] == roster_id(ids(1, 2))


def test_header_is_21_bytes_and_payload_follows():
    blob = encode_grid(bytes(48), generated_at=1, base_data_ts=1, lot_ids=ids(1, 2))
    assert HEADER_SIZE == 21
    assert len(blob) == HEADER_SIZE + 48


def test_base_data_ts_is_kept_separate_from_generated_at():
    """The client must be able to see how stale the underlying reading is."""
    blob = encode_grid(bytes(24), generated_at=2000, base_data_ts=1000, lot_ids=ids(1))
    h = decode_header(blob)
    assert h["generated_at"] - h["base_data_ts"] == 1000


def test_encode_rejects_a_grid_of_the_wrong_length():
    with pytest.raises(ValueError):
        encode_grid(bytes(47), generated_at=1, base_data_ts=1, lot_ids=ids(1, 2))


def lots_json(lots, *, generated_at=1788537600, base_data_ts=1788537300):
    return build_lots_json(lots, generated_at=generated_at, base_data_ts=base_data_ts)


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


STAMPS = ("generated_at", "base_data_ts", "n_lots", "roster_id")


def test_lots_json_carries_the_same_identity_as_the_grid_header():
    grid = encode_grid(bytes(48), generated_at=1788537600, base_data_ts=1788537300,
                       lot_ids=ids(1, 2))
    doc = json.loads(lots_json([lot(1), lot(2)]))
    header = decode_header(grid)
    for field in STAMPS:
        assert doc[field] == header[field], f"{field} must mirror the grid header"


def test_lots_json_stamps_cannot_contradict_its_own_rows():
    """A stamp that can disagree with the rows beneath it is worse than no
    stamp, so both are derived from `lots` rather than accepted as arguments."""
    doc = json.loads(lots_json([lot(1), lot(2), lot(3)]))
    assert doc["n_lots"] == len(doc["lots"]) == 3
    assert doc["roster_id"] == roster_id([l["id"] for l in doc["lots"]])


def test_lots_json_carries_a_schema_version():
    """grid.bin has a version byte; without one here a future client could not
    tell a v1 lots.json from a v2 one."""
    grid = decode_header(encode_grid(bytes(24), generated_at=1, base_data_ts=1,
                                     lot_ids=ids(1)))
    assert json.loads(lots_json([lot(1)]))["v"] == VERSION == grid["version"]


def test_a_client_can_detect_a_stale_lots_json():
    """Simulates the real failure: a fresh grid paired with last generation's
    metadata, where a lot was inserted at index 0 and shifted every row."""
    fresh_grid = encode_grid(bytes(72), generated_at=2000, base_data_ts=1900,
                             lot_ids=ids(0, 1, 2))
    stale_lots = json.loads(lots_json([lot(1), lot(2)], generated_at=1000,
                                      base_data_ts=900))

    header = decode_header(fresh_grid)
    assert [f for f in STAMPS if stale_lots[f] != header[f]] == list(STAMPS), (
        "a client comparing the stamps must see the pair is not from one publish"
    )


def test_a_matched_pair_compares_equal():
    """The detection above must not fire on a good pair."""
    grid = encode_grid(bytes(48), generated_at=2000, base_data_ts=1900,
                       lot_ids=ids(1, 2))
    doc = json.loads(lots_json([lot(1), lot(2)], generated_at=2000, base_data_ts=1900))
    header = decode_header(grid)
    assert all(doc[f] == header[f] for f in STAMPS)


# --- roster_id: what makes lots.json cacheable ------------------------------
#
# generated_at moves every five minutes, the roster almost never does. Without
# a field that distinguishes the two, a client enforcing the pairing check would
# reject every cross-tick fetch and be forced to re-download ~300 KB of
# lots.json each tick -- or to drop the check, which is what actually happens.


def test_roster_id_is_stable_across_generations():
    """The whole point: an unchanged roster keeps its identity, so a cached
    lots.json still pairs with a grid published five minutes later."""
    early = json.loads(lots_json([lot(1), lot(2)], generated_at=1000, base_data_ts=900))
    later = json.loads(lots_json([lot(1), lot(2)], generated_at=2000, base_data_ts=1900))
    assert early["generated_at"] != later["generated_at"]
    assert early["roster_id"] == later["roster_id"]


def test_roster_id_changes_when_the_order_changes():
    """Row order *is* the alignment, so a permutation must not compare equal
    even though the set and the count are identical."""
    a = json.loads(lots_json([lot(1), lot(2)]))
    b = json.loads(lots_json([lot(2), lot(1)]))
    assert a["n_lots"] == b["n_lots"] == 2
    assert a["roster_id"] != b["roster_id"]


def test_roster_id_changes_when_a_lot_joins_or_leaves():
    base = json.loads(lots_json([lot(1), lot(2)]))["roster_id"]
    joined = json.loads(lots_json([lot(1), lot(2), lot(3)]))["roster_id"]
    left = json.loads(lots_json([lot(1)]))["roster_id"]
    assert base != joined != left != base


def test_roster_id_catches_the_swap_n_lots_cannot_see():
    """One lot joining while another leaves in the same tick shifts every row
    between them while n_lots holds -- the gap roster_id exists to close."""
    before = json.loads(lots_json([lot(1), lot(2), lot(3)]))
    after = json.loads(lots_json([lot(1), lot(3), lot(4)]))
    assert before["n_lots"] == after["n_lots"], "n_lots is blind to this"
    assert before["roster_id"] != after["roster_id"]


def test_roster_id_is_an_unsigned_32_bit_value():
    """It goes into an unsigned header field; a signed CRC would not pack."""
    for numbers in ((1,), (1, 2), tuple(range(50))):
        assert 0 <= roster_id(ids(*numbers)) <= 0xFFFFFFFF


def test_both_encoders_agree_on_the_roster_of_the_same_lots():
    """One helper, two callers: the grid header and lots.json must never be
    able to compute different identities for the same rows."""
    lots = [lot(i) for i in (7, 3, 11)]
    grid = encode_grid(bytes(72), generated_at=5, base_data_ts=4,
                       lot_ids=[l.id for l in lots])
    assert decode_header(grid)["roster_id"] == json.loads(lots_json(lots))["roster_id"]


def test_publish_is_atomic(tmp_path):
    publish(tmp_path, grid_blob=b"GRID", lots_blob=b"LOTS")
    assert (tmp_path / "grid.bin").read_bytes() == b"GRID"
    assert (tmp_path / "lots.json").read_bytes() == b"LOTS"
    assert list(tmp_path.glob("*.tmp")) == [], "temp files must not survive"


def test_publish_overwrites_cleanly(tmp_path):
    publish(tmp_path, grid_blob=b"OLD", lots_blob=b"OLD")
    publish(tmp_path, grid_blob=b"NEW", lots_blob=b"NEW")
    assert (tmp_path / "grid.bin").read_bytes() == b"NEW"
