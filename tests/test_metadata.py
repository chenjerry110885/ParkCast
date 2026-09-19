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
    from parkcast.feed import TS_FEED, FeedSnapshot, Observation

    lots = parse_metadata(_one(id="TPE1697", totalcar="0"))
    assert [lot.id for lot in lots] == ["taipei:TPE1697"], "still parsed, namespaced"

    caps = capacity_map(lots)
    assert caps == {"taipei:TPE1697": None}, "still in the capacity map, with no bound"

    conn = store.connect(tmp_path / "t.sqlite")
    snapshot = FeedSnapshot(
        city="taipei", observed_at=1788485010,
        # The same namespaced id `capacity_map` produced above -- this is what
        # `sources.taipei.parse` actually stamps on every observation, and it
        # is what `caps.get(obs.lot_id)` must match for the lookup to find it.
        observations=(Observation("taipei:TPE1697", free_car=27, free_motor=3,
                                   data_ts=1788484980, ts_kind=TS_FEED),),
    )
    store.insert_snapshot(conn, snapshot, caps)
    stored = conn.execute("SELECT free_car FROM observations").fetchone()
    conn.close()
    assert stored == (27,), "stored unclamped; publishing must not reach back into storage"


# --- capacity_motor / charging: Taipei-only, and 0 must not collapse -------


def test_motor_capacity_and_charging_parse_from_the_feed():
    lots = parse_metadata(_one(totalmotor="30", ChargingStation="2"))
    assert lots[0].capacity_motor == 30
    assert lots[0].charging == 2


def test_zero_motor_capacity_and_charging_stay_zero_unlike_car_capacity():
    """Unlike totalcar, 0 here carries no second meaning about the lot's own
    type -- it is a plain known fact ('we checked, there are none'), not a
    signal to discard. It must stay a real 0, not collapse to None the way
    a 0 totalcar does."""
    lots = parse_metadata(_one(totalmotor="0", ChargingStation="0"))
    assert lots[0].capacity_motor == 0
    assert lots[0].charging == 0


def test_missing_motor_and_charging_fields_are_none_not_zero():
    """The other half of the pin above: a field the feed never sent must not
    collapse onto 0 -- 'not reported' and 'reported zero' are different
    facts. A parser that mapped a missing key to 0 would pass the zero-stays
    test above but fail here, which is the whole point of pinning both."""
    lots = parse_metadata(_one())
    assert lots[0].capacity_motor is None
    assert lots[0].charging is None


def test_unparseable_motor_and_charging_fields_are_none():
    lots = parse_metadata(_one(totalmotor="n/a", ChargingStation="n/a"))
    assert lots[0].capacity_motor is None
    assert lots[0].charging is None


def test_negative_motor_and_charging_fields_are_none():
    lots = parse_metadata(_one(totalmotor="-9", ChargingStation="-9"))
    assert lots[0].capacity_motor is None
    assert lots[0].charging is None


def test_other_city_lots_leave_motor_and_charging_absent_by_default():
    """Only Taipei's parse_metadata ever sets these; every other adapter's
    Lot(...) call (hsinchu.py, kaohsiung.py, newtaipei.py, tainan.py,
    taoyuan.py) leaves them at the dataclass default -- deliberately, per
    docs/sources.md, not because nobody thought about it."""
    lot = Lot(id="kaohsiung:PL_1", name="n", area="a", lot_type="t",
              capacity_car=10, lat=22.6, lon=120.3,
              service_time="", fare_text="")
    assert lot.capacity_motor is None
    assert lot.charging is None


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
