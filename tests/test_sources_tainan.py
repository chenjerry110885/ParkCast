# Full live response on 2026-09-16: 137,146 bytes, 268 records, fetched via
# curl GET to https://parkweb.tainan.gov.tw/api/parking.php. Trimmed to 16
# records in fixtures/sources/tainan.json, keeping the bare top-level array
# -- see task-7-report.md for exactly which lots and why.
import json
from pathlib import Path

from parkcast.sources import tainan

FIXTURE = json.loads((Path(__file__).parent / "fixtures/sources/tainan.json").read_text(encoding="utf-8"))

NOW = 1_758_000_000


def _by_id(observations):
    return {o.lot_id: o for o in observations}


def _raw_by_id(payload):
    return {entry["id"]: entry for entry in payload}


def test_parses_counts_namespaces_ids_and_stamps_each_record():
    tick = tainan.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)

    live = by_id["tainan:1"]
    assert live.free_car == 348
    assert live.ts_kind == "record"          # update_time, not our clock
    assert live.data_ts == 1_789_529_402     # 2026-09-16 11:30:02 +08:00
    assert tick.snapshot.city == "tainan"


def test_a_real_zero_car_count_survives():
    # Lot 131's car is a real, live 0 (the lot is full) -- there is no
    # documented sentinel on this feed, so 0 must survive as 0, not be
    # mistaken for "not reporting".
    tick = tainan.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["tainan:131"]
    assert obs.free_car == 0
    assert obs.free_motor == 0


def test_this_city_reports_real_live_motorcycle_counts():
    # Unlike New Taipei, Tainan's moto is a real live count, not a capacity
    # field. At least two fixture lots carry a real, non-zero value.
    tick = tainan.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)
    real_motor = [o for o in tick.snapshot.observations if o.free_motor is not None and o.free_motor > 0]
    assert len(real_motor) >= 2
    assert by_id["tainan:129"].free_motor == 52
    assert by_id["tainan:415"].free_motor == 95


def test_car_and_motor_zero_free_fields_are_independent():
    # Lot 316: car is a real 0 (full) alongside a real, non-zero moto (98).
    # Neither field's reading may suppress the other.
    tick = tainan.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["tainan:316"]
    assert obs.free_car == 0
    assert obs.free_motor == 98


def test_missing_key_or_non_integer_maps_to_none_without_suppressing_the_other_field():
    # No live record in this feed carried a missing key or a non-integer
    # value on car/moto (all 268 checked 2026-09-16 were plain ints with no
    # negatives) -- there is no documented sentinel to reproduce. These
    # variants are constructed from real records to exercise the fallback
    # rule the brief specifies: a missing key or a non-integer becomes None,
    # and it must not suppress a real reading in the *other* field.
    raw = _raw_by_id(FIXTURE)
    car_missing = {k: v for k, v in raw["129"].items() if k != "car"}
    obs = tainan.parse([car_missing], now=NOW).snapshot.observations[0]
    assert obs.free_car is None
    assert obs.free_motor == 52  # untouched field still reports its real value

    moto_non_integer = dict(raw["415"], moto="N/A")
    obs2 = tainan.parse([moto_non_integer], now=NOW).snapshot.observations[0]
    assert obs2.free_motor is None
    assert obs2.free_car == 23  # untouched field still reports its real value


def test_a_duplicate_feed_id_keeps_its_first_occurrence():
    # The fixture's two id="1" records are a synthetic duplicate (no live
    # duplicate id exists in this feed -- all 268 ids checked 2026-09-16 were
    # unique) that differ in car -- a field the parser actually reads: the
    # first copy carries the real 348, the second a distinguishable 77.
    # Asserting the survivor is 348 (and not 77) fails if dedup order ever
    # flips from first-kept to last-kept.
    tick = tainan.parse(FIXTURE, now=NOW)
    matches = [o for o in tick.snapshot.observations if o.lot_id == "tainan:1"]
    assert len(matches) == 1
    assert matches[0].free_car == 348
    assert matches[0].free_car != 77
    lot_matches = [lot for lot in tick.lots if lot.id == "tainan:1"]
    assert len(lot_matches) == 1


def test_carries_its_own_roster_with_usable_coordinates():
    tick = tainan.parse(FIXTURE, now=NOW)
    assert tick.lots is not None
    lot = next(l for l in tick.lots if l.id == "tainan:1")
    assert lot.name == "海安路地下停車場"
    assert lot.area == "中西區"
    assert lot.lot_type == "公有收費停車場"
    assert lot.capacity_car == 909            # car_total, not car
    assert 21.5 < lot.lat < 25.5 and 118.0 < lot.lon < 122.5


def test_roster_reads_fare_text_from_chargefee():
    tick = tainan.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "tainan:131")
    assert lot.fare_text == "平日：$20/H,當日當次最高上限$120；假日：$20/H,當日當次最高上限$150"


def test_lnglat_actually_holds_lat_then_lng_despite_its_name():
    # lnglat's name implies "lng,lat", but every one of the 268 live records
    # checked 2026-09-16 puts a valid Taiwan *latitude* (21-25) first and a
    # valid *longitude* (118-122.5) second -- e.g. lot 1's
    # "22.991501,120.195621" is latitude 22.99, longitude 120.20 (central
    # Tainan). Swapping the pair never lands inside the Taiwan box for any
    # of the 268 records checked. The field is misnamed: its content is
    # "lat,lng", not "lng,lat".
    tick = tainan.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "tainan:1")
    assert lot.lat == 22.991501
    assert lot.lon == 120.195621


def test_a_lot_with_coordinates_outside_taiwan_under_either_ordering_is_dropped():
    # Synthetic: no live record in this feed had unusable coordinates (all
    # 268 checked 2026-09-16 parsed fine as lat,lng), so fixture id 9001
    # ("1.0,1.0") is fabricated to exercise the drop path -- 1.0,1.0 fails
    # in_taiwan under both orderings. The reading itself is still kept; only
    # the roster entry, which needs a position to be ranked by distance, is
    # dropped.
    tick = tainan.parse(FIXTURE, now=NOW)
    assert not any(lot.id == "tainan:9001" for lot in tick.lots)
    by_id = _by_id(tick.snapshot.observations)
    assert by_id["tainan:9001"].free_car == 5


def test_capacity_zero_means_not_a_car_park_not_full():
    # No live record in this feed had car_total == 0 (all 268 checked
    # 2026-09-16 serve cars), so this variant is constructed to exercise the
    # "0 means not a car park" convention shared with every other adapter.
    raw = dict(_raw_by_id(FIXTURE)["1"], car_total=0)
    lot = tainan.parse([raw], now=NOW).lots[0]
    assert lot.capacity_car is None
    assert lot.serves_cars is False


def test_capacity_missing_or_unparseable_leaves_the_lot_serving_cars():
    raw = {k: v for k, v in _raw_by_id(FIXTURE)["1"].items() if k != "car_total"}
    lot = tainan.parse([raw], now=NOW).lots[0]
    assert lot.capacity_car is None
    assert lot.serves_cars is True


def test_a_record_with_an_unparseable_update_time_falls_back_to_the_fetch_time():
    broken = dict(_raw_by_id(FIXTURE)["1"], update_time="not-a-date")
    obs = tainan.parse([broken], now=NOW).snapshot.observations[0]
    assert obs.data_ts == NOW
    assert obs.ts_kind == "fetch"


def test_a_record_missing_update_time_falls_back_to_the_fetch_time():
    raw = {k: v for k, v in _raw_by_id(FIXTURE)["1"].items() if k != "update_time"}
    obs = tainan.parse([raw], now=NOW).snapshot.observations[0]
    assert obs.data_ts == NOW
    assert obs.ts_kind == "fetch"


def test_an_old_but_well_formed_update_time_is_still_read_as_ts_record():
    # Lot 460 was last stamped 2024-06-04 08:30:30 (Taipei time) in the live
    # feed -- verified by hand: 2024-06-04 08:30:30 +08:00 is 2024-06-04
    # 00:30:30 UTC, i.e. epoch 1,717,461,030.
    tick = tainan.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["tainan:460"]
    assert obs.data_ts == 1_717_461_030
    assert obs.ts_kind == "record"
    assert obs.free_car == 7
    assert obs.free_motor == 2
