# Full live response on 2026-09-16: 1,623,471 bytes, 1,447 records, fetched
# via curl POST to https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLotPost
# with body b"{}". Trimmed to 18 records in fixtures/sources/kaohsiung.json,
# keeping the {"parkingLots": [...]} envelope -- see task-6-report.md for
# exactly which lots and why.
import json
from pathlib import Path

from parkcast.sources import kaohsiung

FIXTURE = json.loads((Path(__file__).parent / "fixtures/sources/kaohsiung.json").read_text(encoding="utf-8"))

NOW = 1_758_000_000


def _by_id(observations):
    return {o.lot_id: o for o in observations}


def test_parses_counts_namespaces_ids_and_stamps_with_fetch_time():
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)

    live = by_id["kaohsiung:PL_KHA00261"]
    assert live.free_car == 33
    assert tick.snapshot.city == "kaohsiung"

    # There is no timestamp anywhere in this feed -- every observation takes
    # data_ts=now with ts_kind=fetch, never a per-record or per-feed stamp.
    assert all(o.data_ts == NOW and o.ts_kind == "fetch" for o in tick.snapshot.observations)


def test_both_sentinels_map_to_none_and_zero_survives():
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)

    # -1 and -2 both mean "not reporting" here (not Taipei's -9) and must
    # arrive as None -- never as a number, and never dropped.
    assert by_id["kaohsiung:PL_KHB01235"].free_car is None   # -1
    assert by_id["kaohsiung:PL_KHB00035"].free_car is None   # -2

    # 0 is a real reading (the lot is full), not a sentinel, and must survive.
    assert by_id["kaohsiung:PL_KHB01116"].free_car == 0


def test_car_and_motor_sentinels_are_independent_of_each_other():
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)

    # PL_KHA00261: a real car count alongside a motorcycle sentinel -- the
    # motorcycle field's -1 must not suppress the car field's real 33.
    trap = by_id["kaohsiung:PL_KHA00261"]
    assert trap.free_car == 33
    assert trap.free_motor is None

    # PL_KHB01153: the reverse -- car is the sentinel (-2) while motorcycle
    # reports a real, non-negative count. Neither field's sentinel may leak
    # into the other.
    reverse_trap = by_id["kaohsiung:PL_KHB01153"]
    assert reverse_trap.free_car is None
    assert reverse_trap.free_motor == 171


def test_this_city_reports_real_live_motorcycle_counts():
    # Unlike New Taipei, Kaohsiung's motorcycleVacancy is a real live count,
    # not a capacity field. At least two fixture lots carry a real value.
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)
    real_motor = [o for o in tick.snapshot.observations if o.free_motor is not None]
    assert len(real_motor) >= 2
    assert by_id["kaohsiung:PL_KHB00914"].free_motor == 83


def test_a_duplicate_feed_id_keeps_its_first_occurrence():
    # The fixture's two PL_KHB00035 records are a synthetic duplicate (no
    # live duplicate id exists in this feed, see task-6-report.md) that
    # differ in smallcarVacancy -- a field the parser actually reads: the
    # first copy carries the real -2 sentinel, the second a distinguishable
    # 77. Asserting the survivor is None (and not 77) fails if dedup order
    # ever flips from first-kept to last-kept.
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    matches = [o for o in tick.snapshot.observations if o.lot_id == "kaohsiung:PL_KHB00035"]
    assert len(matches) == 1
    assert matches[0].free_car is None
    assert matches[0].free_car != 77
    lot_matches = [lot for lot in tick.lots if lot.id == "kaohsiung:PL_KHB00035"]
    assert len(lot_matches) == 1


def test_carries_its_own_roster_with_usable_coordinates():
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    assert tick.lots is not None
    lot = next(l for l in tick.lots if l.id == "kaohsiung:PL_KHA00261")
    assert lot.name == "五都文守停車場"
    assert lot.area == "左營區"
    assert 21.5 < lot.lat < 25.5 and 118.0 < lot.lon < 122.5
    assert lot.capacity_car == 146          # volumnAuto
    assert lot.fare_text == "計時15元/半小時"
    assert lot.lot_type == "平面"           # ownername


def test_a_lot_with_coordinates_outside_taiwan_is_dropped_from_the_roster():
    # PL_KHB01235 carries lat/lng of "1.0"/"1.0" in the live feed -- nowhere
    # near Taiwan. It must be dropped from the roster; it cannot be ranked
    # by distance.
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    assert not any(lot.id == "kaohsiung:PL_KHB01235" for lot in tick.lots)


def test_capacity_falls_back_from_volumnauto_to_volumn():
    # PL_KHB00125 has volumnAuto == null but volumn == "0": the fallback
    # field is what must be read, and 0 means "not a car park", not "empty".
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "kaohsiung:PL_KHB00125")
    assert lot.capacity_car is None
    assert lot.serves_cars is False


def test_a_real_zero_motorcycle_count_survives():
    # PL_KHB00714 carries a real, live motorcycleVacancy of 0 (the
    # motorcycle area is genuinely full) alongside a real car count of 1 --
    # 0 must survive as 0, not collapse into the sentinel's None.
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)
    obs = by_id["kaohsiung:PL_KHB00714"]
    assert obs.free_motor == 0
    assert obs.free_car == 1


def test_the_undocumented_negative_three_sentinel_also_maps_to_none():
    # PL_KHB00019 carries -3 on both smallcarVacancy and motorcycleVacancy
    # in the live feed -- a third sentinel value the brief never mentions.
    # clean_count maps every negative value to None, so this is free: no
    # adapter change was needed to handle it correctly.
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)
    obs = by_id["kaohsiung:PL_KHB00019"]
    assert obs.free_car is None
    assert obs.free_motor is None


def test_capacity_missing_or_unparseable_leaves_the_lot_serving_cars():
    # PL_KHA00133 has volumnAuto == null and volumn == "-1" -- neither field
    # gives a usable capacity, which is a different fact from "not a car
    # park" and must not set serves_cars to False.
    tick = kaohsiung.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "kaohsiung:PL_KHA00133")
    assert lot.capacity_car is None
    assert lot.serves_cars is True
