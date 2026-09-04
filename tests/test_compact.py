# tests/test_compact.py
from datetime import date

import pyarrow.parquet as pq
import pytest

from parkcast import store
from parkcast.compact import ARRAY_COLUMNS, compact_day, day_bounds
from parkcast.feed import FeedSnapshot, Observation
from parkcast.quality import Q


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def _compact_one(conn, out_dir):
    """Write a single observation for 2026-09-04 and compact that day."""
    start, _ = day_bounds(date(2026, 9, 4))
    store.insert_snapshot(
        conn, FeedSnapshot(start, start + 200, (Observation("A", 10, 3),)), {"A": 50}
    )
    return compact_day(conn, date(2026, 9, 4), out_dir)


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
    # Every array carries the same gaps. A zero-filled lag or quality array
    # would make an unobserved slot look like a perfectly fresh reading.
    for column in ARRAY_COLUMNS:
        for slot in (1, 2, 15):
            assert row[column][slot] is None, f"{column}[{slot}] must stay null"


def test_parquet_carries_all_four_per_slot_arrays(conn, tmp_path):
    """The Parquet file is the permanent record; SQLite keeps only 48 hours.

    A column absent here can never be recovered for any past day, so the
    schema is pinned: dropping free_motor or lag would silently make
    motorcycles (spec section 13) and observation staleness (spec section 7)
    untrainable forever.
    """
    table = pq.read_table(_compact_one(conn, tmp_path))
    assert table.schema.names == ["lot_id", "date", *ARRAY_COLUMNS]
    row = table.to_pylist()[0]
    for column in ARRAY_COLUMNS:
        assert len(row[column]) == 288, f"{column} must be a full 288-slot day"


def test_free_motor_is_preserved_with_its_own_nulls(conn, tmp_path):
    """466 lots report motorcycles; the rest report nothing and must stay null."""
    start, _ = day_bounds(date(2026, 9, 4))
    for slot, motor in ((0, 7), (1, None), (2, 0)):
        ts = start + slot * 300
        store.insert_snapshot(
            conn, FeedSnapshot(ts, ts + 200, (Observation("A", 10, motor),)), {"A": 50}
        )

    row = pq.read_table(compact_day(conn, date(2026, 9, 4), tmp_path)).to_pylist()[0]
    assert row["free_motor"][0] == 7
    assert row["free_motor"][1] is None, "a missing motor count is null, never 0"
    assert row["free_motor"][2] == 0, "0 is a real count: the motorcycle bays are full"


def test_lag_is_observed_at_minus_data_ts(conn, tmp_path):
    """Staleness is a model feature, and observed_at exists nowhere else once pruned."""
    start, _ = day_bounds(date(2026, 9, 4))
    for slot, lag in ((0, 184), (1, 502)):
        ts = start + slot * 300
        store.insert_snapshot(
            conn, FeedSnapshot(ts, ts + lag, (Observation("A", 10, None),)), {"A": 50}
        )

    row = pq.read_table(compact_day(conn, date(2026, 9, 4), tmp_path)).to_pylist()[0]
    assert row["lag"][0] == 184
    assert row["lag"][1] == 502


def test_absurd_lag_is_clamped_rather_than_blocking_the_day(conn, tmp_path):
    """A broken clock must not make a whole day uncompactable.

    int16 tops out at 32767s (~9h). A single row beyond that would raise
    inside pyarrow, and since compaction is retried every slot the day would
    fail forever rather than losing one value.
    """
    start, _ = day_bounds(date(2026, 9, 4))
    store.insert_snapshot(
        conn,
        FeedSnapshot(start, start + 90_000, (Observation("A", 10, None),)),
        {"A": 50},
    )
    row = pq.read_table(compact_day(conn, date(2026, 9, 4), tmp_path)).to_pylist()[0]
    assert row["lag"][0] == 32767


def test_compaction_leaves_no_temporary_file_behind(conn, tmp_path):
    """The write goes via a temp file and a rename; only the final file may remain."""
    out_dir = tmp_path / "cold"
    _compact_one(conn, out_dir)
    assert [p.name for p in out_dir.iterdir()] == ["2026-09-04.parquet"]


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
