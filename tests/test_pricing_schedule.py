"""Parsing a fare into a schedule, and resolving a moment against it.

Every string below is real, from `tests/fixtures/desc_sample.json`, rather than
invented to pass. Two orders occur in the corpus -- rate then window, and window
then rate -- and a parser that handles one silently collapses the other into a
range, which is exactly the failure this module exists to end.
"""
from datetime import datetime

import pytest

from parkcast import config, pricing

# From the fixture, trimmed to the clauses that matter. The scope marker on the
# first clause applies to the second, which carries none of its own: that is the
# property `test_scope_carries_to_the_clauses_after_it` exists for.
WEEKDAY_AND_WEEKEND = (
    "小型車：計時 週一至週五50元/時(08-20)，10元/時(20-08)，"
    "週六、週日、行政機關放假之紀念日與民俗日60元/時(10-20)，10元/時(20-10)，"
    "停車全程以半小時計；月租 全日4,800元，日間3,600元(07-19)，夜間1,000元(19-08)。"
)
BARE_WINDOWED = (
    "計時:40元(08-22)、20元(22-08)，停放於充電格位之車輛，加收10元/時，"
    "依設備自動判斷未充電者再加收10元/時（未充電者合計加收20元/時），全程半小時計。"
    "月租：全日6,000元，夜間3,000元/月(22-08)。"
)
WINDOW_FIRST = (
    "小型車：計時 週一~週五(10時~22時)50元/時，(22時~10時)10元/時，"
    "週六、週日、行政機關放假之紀念日與民俗日(10時~24時)60元/時，(24時~10時)10元/時，"
    "全程以半小時計;月租 全日4,800元，日間4,000元(10時~22時)。"
)


# --- parsing ----------------------------------------------------------------


def test_a_bare_windowed_pair_becomes_two_segments():
    """The one shape the old parser already recognised."""
    tariff = pricing.parse_tariff(BARE_WINDOWED)

    assert tariff.segments == (
        pricing.Segment("all", 8, 22, 40),
        pricing.Segment("all", 22, 8, 20),
    )


def test_a_window_before_the_rate_parses_too():
    segments = pricing.parse_tariff(WINDOW_FIRST).segments

    assert pricing.Segment("weekday", 10, 22, 50) in segments
    assert pricing.Segment("weekday", 22, 10, 10) in segments


def test_scope_carries_to_the_clauses_after_it():
    """The parsing insight. `10元/時(20-08)` carries no marker and is still a
    weekday rate, because the clause before it said 週一至週五. A parser that
    scoped only the marked clause would file half the corpus under `all` and
    resolve the wrong rate at every hour."""
    segments = pricing.parse_tariff(WEEKDAY_AND_WEEKEND).segments

    assert pricing.Segment("weekday", 8, 20, 50) in segments
    assert pricing.Segment("weekday", 20, 8, 10) in segments
    assert pricing.Segment("weekend", 10, 20, 60) in segments
    assert pricing.Segment("weekend", 20, 10, 10) in segments


def test_the_monthly_rental_section_contributes_nothing():
    """`月租 日間3,600元(07-19)` is a window and a figure and not a tariff.
    `_TIMING` already cuts it; this proves the new parser inherits that cut
    rather than reaching past it."""
    segments = pricing.parse_tariff(WEEKDAY_AND_WEEKEND).segments

    assert all(s.rate in (10, 50, 60) for s in segments), segments


def test_a_24_hour_boundary_normalises_to_midnight():
    """`(10時~24時)` and `(24時~10時)` are both real. Hour 24 is hour 0, and a
    segment from 24 to 10 wraps like any other."""
    segments = pricing.parse_tariff(WINDOW_FIRST).segments

    assert pricing.Segment("weekend", 10, 0, 60) in segments
    assert pricing.Segment("weekend", 0, 10, 10) in segments


def test_a_surcharge_is_not_a_segment():
    """`加收10元/時` is an extra levied on top of the rate, most often for
    occupying a charging bay. `_drop_surcharges` already removes it."""
    segments = pricing.parse_tariff(BARE_WINDOWED).segments

    assert all(s.rate in (20, 40) for s in segments), segments


def test_a_single_rate_needs_no_tariff():
    """73.4% of the roster. A schedule saying one thing would be noise in every
    artifact."""
    assert pricing.parse_tariff("小型車：計時 30元/時，停車全程以半小時計。") is None


def test_an_unreadable_fare_has_no_tariff():
    assert pricing.parse_tariff("詳見現場公告") is None
    assert pricing.parse_tariff("") is None
    assert pricing.parse_tariff(None) is None


def test_two_overlapping_segments_of_the_same_scope_are_a_parse_failure():
    """Not a tie to break. Guessing which the sign means is what this feature
    exists to stop, so the lot keeps its range and the client falls back."""
    assert pricing.parse_tariff("計時 50元/時(08-20)，30元/時(10-18)。") is None


def test_an_implausible_rate_is_not_a_segment():
    """The same bounds `_span` applies: a monthly figure that escaped the cut
    must not become an hourly rate."""
    assert pricing.parse_tariff("計時 4800元/時(08-20)，10元/時(20-08)。") is None


# --- resolving --------------------------------------------------------------


TARIFF = pricing.Tariff((
    pricing.Segment("weekday", 8, 20, 50),
    pricing.Segment("weekday", 20, 8, 10),
    pricing.Segment("weekend", 10, 20, 60),
))
TUESDAY_1400 = datetime(2026, 10, 6, 14, 0, tzinfo=config.TAIPEI_TZ)
TUESDAY_2300 = datetime(2026, 10, 6, 23, 0, tzinfo=config.TAIPEI_TZ)
TUESDAY_0300 = datetime(2026, 10, 6, 3, 0, tzinfo=config.TAIPEI_TZ)
SATURDAY_1400 = datetime(2026, 10, 3, 14, 0, tzinfo=config.TAIPEI_TZ)
SATURDAY_0900 = datetime(2026, 10, 3, 9, 0, tzinfo=config.TAIPEI_TZ)


def test_a_weekday_afternoon_takes_the_weekday_rate():
    assert pricing.rate_at(TARIFF, TUESDAY_1400) == 50


def test_a_segment_that_wraps_midnight_covers_both_sides_of_it():
    """`20-08` is one segment. A rule assuming `start < end` would drop every
    overnight rate in the corpus."""
    assert pricing.rate_at(TARIFF, TUESDAY_2300) == 10
    assert pricing.rate_at(TARIFF, TUESDAY_0300) == 10


def test_a_saturday_takes_the_weekend_rate_not_the_weekday_one():
    assert pricing.rate_at(TARIFF, SATURDAY_1400) == 60


def test_a_moment_no_segment_covers_has_no_rate():
    """Saturday 09:00 falls outside the only weekend segment. None -- never the
    weekday rate, never a midpoint. An absence is not a number."""
    assert pricing.rate_at(TARIFF, SATURDAY_0900) is None


def test_a_more_specific_scope_wins_over_all():
    tariff = pricing.Tariff((pricing.Segment("all", 0, 0, 30),
                             pricing.Segment("weekend", 10, 20, 60)))

    assert pricing.rate_at(tariff, SATURDAY_1400) == 60
    assert pricing.rate_at(tariff, TUESDAY_1400) == 30


def test_a_holiday_only_segment_is_never_resolved():
    """No calendar, no claim. Any day might be a public holiday, so a moment
    whose only applicable segment is holiday-scoped reports nothing."""
    tariff = pricing.Tariff((pricing.Segment("holiday", 10, 20, 80),))

    assert pricing.rate_at(tariff, SATURDAY_1400) is None
    assert pricing.rate_at(tariff, TUESDAY_1400) is None


def test_a_lot_that_also_prices_holidays_still_resolves_an_ordinary_tuesday():
    """87 of the 219 price holidays as their own category. Refusing all of them
    would cost 40% of the feature to protect about ten days a year; what is
    refused is only the moment whose SOLE applicable segment is holiday-scoped.
    """
    tariff = pricing.Tariff((pricing.Segment("weekday", 8, 20, 50),
                             pricing.Segment("holiday", 8, 20, 80)))

    assert pricing.rate_at(tariff, TUESDAY_1400) == 50


def test_whether_a_tariff_prices_holidays_is_reportable():
    """The display needs it: a driver on Double Tenth Day should be told the
    rate shown is the ordinary one, not trust it."""
    assert pricing.prices_holidays(
        pricing.Tariff((pricing.Segment("holiday", 8, 20, 80),))) is True
    assert pricing.prices_holidays(TARIFF) is False


def test_a_holiday_folded_into_the_weekend_scope_is_still_reported():
    """**The bug this flag exists for.** The corpus writes holidays inside the
    weekend clause -- `週六、週日、行政機關放假之紀念日與民俗日60元/時` -- and
    `_scope_of` deliberately folds that marker into `weekend`, because the rate
    genuinely applies to Saturdays and a date can settle those.

    That fold erased the only evidence the display had. Reading holidays off the
    SEGMENTS reported 1 lot of the fixture's 119 tariffs; reading the prose
    reports 36. The other 35 resolved a rate and said nothing, so a midweek
    public holiday rendered the WEEKDAY rate -- 50 where the sign says 60 --
    confidently and with no warning. A range would merely have been vague.
    """
    payex = ("計時：小型車週一至週五50元/時(10-22)，10元/時(22-10)，"
             "週六、週日、行政機關放假之紀念日與民俗日60元/時(10-22)，10元/時(22-10)。")
    tariff = pricing.parse_tariff(payex)

    assert tariff is not None
    # The fold still happened -- this test does not undo it, it survives it.
    assert not any(s.scope == "holiday" for s in tariff.segments)
    assert tariff.holidays is True
    assert pricing.prices_holidays(tariff) is True


def test_an_ordinary_weekend_rate_is_not_a_holiday_claim():
    """`假日` and `例假日` are how this corpus writes "weekend", and a lot that
    only ever says that is making no claim about national holidays. Flagging it
    would put a warning on lots that have nothing to warn about, which is how a
    warning stops being read at all."""
    tariff = pricing.parse_tariff(
        "計時：小型車平日50元/時(10-22)，10元/時(22-10)，假日60元/時(10-22)，10元/時(22-10)。")

    assert tariff is not None
    assert tariff.holidays is False
    assert pricing.prices_holidays(tariff) is False


def test_a_naive_datetime_is_refused_rather_than_guessed():
    """Which hour applies depends entirely on the zone. Assuming Taipei for a
    naive datetime would be right here and silently wrong for any caller that
    passed UTC."""
    with pytest.raises(ValueError):
        pricing.rate_at(TARIFF, datetime(2026, 10, 6, 14, 0))


# --- the seam with the existing parser --------------------------------------


def test_a_parsed_tariff_never_leaves_the_span_the_old_parser_read():
    """The error class that matters. A tariff resolving confidently to a rate
    outside `lo`-`hi` is a parser bug, not a win -- and it would ship as a
    number no sign displays, which is worse than the range it replaced."""
    for text in (WEEKDAY_AND_WEEKEND, BARE_WINDOWED, WINDOW_FIRST):
        price = pricing.parse_fare(text)
        tariff = pricing.parse_tariff(text)
        assert tariff is not None, text[:40]
        for segment in tariff.segments:
            assert price.low <= segment.rate <= price.high, (text[:40], segment)
