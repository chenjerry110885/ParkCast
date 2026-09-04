# tests/test_compact.py
from datetime import date

import pyarrow.parquet as pq
import pytest

from parkcast import store
from parkcast.compact import compact_day, day_bounds
from parkcast.feed import FeedSnapshot, Observation


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


def test_empty_day_produces_no_file(conn, tmp_path):
    assert compact_day(conn, date(2026, 9, 4), tmp_path) is None
