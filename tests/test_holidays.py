"""The official calendar, and the one rule that turns it into "is this a holiday".

The calendar is 行政院人事行政總處's 中華民國政府行政機關辦公日曆表 (data.gov.tw
dataset 14718). It marks every day `是否放假` 0 (workday) or 2 (day off), with
the holiday's name in `備註`. Weekends are days off too, so "day off" is not
"holiday": an ordinary Saturday must stay a Saturday, or every weekend in the
corpus moves out of its own buckets.
"""
import importlib.util
import pathlib
import sys
import tomllib
from datetime import date

import pytest

from parkcast import holidays

_ROOT = pathlib.Path(__file__).resolve().parent.parent
_PATH = _ROOT / "scripts" / "build-calendar.py"
_spec = importlib.util.spec_from_file_location("build_calendar", _PATH)
build_calendar = importlib.util.module_from_spec(_spec)
sys.modules["build_calendar"] = build_calendar
_spec.loader.exec_module(build_calendar)

HEADER = "﻿西元日期,星期,是否放假,備註\r\n"


def _csv(*rows: str) -> str:
    return HEADER + "".join(row + "\r\n" for row in rows)


# --- the builder ------------------------------------------------------------


def test_a_weekday_off_and_a_named_weekend_are_holidays_and_a_plain_weekend_is_not():
    doc = build_calendar.build([_csv(
        "20260925,五,2,中秋節",      # Friday off: a holiday
        "20261003,六,2,",            # ordinary Saturday: NOT a holiday
        "20261008,四,0,",            # ordinary Thursday
        "20261010,六,2,國慶日",      # Saturday, but named: a holiday
    )], sources=["https://example.test/115.csv"])

    assert doc["holidays"] == {
        "2026-09-25": ["中秋節", "Mid-Autumn Festival"],
        "2026-10-10": ["國慶日", "National Day"],
    }
    assert doc["covers"] == ["2026-09-25", "2026-10-10"]
    assert doc["source"] == ["https://example.test/115.csv"]


def test_a_make_up_workday_stops_the_build():
    """Neither 2026 nor 2027 has one, so none is modelled -- and a future
    calendar that brings one back must force a decision, not be filed as an
    ordinary Saturday that happens to be a workday."""
    with pytest.raises(ValueError, match="make-up workday"):
        build_calendar.build([_csv("20270206,六,0,補行上班")], sources=["x"])


def test_a_holiday_with_no_english_name_stops_the_build():
    """The English UI names the holiday, so an untranslated one is a gap in the
    product, not a cosmetic one. Fail at build time, where someone is looking."""
    with pytest.raises(ValueError, match="no English name"):
        build_calendar.build([_csv("20280101,六,2,新的節日")], sources=["x"])


# --- the committed calendar -------------------------------------------------


@pytest.mark.parametrize("day", [date(2026, 9, 25), date(2026, 9, 28),
                                 date(2026, 10, 9), date(2026, 10, 10)])
def test_the_four_holidays_inside_the_corpus_are_holidays(day):
    assert holidays.is_holiday(day)


@pytest.mark.parametrize("day", [date(2026, 10, 3), date(2026, 10, 8)])
def test_an_ordinary_saturday_and_an_ordinary_thursday_are_not(day):
    assert not holidays.is_holiday(day)


def test_the_counts_match_the_official_calendar():
    days = holidays.all_holidays()

    assert sum(1 for d in days if d.year == 2026) == 22
    assert sum(1 for d in days if d.year == 2027) == 24


def test_a_date_past_the_calendar_is_not_covered_and_claims_nothing():
    """Beyond coverage the app behaves exactly as it did before the calendar
    existed: an unknown day is never asserted to be a working one, nor a
    holiday."""
    assert not holidays.covers(date(2028, 1, 1))
    assert not holidays.is_holiday(date(2028, 1, 1))
    assert holidays.holiday_name(date(2028, 1, 1)) is None


def test_a_holiday_is_named_in_both_languages():
    assert holidays.holiday_name(date(2026, 10, 10)) == ("國慶日", "National Day")
    assert holidays.holiday_name(date(2026, 10, 8)) is None


def test_the_date_is_taipei_s_not_utc():
    """00:10 on Double Tenth in Taipei is still the 9th in UTC. Classifying by
    the UTC date would file the first eight hours of every holiday under the
    day before it."""
    assert holidays.taipei_date(1791562200) == date(2026, 10, 10)


def test_python_and_the_web_read_the_same_bytes():
    """One calendar, two readers. A copy edited on one side only would make the
    collector and the app disagree about which day it is."""
    py = (_ROOT / "src" / "parkcast" / "holidays_tw.json").read_bytes()
    web = (_ROOT / "web" / "src" / "holidaysTw.json").read_bytes()

    assert py == web


def test_the_calendar_ships_inside_the_installed_package():
    """The image installs with `pip install .`, so a data file beside the module
    is NOT in site-packages unless package-data says so -- and every test here
    runs from `src/`, where it is always present. This is the only test that can
    see the difference; without it the collector would import cleanly in CI and
    crash on its first holiday lookup in production."""
    config = tomllib.loads((_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    patterns = config["tool"]["setuptools"]["package-data"].get("parkcast", [])

    assert any(pathlib.PurePath("holidays_tw.json").match(p) for p in patterns)
