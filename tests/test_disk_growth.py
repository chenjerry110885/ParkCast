"""The arithmetic behind "does the corpus fit on the disk".

The filesystem walk is a one-liner over `Path.glob`; what is worth testing is
the summary, because it is the part someone reads a number off and acts on.
"""
import importlib.util
import pathlib
import sys
from datetime import date

_PATH = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "disk-growth.py"
_spec = importlib.util.spec_from_file_location("disk_growth", _PATH)
disk_growth = importlib.util.module_from_spec(_spec)
sys.modules["disk_growth"] = disk_growth
_spec.loader.exec_module(disk_growth)


def test_a_month_is_projected_from_the_mean_day():
    report = disk_growth.summarise(
        {date(2026, 9, 18): 1_000_000, date(2026, 9, 19): 3_000_000}, hot_bytes=0)

    assert report.days == 2
    assert report.total_bytes == 4_000_000
    assert report.mean_bytes_per_day == 2_000_000
    assert report.projected_bytes_per_month == 2_000_000 * 30


def test_the_newest_day_is_reported_separately_from_the_mean():
    """Cities were switched on over two weeks, so the mean is an average over a
    corpus that was smaller for most of its life. The number that answers "will
    this fit" is the newest full day, not the mean."""
    report = disk_growth.summarise(
        {date(2026, 9, 16): 200_000, date(2026, 9, 20): 1_800_000}, hot_bytes=0)

    assert report.newest_day_bytes == 1_800_000
    assert report.mean_bytes_per_day == 1_000_000


def test_the_newest_day_is_the_latest_date_not_the_largest_file():
    """A day the collector was asleep through is small and still the newest."""
    report = disk_growth.summarise(
        {date(2026, 9, 19): 5_000_000, date(2026, 9, 20): 400_000}, hot_bytes=0)

    assert report.newest_day_bytes == 400_000


def test_an_empty_cold_store_projects_nothing_rather_than_zero():
    """0 MB/month is a claim -- that collecting costs nothing. None is the
    absence of one, which is all an empty store supports."""
    report = disk_growth.summarise({}, hot_bytes=0)

    assert report.days == 0
    assert report.mean_bytes_per_day is None
    assert report.projected_bytes_per_month is None
    assert report.newest_day_bytes is None


def test_the_hot_store_is_carried_through_and_never_projected():
    """The hot store is a bounded 48-hour window: it does not grow with the
    corpus, so folding it into a monthly rate would invent growth."""
    report = disk_growth.summarise({date(2026, 9, 20): 1_000_000}, hot_bytes=700_000_000)

    assert report.hot_bytes == 700_000_000
    assert report.total_bytes == 1_000_000, "the cold total must exclude it"
    assert report.projected_bytes_per_month == 30_000_000


def test_the_scan_reads_one_entry_per_compacted_day(tmp_path):
    (tmp_path / "2026-09-19.parquet").write_bytes(b"x" * 10)
    (tmp_path / "2026-09-20.parquet").write_bytes(b"x" * 25)

    entries, undated = disk_growth.scan(tmp_path)
    assert disk_growth.day_totals(entries) == {
        date(2026, 9, 19): 10, date(2026, 9, 20): 25,
    }
    assert undated == 0


def test_the_scan_descends_into_the_metadata_directory(tmp_path):
    """The bug this script shipped with, and the reason the walk is recursive.

    `cold/meta/<day>.json` is where `__main__.build_capacities` snapshots the
    raw metadata payload, and `docs/state-of-play.md` measured it at 2.17 MB a
    day -- around 90% of the cold store. Globbing `*.parquet` at the top level
    only, which is what `forecast._read_cold` does, reported 4.7 MB against a
    real figure several times larger and concluded the corpus fitted
    comfortably. Undercounting is the dangerous direction here.
    """
    (tmp_path / "2026-09-20.parquet").write_bytes(b"x" * 25)
    (tmp_path / "meta").mkdir()
    (tmp_path / "meta" / "2026-09-20.json").write_bytes(b"x" * 900)

    entries, _ = disk_growth.scan(tmp_path)
    assert disk_growth.day_totals(entries) == {date(2026, 9, 20): 925}
    assert disk_growth.component_totals(entries) == {
        "observations": 25, "meta": 900,
    }


def test_a_file_that_is_not_a_dated_day_is_reported_rather_than_dropped(tmp_path):
    """It cannot be attributed to a day, but its bytes are still on the disk --
    and a measurement that silently omits what it does not recognise is exactly
    how the first version of this script got the answer wrong."""
    (tmp_path / "2026-09-20.parquet").write_bytes(b"x" * 25)
    (tmp_path / "scratch.parquet").write_bytes(b"x" * 9_000)

    entries, undated = disk_growth.scan(tmp_path)
    assert disk_growth.day_totals(entries) == {date(2026, 9, 20): 25}
    assert undated == 9_000


def test_components_are_summed_across_days(tmp_path):
    for day in ("2026-09-19", "2026-09-20"):
        (tmp_path / f"{day}.parquet").write_bytes(b"x" * 100)
    (tmp_path / "meta").mkdir()
    for day in ("2026-09-19", "2026-09-20"):
        (tmp_path / "meta" / f"{day}.json").write_bytes(b"x" * 2_000)

    entries, _ = disk_growth.scan(tmp_path)
    assert disk_growth.component_totals(entries) == {
        "observations": 200, "meta": 4_000,
    }
