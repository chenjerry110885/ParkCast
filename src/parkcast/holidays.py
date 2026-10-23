"""Which Taipei dates are public holidays, from the government's own calendar.

The data is `holidays_tw.json`, built by `scripts/build-calendar.py` from
行政院人事行政總處's 中華民國政府行政機關辦公日曆表 and committed byte-for-byte
beside the app's copy. See that script for what counts as a holiday and why an
ordinary weekend does not.

**Outside the calendar's coverage nothing is claimed.** `is_holiday` answers
False for a date the calendar does not cover -- not because the date is known to
be a working day, but because every caller's fallback for "unknown" is exactly
what it did before this module existed, and that is the behaviour to keep when
the file runs out. `covers` is there for the callers that need to tell the two
apart.
"""
import json
from datetime import date, datetime
from functools import cache
from importlib import resources

from parkcast import config


@cache
def _calendar() -> tuple[date, date, dict[date, tuple[str, str]]]:
    doc = json.loads(resources.files("parkcast").joinpath("holidays_tw.json").read_text("utf-8"))
    first, last = (date.fromisoformat(d) for d in doc["covers"])
    named = {date.fromisoformat(d): (zh, en) for d, (zh, en) in doc["holidays"].items()}
    return first, last, named


def covers(day: date) -> bool:
    first, last, _ = _calendar()
    return first <= day <= last


def is_holiday(day: date) -> bool:
    return day in _calendar()[2]


def holiday_name(day: date) -> tuple[str, str] | None:
    """`(zh, en)` for a holiday, `None` for any other day, covered or not."""
    return _calendar()[2].get(day)


def all_holidays() -> list[date]:
    return sorted(_calendar()[2])


def taipei_date(ts: int) -> date:
    """The Taipei calendar date of an epoch-seconds timestamp -- never UTC's,
    which would file the first eight hours of every holiday under the day
    before it."""
    return datetime.fromtimestamp(ts, config.TAIPEI_TZ).date()
