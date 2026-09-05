"""Guards on the two properties Plan 2b exists to create.

Without these, a future change could quietly reintroduce O(corpus) per-tick
work or unbounded retention, and the suite would stay green until the
collector started missing ticks in production months later.
"""
import sqlite3
import time

import pytest

from parkcast import config, store
from parkcast.forecast import load_history

LIVE_DB = config.DB_PATH


def _snapshot(dest) -> None:
    """Copy the live store via SQLite's own backup API, not a file copy.

    The live database is in WAL mode and a collector may be writing to it
    every 5 minutes. A plain file copy can land mid-write and capture a torn
    snapshot -- this hit `tests/test_artifacts_integration.py` once already.
    `sqlite3.Connection.backup` takes a consistent, transactionally-safe
    snapshot instead. The source is opened read-only so this never touches
    the live database read-write.
    """
    src = sqlite3.connect(f"file:{LIVE_DB}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


@pytest.mark.skipif(not LIVE_DB.exists(), reason="no collected data on this machine")
def test_per_tick_load_is_fast_on_the_real_corpus(tmp_path):
    copy = tmp_path / "snap.sqlite"
    _snapshot(copy)
    conn = store.connect(copy)

    load_history(conn, cold_dir=config.PARQUET_DIR)      # warm the cold cache
    started = time.perf_counter()
    load_history(conn, cold_dir=config.PARQUET_DIR)      # the steady-state tick
    elapsed = time.perf_counter() - started

    # Generous on purpose: this is a tripwire for an O(corpus) regression, not
    # a benchmark. Measured warm load on the real corpus is ~0.24s; the O(corpus)
    # behaviour this guards against reaches 43s at day 30 and 526s at day 365
    # against a 300s poll slot, so 30s never flakes while still catching it.
    assert elapsed < 30, (
        f"a warm load took {elapsed:.1f}s; the poll slot is 300s and this must not "
        "grow with corpus age"
    )


@pytest.mark.skipif(not LIVE_DB.exists(), reason="no collected data on this machine")
def test_retained_observations_are_bounded_on_the_real_corpus(tmp_path):
    copy = tmp_path / "snap.sqlite"
    _snapshot(copy)
    h = load_history(store.connect(copy), cold_dir=config.PARQUET_DIR)

    assert h.recent, "expected a citywide history"
    worst = max(len(series) for series in h.recent.values())
    assert worst <= config.HISTORY_TAIL

    total = sum(len(series) for series in h.recent.values())
    assert total <= len(h.recent) * config.HISTORY_TAIL

    # Counts must still span the entire corpus, far exceeding what is retained.
    assert h.counts.glob[1] > total, (
        "climatology must have counted more observations than history retains"
    )
