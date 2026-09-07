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


def _one(**overrides) -> dict:
    entry = {"id": "X1", "name": "n", "area": "a", "type2": "t",
             "tw97x": "302864.78", "tw97y": "2771988.95"}
    entry.update(overrides)
    return {"data": {"park": [entry]}}


def test_zero_car_capacity_means_the_lot_does_not_serve_cars():
    """totalcar=0 is a motorcycle or coach park. Its free_car is meaningless."""
    lots = parse_metadata(_one(totalcar="0"))
    assert lots[0].serves_cars is False


def test_sentinel_capacity_still_serves_cars():
    """-9 is 'not reported', not 'no car spaces'.

    Conflating the two would drop a real car park the day the feed starts
    sending -9 in this field. There is none today (measured 2026-09-07: 1,699
    positive, 56 zero, no negatives), which is exactly why this test exists --
    nothing else in the suite would catch that regression.
    """
    lots = parse_metadata(_one(totalcar="-9"))
    assert lots[0].serves_cars is True
    assert lots[0].capacity_car is None, "capacity is unknown, not zero"


def test_absent_totalcar_still_serves_cars():
    lots = parse_metadata(_one())
    assert lots[0].serves_cars is True
    assert lots[0].capacity_car is None


def test_unparseable_totalcar_still_serves_cars():
    lots = parse_metadata(_one(totalcar="n/a"))
    assert lots[0].serves_cars is True
    assert lots[0].capacity_car is None


def test_positive_capacity_serves_cars():
    lots = parse_metadata(_one(totalcar="120"))
    assert lots[0].serves_cars is True
    assert lots[0].capacity_car == 120


def test_zero_car_lots_are_still_parsed_collected_and_stored(tmp_path):
    """The roster change must be invisible to the corpus.

    A zero-car lot stays in `parse_metadata`, stays in `capacity_map` with a
    None capacity, and its raw free_car is stored unclamped. Letting capacity 0
    reach `validate` would clamp free_car to 0 from that moment on and
    manufacture a discontinuity inside the training data.
    """
    from parkcast import store
    from parkcast.feed import FeedSnapshot, Observation

    lots = parse_metadata(_one(id="TPE1697", totalcar="0"))
    assert [lot.id for lot in lots] == ["TPE1697"], "still parsed"

    caps = capacity_map(lots)
    assert caps == {"TPE1697": None}, "still in the capacity map, with no bound"

    conn = store.connect(tmp_path / "t.sqlite")
    snapshot = FeedSnapshot(
        data_ts=1788484980, observed_at=1788485010,
        observations=(Observation("TPE1697", free_car=27, free_motor=3),),
    )
    store.insert_snapshot(conn, snapshot, caps)
    stored = conn.execute("SELECT free_car FROM observations").fetchone()
    conn.close()
    assert stored == (27,), "stored unclamped; publishing must not reach back into storage"


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
