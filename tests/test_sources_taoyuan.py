# Full live response on 2026-09-16: 179,203 bytes, 246 records, fetched via
# curl GET to
# https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0381e141-f7ee-450e-99da-2240208d1773/download.
# Trimmed to 18 records in fixtures/sources/taoyuan.json, keeping the bare
# top-level array -- see task-8-report.md for exactly which lots and why.
import json
from pathlib import Path

from parkcast.sources import taoyuan

FIXTURE = json.loads((Path(__file__).parent / "fixtures/sources/taoyuan.json").read_text(encoding="utf-8"))

NOW = 1_758_000_000


def _by_id(observations):
    return {o.lot_id: o for o in observations}


def _raw_by_id(payload):
    return {entry["parkId"]: entry for entry in payload}


def test_parses_counts_namespaces_ids_and_stamps_with_fetch_time():
    tick = taoyuan.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)

    live = by_id["taoyuan:P-BD-001"]
    assert live.free_car == 12
    assert tick.snapshot.city == "taoyuan"

    # No timestamp anywhere in this feed -- every observation takes
    # data_ts=now with ts_kind=fetch, never a per-record or per-feed stamp.
    assert all(o.data_ts == NOW and o.ts_kind == "fetch" for o in tick.snapshot.observations)


def test_every_numeric_value_arrives_as_a_string_but_parses_fine():
    # The fixture itself carries JSON strings, not numbers -- confirm that
    # before trusting the parsed int downstream.
    raw = _raw_by_id(FIXTURE)["P-BD-001"]
    assert isinstance(raw["surplusSpace"], str)
    assert isinstance(raw["totalSpace"], str)

    tick = taoyuan.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["taoyuan:P-BD-001"]
    assert obs.free_car == 12  # int("12"), not the literal string


def test_this_feed_has_no_motorcycle_field_at_all():
    tick = taoyuan.parse(FIXTURE, now=NOW)
    assert all(o.free_motor is None for o in tick.snapshot.observations)


def test_a_real_zero_car_count_survives():
    # P-DW-014 and P-GS-006 both carry a real, live surplusSpace of "0" (the
    # lot is full) -- there is no documented sentinel on this feed, so 0
    # must survive as 0, not be mistaken for "not reporting".
    tick = taoyuan.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)
    assert by_id["taoyuan:P-DW-014"].free_car == 0
    assert by_id["taoyuan:P-GS-006"].free_car == 0


def test_an_undocumented_non_numeric_status_string_maps_to_none():
    # P-BD-009 reports "開放中" ("open") on surplusSpace instead
    # of a count in the live feed -- an undocumented case int() rejects.
    tick = taoyuan.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["taoyuan:P-BD-009"]
    assert obs.free_car is None


def test_missing_or_blank_surplusspace_maps_to_none_without_raising():
    raw = _raw_by_id(FIXTURE)["P-BD-001"]

    missing = {k: v for k, v in raw.items() if k != "surplusSpace"}
    assert taoyuan.parse([missing], now=NOW).snapshot.observations[0].free_car is None

    blank = dict(raw, surplusSpace="")
    assert taoyuan.parse([blank], now=NOW).snapshot.observations[0].free_car is None

    not_a_number = dict(raw, surplusSpace="N/A")
    assert taoyuan.parse([not_a_number], now=NOW).snapshot.observations[0].free_car is None


def test_a_duplicate_feed_id_keeps_its_first_occurrence():
    # The fixture's two P-BD-001 records are a synthetic duplicate (no live
    # duplicate parkId exists in this feed -- all 246 checked 2026-09-16
    # were unique) that differ in surplusSpace -- a field the parser
    # actually reads: the first copy carries the real 12, the second a
    # distinguishable 77. Asserting the survivor is 12 (and not 77) fails if
    # dedup order ever flips from first-kept to last-kept.
    tick = taoyuan.parse(FIXTURE, now=NOW)
    matches = [o for o in tick.snapshot.observations if o.lot_id == "taoyuan:P-BD-001"]
    assert len(matches) == 1
    assert matches[0].free_car == 12
    assert matches[0].free_car != 77
    lot_matches = [lot for lot in tick.lots if lot.id == "taoyuan:P-BD-001"]
    assert len(lot_matches) == 1


def test_carries_its_own_roster_with_usable_coordinates():
    tick = taoyuan.parse(FIXTURE, now=NOW)
    assert tick.lots is not None
    lot = next(l for l in tick.lots if l.id == "taoyuan:P-BD-001")
    assert lot.name == "大湳公有停車場(桃交)"
    assert lot.area == "八德區"
    assert lot.lot_type == ""
    assert lot.capacity_car == 207            # totalSpace, not surplusSpace
    assert lot.fare_text == "小型車-臨停:40/時，小型車-月租:4000/月"
    assert 21.5 < lot.lat < 25.5 and 118.0 < lot.lon < 122.5


def test_wgsx_and_wgsy_are_swapped_relative_to_their_names():
    # wgsX's name implies longitude and wgsY's implies latitude; the live
    # feed holds the opposite. Every one of the 246 live records checked
    # 2026-09-16 has a valid Taiwan *latitude* (~24.8-25.1) in wgsX and a
    # valid *longitude* (~120.8-121.4) in wgsY -- e.g. lot P-BD-001's
    # wgsX="24.959", wgsY="121.2985" is latitude 24.959, longitude 121.2985
    # (Bade District, Taoyuan). The un-swapped ordering never lands in
    # Taiwan for any of the 246 records.
    raw = _raw_by_id(FIXTURE)["P-BD-001"]
    assert raw["wgsX"] == "24.959"
    assert raw["wgsY"] == "121.2985"

    tick = taoyuan.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "taoyuan:P-BD-001")
    assert lot.lat == 24.959
    assert lot.lon == 121.2985


def test_a_lot_with_coordinates_outside_taiwan_under_either_ordering_is_dropped():
    # Synthetic: no live record in this feed had unusable coordinates (all
    # 246 checked 2026-09-16 parsed fine under the swapped ordering), so
    # fixture id P-BAD-9001 (wgsX="1.0", wgsY="1.0") is fabricated to
    # exercise the drop path -- 1.0/1.0 fails in_taiwan under both
    # orderings. The reading itself is still kept; only the roster entry,
    # which needs a position to be ranked by distance, is dropped.
    tick = taoyuan.parse(FIXTURE, now=NOW)
    assert not any(lot.id == "taoyuan:P-BAD-9001" for lot in tick.lots)
    by_id = _by_id(tick.snapshot.observations)
    assert by_id["taoyuan:P-BAD-9001"].free_car == 5


def test_capacity_zero_means_not_a_car_park_not_full():
    # P-TY-022 carries a real, live totalSpace of "0" in the live feed (it
    # is a motorcycle-only lot) -- the "0 means not a car park" convention
    # shared with every other adapter.
    tick = taoyuan.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "taoyuan:P-TY-022")
    assert lot.capacity_car is None
    assert lot.serves_cars is False


def test_capacity_missing_or_unparseable_leaves_the_lot_serving_cars():
    raw = {k: v for k, v in _raw_by_id(FIXTURE)["P-BD-001"].items() if k != "totalSpace"}
    lot = taoyuan.parse([raw], now=NOW).lots[0]
    assert lot.capacity_car is None
    assert lot.serves_cars is True
