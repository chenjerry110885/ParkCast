import json
from pathlib import Path

from parkcast.feed import FeedSnapshot, parse_updatetime
from parkcast.sources import SourceTick, taipei

# Reuses the fixture already captured for Task 1 (`tests/fixtures/avail_sample.json`,
# 489,523 bytes, 1,174 records) rather than a fresh trimmed one: Taipei's data
# does not change here, only where the parser that reads it lives.
FIXTURE = Path(__file__).parent / "fixtures" / "avail_sample.json"


def _fixture_payload() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _observed_at(payload: dict) -> int:
    """A realistic fetch time for this fixture: the feed publishes ~3 min after stamping.

    Derived from the fixture rather than hardcoded, so recapturing the fixture never
    invalidates the tests -- and so nobody is ever tempted to edit captured data.
    """
    return parse_updatetime(payload["data"]["UPDATETIME"]) + 200


def test_parse_on_real_payload_returns_a_source_tick_with_no_separate_roster():
    payload = _fixture_payload()
    observed_at = _observed_at(payload)
    tick = taipei.parse(payload, now=observed_at)

    assert isinstance(tick, SourceTick)
    assert tick.lots is None, "Taipei's roster still comes from METADATA_URL, not this feed"

    snap = tick.snapshot
    assert isinstance(snap, FeedSnapshot)
    assert snap.city == "taipei"
    assert snap.observed_at == observed_at
    assert snap.latest_data_ts > 0
    # data_ts must precede observed_at: the feed publishes ~3 min after stamping.
    assert snap.latest_data_ts < snap.observed_at
    assert len(snap.observations) > 1000
    assert len({o.lot_id for o in snap.observations}) == len(snap.observations)
    assert all(o.lot_id.startswith("taipei:") for o in snap.observations)


def test_each_observation_is_namespaced_and_carries_its_timestamp_and_kind():
    payload = {"data": {"UPDATETIME": "Fri Sep 04 09:08:00 CST 2026",
                        "park": [{"id": "TPE0001", "availablecar": 5, "availablemotor": -9}]}}
    tick = taipei.parse(payload, now=1757000000)
    snap = tick.snapshot
    obs = snap.observations[0]
    assert obs.lot_id == "taipei:TPE0001"
    assert obs.data_ts == parse_updatetime("Fri Sep 04 09:08:00 CST 2026")
    # Taipei stamps the feed, not the record -- say so, so a model can exclude it later.
    assert obs.ts_kind == "feed"
    assert snap.latest_data_ts == obs.data_ts
    assert snap.city == "taipei"


def test_sentinel_minus_nine_becomes_none_not_zero():
    payload = {
        "data": {
            "UPDATETIME": "Fri Sep 04 09:08:00 CST 2026",
            "park": [{"id": "TPE0001", "availablecar": 16, "availablemotor": -9}],
        }
    }
    tick = taipei.parse(payload, now=1788484280)  # 09:11:20, after the 09:08 stamp
    obs = tick.snapshot.observations[0]
    assert obs.free_car == 16
    assert obs.free_motor is None, "-9 must become None; 0 would mean 'lot is full'"


def test_a_repeated_id_keeps_its_first_occurrence():
    payload = {
        "data": {
            "UPDATETIME": "Fri Sep 04 09:08:00 CST 2026",
            "park": [
                {"id": "TPE0001", "availablecar": 5, "availablemotor": -9},
                {"id": "TPE0001", "availablecar": 999, "availablemotor": 999},
            ],
        }
    }
    tick = taipei.parse(payload, now=1757000000)
    assert len(tick.snapshot.observations) == 1
    assert tick.snapshot.observations[0].free_car == 5


def test_data_ts_minutes_land_on_the_expected_phase():
    payload = _fixture_payload()
    tick = taipei.parse(payload, now=_observed_at(payload))
    assert (tick.snapshot.latest_data_ts // 60) % 5 == 3, "feed stamps minutes congruent to 3 (mod 5)"
