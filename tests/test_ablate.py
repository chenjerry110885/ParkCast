"""The model ablation: an experiment that reports, and writes nothing.

`scripts/ablate-model.py` fits several variants of the trained model and scores
each against `Blend` on the same rows. It runs beside the live collector with
the corpus mounted read-only, and nothing it fits is meant to be served -- the
nightly gate is the only thing allowed to adopt a model. So the property that
matters most here is the negative one: a run leaves every file it can reach
exactly as it found it, and never calls `train.save`.
"""
import importlib.util
import pathlib
import sys

import pytest

from parkcast import store, train
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.metadata import Lot

_PATH = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "ablate-model.py"
_spec = importlib.util.spec_from_file_location("ablate_model", _PATH)
ablate = importlib.util.module_from_spec(_spec)
sys.modules["ablate_model"] = ablate
_spec.loader.exec_module(ablate)

#: 2026-07-01 00:00 Taipei, a Wednesday, well clear of any holiday.
START = 1_782_835_200
LOTS = [Lot(id=f"taipei:L{i}", name="n", area="大安區", lot_type="平面", capacity_car=50,
            lat=25.03, lon=121.54, service_time="", fare_text="每小時30元") for i in range(4)]


def _corpus(path: pathlib.Path):
    """Six days at a fifteen-minute cadence: lot 0 fills every afternoon, the
    others never do, so there is a hard lot and a signal to fit."""
    conn = store.connect(path)
    conn.execute("PRAGMA synchronous=OFF")
    for ts in range(START, START + 6 * 86400, 900):
        afternoon = 12 <= ((ts + 8 * 3600) % 86400) // 3600 < 18
        for i, lot in enumerate(LOTS):
            free = 0 if (i == 0 and afternoon) else 5 + i
            store.insert_snapshot(
                conn, FeedSnapshot("taipei", ts + 5, (Observation(lot.id, free, None, ts, TS_FEED),)),
                {lot.id: 50})
    return conn


def _tree(root: pathlib.Path) -> dict:
    """Every file outside the store's own folder, with when it last changed.
    The store is left out because SQLite keeps its own -wal/-shm housekeeping
    beside it; what it holds is checked by `_contents` instead."""
    return {p: p.stat().st_mtime_ns for p in root.rglob("*")
            if p.is_file() and "db" not in p.relative_to(root).parts}


def _contents(conn) -> list:
    return conn.execute("SELECT * FROM observations ORDER BY 1, 2, 3").fetchall()


@pytest.fixture
def ran(tmp_path, monkeypatch, capsys):
    (tmp_path / "db").mkdir()
    conn = _corpus(tmp_path / "db" / "t.sqlite")
    # Run from inside the tree, so a write to any relative path lands in it.
    monkeypatch.chdir(tmp_path)
    before = (_tree(tmp_path), _contents(conn))

    def refuse(*a, **k):
        raise AssertionError("the ablation must never write a model")

    monkeypatch.setattr(train, "save", refuse)
    results = ablate.run(conn, None, city="taipei", lots=LOTS, test_fraction=0.25,
                         n_origins=12, num_rounds=5)
    after = (_tree(tmp_path), _contents(conn))
    conn.close()
    return results, capsys.readouterr().out, before, after


def test_every_variant_is_scored_against_blend_on_the_same_rows(ran):
    results, out, _, _ = ran
    assert list(results) == ["blend", *ablate.VARIANTS]
    rows = {name: r["rows"] for name, r in results.items()}
    assert len(set(rows.values())) == 1 and next(iter(rows.values())) > 0
    for name in results:
        assert results[name]["brier"] is not None
        assert sum(line.startswith(f"{name} ") for line in out.splitlines()) == 2, name


def test_the_run_writes_nothing(ran):
    _, _, before, after = ran
    assert after == before
