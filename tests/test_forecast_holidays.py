"""Holidays as their own day of the week, in the climatology.

`week_bucket` files every observation by its clock alone, so a public holiday
on a Friday lands in the Friday buckets. The corpus holds two such Fridays
(2026-09-25 中秋節, 2026-10-09 補假) among roughly seven -- holidays filed as
working days in about 30% of every Friday half-hour. `day_bucket` gives them
an eighth day instead: buckets 336..383, one per half-hour.

A holiday cell has far fewer observations than a weekday one -- about 22
holidays a year against 52 of each weekday -- so it does not shrink toward the
lot rate like the others. It shrinks toward the same half-hour of the day a
holiday most resembles (`config.HOLIDAY_PRIOR_SLOT`), so a lot with no holiday
history yet reads that day's shape rather than its flat average, and moves off
it as holidays accumulate.
"""
from datetime import datetime

from parkcast import artifacts, config, week
from parkcast.forecast import Climatology, Counts, History, day_bucket, week_bucket


def taipei(y, m, d, h=14, mi=10) -> int:
    return int(datetime(y, m, d, h, mi, tzinfo=config.TAIPEI_TZ).timestamp())


HOLIDAY_FRI = taipei(2026, 9, 25)        # 中秋節
ORDINARY_THU = taipei(2026, 9, 24)
HALF_HOUR = 28                           # 14:00-14:30
#: The four holidays the corpus actually holds, at 14:10.
CORPUS_HOLIDAYS = [taipei(2026, 9, 25), taipei(2026, 9, 28), taipei(2026, 10, 9), taipei(2026, 10, 10)]


def _history(counts: Counts) -> History:
    return History(latest_ts=0, current={}, recent={}, counts=counts)


def test_the_geometry_is_eight_days_of_forty_eight_half_hours():
    assert config.BUCKETS_PER_DAY == 48
    assert config.CLOCK_BUCKETS == 336
    assert config.HOLIDAY_SLOT == 7
    assert config.WEEK_BUCKETS == 384


def test_a_holiday_goes_to_the_holiday_slot_at_its_own_half_hour():
    assert day_bucket(HOLIDAY_FRI) == 336 + HALF_HOUR


def test_an_ordinary_day_keeps_its_clock_bucket():
    assert day_bucket(ORDINARY_THU) == week_bucket(ORDINARY_THU) == HALF_HOUR  # Thursday = slot 0


def test_past_the_calendar_a_holiday_date_is_just_its_weekday():
    """2028-10-10 is National Day, but the committed calendar ends in 2027.
    Nothing is claimed past it: the day files exactly as it always did."""
    ts = taipei(2028, 10, 10)
    assert day_bucket(ts) == week_bucket(ts)


def test_a_holiday_observation_leaves_its_weekday_bucket_alone():
    """The whole point. Mid-Autumn must not teach the Friday buckets anything."""
    counts = Counts()
    counts.add("A", HOLIDAY_FRI, 0)

    assert counts.bucket[("A", 336 + HALF_HOUR)] == [0, 1]
    assert ("A", week_bucket(HOLIDAY_FRI)) not in counts.bucket


def _sundays_mostly_free(counts: Counts, n: int = 6) -> None:
    """`n` Sundays at 14:10, free on all but one -- a shape distinct from the
    lot's overall rate, so a holiday cell that fell back to the lot rate would
    not be mistaken for one that fell back to Sunday."""
    for k in range(n):
        counts.add("A", taipei(2026, 9, 6) + k * 7 * 86400, 0 if k == 0 else 5)
    # Full weekday afternoons, dragging the lot rate down. Twenty weeks back from
    # 09-24 reaches 05-14 and no further: forty would reach 2026-02-19 and
    # 2026-01-01, both holiday THURSDAYS, which would land in the holiday slot
    # and give a "no holiday history" fixture some holiday history.
    for k in range(20):
        counts.add("A", ORDINARY_THU - k * 86400 * 7, 0)


def test_with_no_holiday_history_a_holiday_reads_the_prior_day():
    counts = Counts()
    _sundays_mostly_free(counts)
    clim = Climatology(_history(counts))
    prior = config.HOLIDAY_PRIOR_SLOT * 48 + HALF_HOUR

    assert clim.predict_bucket("A", 336 + HALF_HOUR) == clim.predict_bucket("A", prior)


def test_holiday_history_moves_the_cell_off_the_prior_day():
    counts = Counts()
    _sundays_mostly_free(counts)
    for ts in CORPUS_HOLIDAYS:  # the corpus's four holidays at 14:10, all full
        counts.add("A", ts, 0)
    clim = Climatology(_history(counts))
    prior = clim.predict_bucket("A", config.HOLIDAY_PRIOR_SLOT * 48 + HALF_HOUR)

    assert clim.predict_bucket("A", 336 + HALF_HOUR) < prior


def test_predict_reads_the_holiday_slot_on_a_holiday():
    counts = Counts()
    _sundays_mostly_free(counts)
    counts.add("A", HOLIDAY_FRI, 0)
    clim = Climatology(_history(counts))

    assert clim.predict("A", HOLIDAY_FRI, 0) == clim.predict_bucket("A", 336 + HALF_HOUR)


def test_the_week_table_carries_eight_days_and_the_holiday_support():
    counts = Counts()
    _sundays_mostly_free(counts)
    counts.add("A", HOLIDAY_FRI, 0)
    counts.add("A", HOLIDAY_FRI + 300, 0)
    cells = week.build_week_cells(_history(counts), ["A"])["A"]

    assert len(cells) == 384
    assert cells[336 + HALF_HOUR][1] == 2
    assert cells[week_bucket(HOLIDAY_FRI)][1] == 0


def test_the_encoder_writes_version_two_with_384_buckets():
    blob = artifacts.encode_week(["A"], {"A": [(0.5, 1)] * 384}, built_ts=1)
    header = artifacts.decode_week_header(blob[:artifacts.WEEK_HEADER_SIZE])

    assert artifacts.WEEK_VERSION == 2
    assert (header["version"], header["n_buckets"]) == (2, 384)
    assert len(blob) == artifacts.WEEK_HEADER_SIZE + 384 * 2
