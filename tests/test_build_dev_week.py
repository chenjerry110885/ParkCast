"""The dev week-table builder files every observation in the bucket it means.

`config.WEEK_BUCKETS` grew to 384 when the holiday day was added; the clock
week is still `config.CLOCK_BUCKETS` (336). A builder that walked or reduced
by the first would shift every bucket after the first week by a day, and its
own assertion is what would have to catch it.
"""
import importlib.util
import pathlib
import sys

from parkcast import config
from parkcast.forecast import week_bucket

_PATH = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "build-dev-week.py"
_spec = importlib.util.spec_from_file_location("build_dev_week", _PATH)
build_dev_week = importlib.util.module_from_spec(_spec)
sys.modules["build_dev_week"] = build_dev_week
_spec.loader.exec_module(build_dev_week)

ANCHOR = 1_792_700_000


def test_every_clock_bucket_has_a_start_in_that_bucket():
    for bucket in range(config.CLOCK_BUCKETS):
        assert week_bucket(build_dev_week.bucket_start(ANCHOR, bucket)) == bucket


def test_a_week_is_seven_days():
    assert build_dev_week.WEEK_SEC == 7 * 86400


def test_the_history_builds_for_a_lot():
    history = build_dev_week.build_history([{"id": "taipei:A", "f": 3}], ANCHOR, 1)
    assert history.counts.lot["taipei:A"][1] > 0
