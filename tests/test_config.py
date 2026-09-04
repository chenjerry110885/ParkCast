# tests/test_config.py
import json
from pathlib import Path
from parkcast import config


def test_fixtures_are_present_and_parseable():
    for name in ("avail_sample.json", "desc_sample.json"):
        path = Path(__file__).parent / "fixtures" / name
        assert path.exists(), f"missing fixture {name} — re-run the curl in Task 1"
        assert "data" in json.loads(path.read_text(encoding="utf-8"))


def test_taipei_tz_is_utc_plus_8_with_no_dst():
    assert config.TAIPEI_TZ.utcoffset(None).total_seconds() == 8 * 3600
