# Full live response on 2026-09-16: 34,308 bytes, 55 records, fetched via
# curl GET to https://hispark.hccg.gov.tw/OpenData/GetParkInfo. Trimmed to
# 19 records in fixtures/sources/hsinchu.json, keeping the bare top-level
# array -- see task-9-report.md for exactly which lots and why.
import json
from pathlib import Path

from parkcast.sources import hsinchu

FIXTURE = json.loads((Path(__file__).parent / "fixtures/sources/hsinchu.json").read_text(encoding="utf-8"))

NOW = 1_758_000_000


def _by_id(observations):
    return {o.lot_id: o for o in observations}


def _raw_by_id(payload):
    return {entry["PARKNO"]: entry for entry in payload}


def test_parses_counts_namespaces_ids_and_stamps_each_record():
    tick = hsinchu.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)

    live = by_id["hsinchu:008"]
    assert live.free_car == 113
    assert live.ts_kind == "record"          # UPDATETIME, not our clock
    assert live.data_ts == 1_789_530_661     # 2026-09-16T11:51:01.85 +08:00
    assert tick.snapshot.city == "hsinchu"


def test_leading_zeros_in_the_feed_id_survive_qualification():
    # PARKNO "004" is not the integer 4 -- the leading zeros are part of the
    # id and must reach the store unchanged.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)
    assert "hsinchu:004" in by_id
    assert "hsinchu:4" not in by_id


def test_a_real_zero_car_count_survives():
    # Lot 004's car is a real, live 0 (the lot is full) -- there is no
    # documented sentinel on this feed, so 0 must survive as 0, not be
    # mistaken for "not reporting".
    tick = hsinchu.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["hsinchu:004"]
    assert obs.free_car == 0


def test_this_city_reports_real_live_motorcycle_counts():
    # Unlike Taoyuan, Hsinchu's FREEQUANTITYMOT is a real live count, not a
    # capacity-only field. At least two fixture lots carry a real,
    # non-zero value alongside a non-zero TOTALQUANTITYMOT.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)
    real_motor = [o for o in tick.snapshot.observations if o.free_motor is not None and o.free_motor > 0]
    assert len(real_motor) >= 2
    assert by_id["hsinchu:008"].free_motor == 36    # TOTALQUANTITYMOT 210
    assert by_id["hsinchu:030"].free_motor == 61    # TOTALQUANTITYMOT 344


def test_car_and_motor_fields_are_independent():
    # Lot 079 is a motorcycle-only lot: FREEQUANTITY is a real 0 (no car
    # capacity at all -- TOTALQUANTITY is also 0) alongside a real,
    # non-zero FREEQUANTITYMOT of 889. Neither field's reading may suppress
    # the other.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["hsinchu:079"]
    assert obs.free_car == 0
    assert obs.free_motor == 889


def test_a_real_zero_motor_count_survives_independently_of_car():
    # Lot 009's motorcycle area is a real, live 0 (full) -- TOTALQUANTITYMOT
    # is a genuine 196, so this is not "no motorcycle spaces exist" -- while
    # its own FREEQUANTITY is a real, non-zero 72. This is lot 079's mirror
    # image (car-zero/motor-real there, motor-zero/car-real here): a full
    # motorcycle area must not collapse into None, and neither field's
    # reading may suppress the other.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["hsinchu:009"]
    assert obs.free_motor == 0
    assert obs.free_car == 72


def test_missing_key_or_non_integer_maps_to_none_without_suppressing_the_other_field():
    # No live record in this feed carried a missing key or a non-integer
    # value on FREEQUANTITY/FREEQUANTITYMOT (all 55 checked 2026-09-16 were
    # plain ints with no negatives) -- there is no documented sentinel to
    # reproduce. These variants are constructed from real records to
    # exercise the fallback rule the brief specifies: a missing key or a
    # non-integer becomes None, and it must not suppress a real reading in
    # the *other* field.
    raw = _raw_by_id(FIXTURE)
    car_missing = {k: v for k, v in raw["030"].items() if k != "FREEQUANTITY"}
    obs = hsinchu.parse([car_missing], now=NOW).snapshot.observations[0]
    assert obs.free_car is None
    assert obs.free_motor == 61  # untouched field still reports its real value

    moto_non_integer = dict(raw["117"], FREEQUANTITYMOT="N/A")
    obs2 = hsinchu.parse([moto_non_integer], now=NOW).snapshot.observations[0]
    assert obs2.free_motor is None
    assert obs2.free_car == 201  # untouched field still reports its real value


def test_a_duplicate_feed_id_keeps_its_first_occurrence():
    # The fixture's two PARKNO="008" records are a synthetic duplicate (no
    # live duplicate id exists in this 55-record feed) that differ in
    # FREEQUANTITY -- a field the parser actually reads: the first copy
    # carries the real 113, the second a distinguishable 77. Asserting the
    # survivor is 113 (and not 77) fails if dedup order ever flips from
    # first-kept to last-kept.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    matches = [o for o in tick.snapshot.observations if o.lot_id == "hsinchu:008"]
    assert len(matches) == 1
    assert matches[0].free_car == 113
    assert matches[0].free_car != 77
    lot_matches = [lot for lot in tick.lots if lot.id == "hsinchu:008"]
    assert len(lot_matches) == 1


def test_carries_its_own_roster_with_usable_coordinates():
    tick = hsinchu.parse(FIXTURE, now=NOW)
    assert tick.lots is not None
    lot = next(l for l in tick.lots if l.id == "hsinchu:008")
    assert lot.name == "赤土崎地下停車場"
    assert lot.area == ""
    assert lot.lot_type == ""
    assert lot.capacity_car == 592           # TOTALQUANTITY, not FREEQUANTITY
    assert 21.5 < lot.lat < 25.5 and 118.0 < lot.lon < 122.5


def test_roster_reads_fare_text_from_weekdays():
    tick = hsinchu.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "hsinchu:121")
    assert lot.fare_text == "汽車：30元/H限高190cm(當日最高300元)，機車：20元/H(當日最高200元)"


def test_latitude_and_longitude_fields_hold_what_their_names_claim():
    # Measured 2026-09-16: treating LATITUDE as latitude and LONGITUDE as
    # longitude landed inside the Taiwan box (sources.geo.in_taiwan) for
    # 55/55 live records; the swapped ordering landed inside it for 0/55.
    # Lot 008's LATITUDE "24.799174" / LONGITUDE "120.993878" is a plausible
    # Hsinchu latitude/longitude pair; swapped, "120.99" as a latitude is
    # outside Taiwan entirely. Unlike Kaohsiung's and Taoyuan's mislabelled
    # coordinate fields, these names are exactly right -- but the adapter
    # still resolves the ordering at runtime via geo.in_taiwan rather than
    # hard-coding it.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "hsinchu:008")
    assert lot.lat == 24.799174
    assert lot.lon == 120.993878


def test_a_lot_with_coordinates_outside_taiwan_under_either_ordering_is_dropped():
    # Synthetic: no live record in this feed had unusable coordinates (all
    # 55 checked 2026-09-16 parsed fine as LATITUDE/LONGITUDE), so fixture
    # id 9001 ("1.0"/"1.0") is fabricated to exercise the drop path -- 1.0,
    # 1.0 fails in_taiwan under both orderings. The reading itself is still
    # kept; only the roster entry, which needs a position to be ranked by
    # distance, is dropped.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    assert not any(lot.id == "hsinchu:9001" for lot in tick.lots)
    by_id = _by_id(tick.snapshot.observations)
    assert by_id["hsinchu:9001"].free_car == 5


def test_a_lot_with_swapped_coordinates_is_recovered_not_dropped():
    # Synthetic: every one of the 55 live records puts LATITUDE=lat,
    # LONGITUDE=lon correctly (see the module docstring and
    # test_latitude_and_longitude_fields_hold_what_their_names_claim), so
    # this feed never exercises _parse_coords's recovery branch on its own.
    # Fixture id 9002 fabricates a reversed pair -- LATITUDE: "120.97",
    # LONGITUDE: "24.80" -- the same kind of swap Kaohsiung's lat/lng and
    # Taoyuan's wgsX/wgsY genuinely ship. The (lat, lon) ordering fails
    # in_taiwan (120.97 is not a latitude); the swapped (lon, lat) ordering
    # succeeds, so the lot must survive with its coordinates corrected, not
    # be dropped.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "hsinchu:9002")
    assert lot.lat == 24.80
    assert lot.lon == 120.97


def test_capacity_zero_means_not_a_car_park_not_full():
    # Lot 068 ("新竹停一機車停車場" -- a motorcycle-only lot) has a real,
    # live TOTALQUANTITY of 0: it never had car spaces to begin with, which
    # is different from "full".
    tick = hsinchu.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "hsinchu:068")
    assert lot.capacity_car is None
    assert lot.serves_cars is False


def test_capacity_missing_or_unparseable_leaves_the_lot_serving_cars():
    raw = {k: v for k, v in _raw_by_id(FIXTURE)["008"].items() if k != "TOTALQUANTITY"}
    lot = hsinchu.parse([raw], now=NOW).lots[0]
    assert lot.capacity_car is None
    assert lot.serves_cars is True


def test_a_record_with_an_unparseable_updatetime_falls_back_to_the_fetch_time():
    broken = dict(_raw_by_id(FIXTURE)["008"], UPDATETIME="not-a-date")
    obs = hsinchu.parse([broken], now=NOW).snapshot.observations[0]
    assert obs.data_ts == NOW
    assert obs.ts_kind == "fetch"


def test_a_record_missing_updatetime_falls_back_to_the_fetch_time():
    raw = {k: v for k, v in _raw_by_id(FIXTURE)["008"].items() if k != "UPDATETIME"}
    obs = hsinchu.parse([raw], now=NOW).snapshot.observations[0]
    assert obs.data_ts == NOW
    assert obs.ts_kind == "fetch"


def test_a_two_digit_fractional_second_is_parsed_as_ts_record():
    # UPDATETIME's fractional-second width varies across this feed -- lot
    # 008 carries ".85" (two digits), unlike the three-digit fractions
    # (".207", ".937") seen elsewhere in the fixture. datetime.fromisoformat
    # accepts fractions of any width from 1-6 digits on this project's
    # Python (>=3.13); this is not the trap it would be on 3.10 or earlier.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["hsinchu:008"]
    assert obs.ts_kind == "record"
    assert obs.data_ts == 1_789_530_661


def test_a_one_digit_fractional_second_is_also_parsed_as_ts_record():
    # Lot 020 carries ".4" -- a single-digit fraction, the narrowest width
    # observed in the live feed.
    tick = hsinchu.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["hsinchu:020"]
    assert obs.ts_kind == "record"
    assert obs.data_ts == 1_789_530_666  # 2026-09-16T11:51:06.4 +08:00
