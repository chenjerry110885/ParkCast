from datetime import datetime

import pytest

from parkcast.feed import FeedSnapshot, parse_updatetime


def test_parse_updatetime_treats_cst_as_taipei_not_us_central():
    ts = parse_updatetime("Fri Sep 04 09:08:00 CST 2026")
    # 09:08 UTC+8 == 01:08 UTC. If CST were misread as US Central (UTC-6 or -5),
    # this would be off by 13-14 hours.
    assert datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d %H:%M") == "2026-09-04 01:08"


def test_parse_updatetime_rejects_garbage():
    with pytest.raises(ValueError):
        parse_updatetime("not a timestamp")


def test_latest_data_ts_is_zero_for_an_empty_feed():
    assert FeedSnapshot(city="taipei", observed_at=1, observations=()).latest_data_ts == 0
