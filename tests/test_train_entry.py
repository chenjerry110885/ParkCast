"""The trainer's entry point, and the containment it depends on.

The compose service denies the trainer a network, mounts the corpus read-only
and gives it write access to nothing but its own model directory. Two of those
are enforced by Docker and verified against a scratch directory; the third --
that the code does not even try to open the store for writing -- belongs here,
because a read-only mount turns a would-be write into a crash at startup rather
than a refusal, and a trainer that crashes every night is a trainer nobody
notices has stopped.
"""
import json
from datetime import date

import pytest

from parkcast import store, train
from parkcast.compact import day_bounds
from parkcast.feed import TS_FEED, FeedSnapshot, Observation


def entry(lot_id="X1", name="n"):
    return {"id": lot_id, "name": name, "area": "大安區", "type2": "平面",
            "totalcar": "50", "tw97x": "302864.78", "tw97y": "2771988.95"}


def snapshot(meta_dir, day, entries):
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / f"{day.isoformat()}.json").write_text(
        json.dumps({"data": {"park": entries}}), encoding="utf-8")


# --- the store is opened read-only ------------------------------------------


def test_the_trainer_cannot_write_to_the_corpus(tmp_path):
    """`mode=ro` is enforced by SQLite, not by convention, so this holds even
    where the filesystem would have allowed it. The corpus is the one asset
    here that cannot be recreated: a feed serves the present, so a day not
    collected is gone."""
    path = tmp_path / "t.sqlite"
    writable = store.connect(path)
    store.insert_snapshot(
        writable, FeedSnapshot("taipei", 100, (Observation("taipei:A", 5, None, 95, TS_FEED),)),
        {"taipei:A": 50})
    writable.close()

    readonly = store.connect_readonly(path)
    assert readonly.execute("SELECT count(*) FROM observations").fetchone()[0] == 1
    with pytest.raises(Exception):
        readonly.execute("DELETE FROM observations")
    readonly.close()


def test_the_read_only_connection_does_not_try_to_migrate(tmp_path):
    """`store.connect` runs the schema script and an ALTER TABLE, which would
    fail outright on the trainer's read-only mount. This one must not."""
    path = tmp_path / "t.sqlite"
    store.connect(path).close()

    conn = store.connect_readonly(path)          # must not raise
    conn.close()


# --- the roster is the one that was current then ----------------------------


def test_the_roster_is_the_newest_snapshot_at_or_before_the_cutoff(tmp_path):
    """Training rows from three weeks ago are joined against the roster as it
    was then. Using today's would be a mild look-ahead, and would describe a
    lot that has since left the feed as though it were still there."""
    meta = tmp_path / "meta"
    snapshot(meta, date(2026, 9, 18), [entry("OLD")])
    snapshot(meta, date(2026, 9, 19), [entry("MID")])
    snapshot(meta, date(2026, 9, 21), [entry("NEW")])

    lots = train.latest_roster(meta, before_ts=day_bounds(date(2026, 9, 20))[0])

    assert [lot.id for lot in lots] == ["taipei:MID"]


def test_a_snapshot_after_the_cutoff_is_never_used(tmp_path):
    meta = tmp_path / "meta"
    snapshot(meta, date(2026, 9, 25), [entry("FUTURE")])

    assert train.latest_roster(meta, before_ts=day_bounds(date(2026, 9, 20))[0]) == ()


def test_a_file_that_is_not_a_dated_snapshot_is_skipped(tmp_path):
    """One stray file in the directory must not become the roster -- the same
    rule `forecast._read_parquet_day` applies to the same tree."""
    meta = tmp_path / "meta"
    snapshot(meta, date(2026, 9, 19), [entry("REAL")])
    (meta / "notes.json").write_text('{"data": {"park": []}}', encoding="utf-8")

    lots = train.latest_roster(meta, before_ts=day_bounds(date(2026, 9, 20))[0])
    assert [lot.id for lot in lots] == ["taipei:REAL"]


def test_no_snapshot_at_all_is_empty_rather_than_an_error(tmp_path):
    assert train.latest_roster(tmp_path / "nothing", before_ts=1_700_000_000) == ()


# --- declining is not failing -----------------------------------------------


def test_the_entry_point_exits_zero_when_it_has_nothing_to_train_on(tmp_path, caplog):
    """Declining is a normal outcome. A non-zero exit would make a restart
    policy fight a healthy gate, and a nightly job that looks broken every
    night is one nobody reads."""
    (tmp_path / "cold").mkdir()
    store.connect(tmp_path / "hot.sqlite").close()

    code = train.main([
        "--day", "2026-09-20", "--hot", str(tmp_path / "hot.sqlite"),
        "--cold", str(tmp_path / "cold"), "--models", str(tmp_path / "models"),
    ])

    assert code == 1, "no roster at all is the one case worth a non-zero exit"
