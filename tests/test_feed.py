import json
from datetime import datetime
from pathlib import Path

import pytest

from parkcast.feed import FeedSnapshot, parse_availability, parse_updatetime

FIXTURE = Path(__file__).parent / "fixtures" / "avail_sample.json"


def _fixture_payload() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _observed_at(payload: dict) -> int:
    """A realistic fetch time for this fixture: the feed publishes ~3 min after stamping.

    Derived from the fixture rather than hardcoded, so recapturing the fixture never
    invalidates the tests -- and so nobody is ever tempted to edit captured data.
    """
    return parse_updatetime(payload["data"]["UPDATETIME"]) + 200


def test_parse_updatetime_treats_cst_as_taipei_not_us_central():
    ts = parse_updatetime("Fri Sep 04 09:08:00 CST 2026")
    # 09:08 UTC+8 == 01:08 UTC. If CST were misread as US Central (UTC-6 or -5),
    # this would be off by 13-14 hours.
    assert datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d %H:%M") == "2026-09-04 01:08"


def test_parse_updatetime_rejects_garbage():
    with pytest.raises(ValueError):
        parse_updatetime("not a timestamp")


def test_parse_availability_on_real_payload():
    payload = _fixture_payload()
    observed_at = _observed_at(payload)
    snap = parse_availability(payload, observed_at=observed_at)

    assert isinstance(snap, FeedSnapshot)
    assert snap.observed_at == observed_at
    assert snap.data_ts > 0
    # data_ts must precede observed_at: the feed publishes ~3 min after stamping.
    assert snap.data_ts < snap.observed_at
    assert len(snap.observations) > 1000
    assert len({o.lot_id for o in snap.observations}) == len(snap.observations)


def test_sentinel_minus_nine_becomes_none_not_zero():
    payload = {
        "data": {
            "UPDATETIME": "Fri Sep 04 09:08:00 CST 2026",
            "park": [{"id": "TPE0001", "availablecar": 16, "availablemotor": -9}],
        }
    }
    snap = parse_availability(payload, observed_at=1788484280)  # 09:11:20, after the 09:08 stamp
    obs = snap.observations[0]
    assert obs.free_car == 16
    assert obs.free_motor is None, "-9 must become None; 0 would mean 'lot is full'"


def test_data_ts_minutes_land_on_the_expected_phase():
    payload = _fixture_payload()
    snap = parse_availability(payload, observed_at=_observed_at(payload))
    assert (snap.data_ts // 60) % 5 == 3, "feed stamps minutes congruent to 3 (mod 5)"
