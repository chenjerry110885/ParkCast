# tests/test_compact.py
from datetime import date

import pyarrow.parquet as pq
import pytest

from parkcast import store
from parkcast.compact import compact_day, day_bounds
from parkcast.feed import FeedSnapshot, Observation
from parkcast.quality import Q


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def test_day_bounds_span_exactly_24_hours_in_taipei():
    start, end = day_bounds(date(2026, 9, 4))
    assert end - start == 86400
    assert start % 86400 == 16 * 3600, "a Taipei day starts at 16:00 UTC the day before"


def test_compaction_produces_288_slots_per_lot(conn, tmp_path):
    start, _ = day_bounds(date(2026, 9, 4))
    for i in (0, 1, 5):
        ts = start + i * 300
        store.insert_snapshot(
            conn, FeedSnapshot(ts, ts + 200, (Observation("A", 10 + i, None),)), {"A": 50}
        )

    path = compact_day(conn, date(2026, 9, 4), tmp_path)
    table = pq.read_table(path)
    row = table.to_pylist()[0]

    assert len(row["free_car"]) == 288
    assert row["free_car"][0] == 10
    assert row["free_car"][1] == 11
    assert row["free_car"][5] == 15


def test_gaps_are_null_never_interpolated(conn, tmp_path):
    start, _ = day_bounds(date(2026, 9, 4))
    for i in (0, 5):
        ts = start + i * 300
        store.insert_snapshot(
            conn, FeedSnapshot(ts, ts + 200, (Observation("A", 10 + i, None),)), {"A": 50}
        )

    row = pq.read_table(compact_day(conn, date(2026, 9, 4), tmp_path)).to_pylist()[0]
    assert row["free_car"][1] is None, "slot 1 was never observed and must stay null"
    assert row["free_car"][2] is None
    assert row["free_car"][15] is None


def test_quality_flags_are_index_aligned_with_free_car(conn, tmp_path):
    """Each slot's persisted Q flag must land at the same index as its
    free_car value. A regression that wrote quality against a shifted index,
    or dropped it entirely, would pass every other test in this file
    undetected -- quality is what tells a future model which readings are
    real (MISSING = feed sentinel, CLAMPED = overcount)."""
    start, _ = day_bounds(date(2026, 9, 4))
    capacities = {"A": 50}
    # slot -> (free_car reported by the feed, expected persisted quality flag)
    cases = {
        0: (10, Q.OK),          # clean reading, within capacity
        1: (None, Q.MISSING),   # feed reported no usable count
        2: (100, Q.CLAMPED),    # overcount, clamped down to capacity
    }
    for slot, (free_car, _expected_q) in cases.items():
        ts = start + slot * 300
        store.insert_snapshot(
            conn, FeedSnapshot(ts, ts + 200, (Observation("A", free_car, None),)), capacities
        )

    row = pq.read_table(compact_day(conn, date(2026, 9, 4), tmp_path)).to_pylist()[0]

    assert len(row["quality"]) == 288
    for slot, (_free_car, expected_q) in cases.items():
        assert row["quality"][slot] == expected_q.value, (
            f"slot {slot} quality flag is misaligned with its free_car value"
        )

    # Slots nothing was ever inserted for must stay null in both arrays,
    # exactly like free_car.
    for slot in (3, 15):
        assert row["free_car"][slot] is None
        assert row["quality"][slot] is None

    # The alignment property itself: the only slots carrying a real quality
    # flag are the ones a row was actually written for. This is deliberately
    # checked against the slots we inserted (known by construction) rather
    # than against free_car's own non-null set: a MISSING reading is still an
    # observed row -- quality[1] == Q.MISSING -- even though free_car[1] is
    # null, since the feed reported no usable count for that slot. Comparing
    # quality's non-null set to free_car's non-null set would therefore be
    # wrong whenever a MISSING slot is present, even for correct code.
    quality_observed = {i for i, v in enumerate(row["quality"]) if v is not None}
    assert quality_observed == set(cases)


def test_empty_day_produces_no_file(conn, tmp_path):
    assert compact_day(conn, date(2026, 9, 4), tmp_path) is None
