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


def test_climatology_buckets_are_a_whole_number_of_compaction_slots():
    """Hot and cold copies of one reading must fall in the same bucket.

    Compaction snaps a reading's data_ts back to the start of its 5-minute slot,
    so the hot and cold copies of the same observation differ by up to one slot.
    They bucket identically only while no bucket boundary can fall between them,
    i.e. while the bucket width is a whole number of slots. Break that and the
    counts start depending on whether a day has been compacted yet -- quietly,
    and only for the readings near a boundary.
    """
    from parkcast.compact import SLOT_SECONDS

    assert config.CLIMATOLOGY_BUCKET_MIN * 60 % SLOT_SECONDS == 0, (
        f"CLIMATOLOGY_BUCKET_MIN={config.CLIMATOLOGY_BUCKET_MIN} min is not a "
        f"multiple of the {SLOT_SECONDS}s compaction slot"
    )
