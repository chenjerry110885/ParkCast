# Full live response on 2026-09-16: 5,582,704 bytes, 3,824 records. (The
# task brief's own estimate of ~500 KB undercounts the live feed by ~11x --
# measured directly with curl, see the fixture provenance note in
# .superpowers/sdd/todo/task-5-report.md.)
import json
from pathlib import Path

from parkcast.sources import newtaipei

FIXTURE = json.loads((Path(__file__).parent / "fixtures/sources/newtaipei.json").read_text(encoding="utf-8"))

NOW = 1_758_000_000


def _by_id(observations):
    return {o.lot_id: o for o in observations}


def test_parses_counts_namespaces_ids_and_stamps_each_record():
    tick = newtaipei.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)

    live = by_id["newtaipei:010001"]
    assert live.free_car == 24
    assert live.ts_kind == "record"          # recdate/rectime, not our clock
    assert live.data_ts == 1_789_527_661     # 2026-09-16 11:01:01 +08:00
    assert tick.snapshot.city == "newtaipei"


def test_all_three_sentinels_map_to_none_and_zero_survives():
    tick = newtaipei.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)

    # null, -1 and -2 all mean "not reporting" and must arrive as None --
    # never as a number, and never dropped: "seen, reported nothing" is a
    # fact in its own right.
    assert by_id["newtaipei:010028"].free_car is None   # JSON null
    assert by_id["newtaipei:010260"].free_car is None   # -1
    assert by_id["newtaipei:099999"].free_car is None   # -2 (see report: no
    # live record carried -2 on the day this fixture was recorded, so this
    # one record is a cloned/edited copy of 010028 -- documented in the
    # report, not silently substituted)

    # 0 is a real reading (lot is full), not a sentinel, and must survive.
    assert by_id["newtaipei:010116"].free_car == 0


def test_new_taipei_never_publishes_a_live_motorcycle_count():
    tick = newtaipei.parse(FIXTURE, now=NOW)
    # 010002 and 020001 both carry a real, non-zero motoNum (motorcycle
    # *capacity*) in the fixture -- confirming free_motor stays None even
    # for lots that plainly have motorcycle parking is the point of the test.
    assert all(o.free_motor is None for o in tick.snapshot.observations)


def test_a_record_whose_stamp_will_not_parse_falls_back_to_the_fetch_time():
    broken = [dict(FIXTURE[0], recdate="badvalue", rectime="??????")]
    obs = newtaipei.parse(broken, now=NOW).snapshot.observations[0]
    assert obs.data_ts == NOW
    assert obs.ts_kind == "fetch"


def test_the_literal_string_sentinel_in_the_live_feed_also_falls_back():
    # 060052 in the live feed carries recdate/rectime == "string" (not a
    # placeholder we invented) alongside a perfectly real NowCarSpace -- the
    # fallback and a real reading can and do co-occur.
    tick = newtaipei.parse(FIXTURE, now=NOW)
    obs = _by_id(tick.snapshot.observations)["newtaipei:060052"]
    assert obs.free_car == 10
    assert obs.ts_kind == "fetch"
    assert obs.data_ts == NOW


def test_a_duplicate_feed_id_keeps_its_first_occurrence():
    # The fixture's two 010001 records differ only in `parkingFee`; the feed
    # id is what identifies "the same lot twice".
    tick = newtaipei.parse(FIXTURE, now=NOW)
    matches = [o for o in tick.snapshot.observations if o.lot_id == "newtaipei:010001"]
    assert len(matches) == 1
    lot_matches = [lot for lot in tick.lots if lot.id == "newtaipei:010001"]
    assert len(lot_matches) == 1


def test_carries_its_own_roster_with_usable_coordinates():
    tick = newtaipei.parse(FIXTURE, now=NOW)
    assert tick.lots is not None
    lot = next(l for l in tick.lots if l.id == "newtaipei:010001")
    assert lot.name == "莊敬立體停車場"
    assert 24.0 < lot.lat < 25.5 and 121.0 < lot.lon < 122.5
    assert lot.capacity_car == 280           # carNum, not NowCarSpace
    assert lot.area == "板橋區"


def test_district_is_read_after_the_city_name_not_the_first_qu_in_the_address():
    # 010275's address is "B區：新北市板橋區板城路271-1號對面空地" -- a
    # naive "substring ending in 區" would stop at "B區" and miss the real
    # district entirely.
    tick = newtaipei.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "newtaipei:010275")
    assert lot.area == "板橋區"


def test_a_lot_with_no_usable_coordinates_is_dropped_from_the_roster_but_not_the_reading():
    # 010299's Lng field ("296139.9") is corrupt in the live feed -- far
    # outside Taiwan -- while its NowCarSpace is a perfectly real 21. The
    # reading is still worth keeping; only the roster entry, which needs a
    # position to be ranked by distance, is dropped.
    tick = newtaipei.parse(FIXTURE, now=NOW)
    by_id = _by_id(tick.snapshot.observations)
    assert by_id["newtaipei:010299"].free_car == 21
    assert not any(lot.id == "newtaipei:010299" for lot in tick.lots)


def test_capacity_zero_means_not_a_car_park_not_full():
    # 010116 has carNum == 0 (it is a motorcycle-only transfer lot, motoNum
    # 575) and a real NowCarSpace of 0 -- capacity_car must read None with
    # serves_cars False, not "zero spaces left".
    tick = newtaipei.parse(FIXTURE, now=NOW)
    lot = next(l for l in tick.lots if l.id == "newtaipei:010116")
    assert lot.capacity_car is None
    assert lot.serves_cars is False


def test_roc_timestamp_conversion_and_its_failure_mode():
    assert newtaipei._roc_timestamp("1150916", "094529") == 1_789_523_129
    assert newtaipei._roc_timestamp("badvalue", "??????") is None
    assert newtaipei._roc_timestamp(None, None) is None
    assert newtaipei._roc_timestamp("string", "string") is None
