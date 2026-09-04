import json
from datetime import date
from pathlib import Path

from parkcast.metadata import Lot, capacity_map, parse_metadata, snapshot_metadata

FIXTURE = Path(__file__).parent / "fixtures" / "desc_sample.json"


def _payload():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_parses_every_lot_with_coordinates():
    lots = parse_metadata(_payload())
    assert len(lots) > 1700
    assert all(isinstance(lot, Lot) for lot in lots)
    assert all(lot.lat is not None and lot.lon is not None for lot in lots)


def test_lot_ids_are_unique():
    lots = parse_metadata(_payload())
    assert len({lot.id for lot in lots}) == len(lots)


def test_capacity_is_none_when_zero_rather_than_zero():
    """totalcar=0 means 'not a car park', not 'a car park with no spaces'."""
    payload = {"data": {"park": [
        {"id": "X1", "name": "n", "area": "a", "type2": "t", "totalcar": "0",
         "tw97x": "302864.78", "tw97y": "2771988.95"},
    ]}}
    lots = parse_metadata(payload)
    assert lots[0].capacity_car is None


def test_capacity_map_covers_all_lots():
    lots = parse_metadata(_payload())
    caps = capacity_map(lots)
    assert len(caps) == len(lots)
    assert all(v is None or v > 0 for v in caps.values())


def test_lots_without_usable_coordinates_are_dropped():
    payload = {"data": {"park": [
        {"id": "BAD", "name": "n", "area": "a", "type2": "t", "totalcar": "10",
         "tw97x": "0", "tw97y": "0"},
    ]}}
    assert parse_metadata(payload) == ()


def test_snapshot_is_written_once_per_day(tmp_path):
    """Capacity and lot membership drift; keep a dated copy so history survives."""
    payload = _payload()
    first = snapshot_metadata(payload, tmp_path, date(2026, 9, 4))
    assert first.exists() and first.name == "2026-09-04.json"

    first.write_text("SENTINEL", encoding="utf-8")
    again = snapshot_metadata(payload, tmp_path, date(2026, 9, 4))
    assert again.read_text(encoding="utf-8") == "SENTINEL", "must not rewrite an existing day"


def test_snapshot_round_trips_to_the_same_lots(tmp_path):
    path = snapshot_metadata(_payload(), tmp_path, date(2026, 9, 4))
    restored = json.loads(path.read_text(encoding="utf-8"))
    assert parse_metadata(restored) == parse_metadata(_payload())
