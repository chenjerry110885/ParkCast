"""Guards the four generated fixtures the JS suite reads against silent rot:
`week-buckets.json`, `seam-grid.bin`, `seam-week.bin` and `seam.json`, all
under `web/tests/fixtures/`.

None of them is hand-maintained -- see `scripts/build-seam-fixture.py`. If
`forecast.week_bucket`, `config.TAIPEI_TZ`, the encoders, the forecasters, or
the generator's own inputs ever changed without the fixtures being regenerated
and recommitted, the committed files and a fresh run would quietly diverge,
and the first sign would be an unexplained failure in the JS suite
(`web/tests/week.test.ts`, `web/tests/seam.test.ts`) with no clue that the
fixture, not the client, was the stale half. These tests catch that here
instead, in the same suite the generator lives in.
"""
import importlib.util
import json
import sys
from pathlib import Path

from parkcast import artifacts, config
from parkcast.forecast import Climatology, week_bucket
from parkcast.grid import UNKNOWN as GRID_UNKNOWN

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = ROOT / "scripts" / "build-seam-fixture.py"
FIXTURE_DIR = ROOT / "web" / "tests" / "fixtures"
FIXTURE_PATH = FIXTURE_DIR / "week-buckets.json"
SEAM_GRID_PATH = FIXTURE_DIR / "seam-grid.bin"
SEAM_WEEK_PATH = FIXTURE_DIR / "seam-week.bin"
SEAM_JSON_PATH = FIXTURE_DIR / "seam.json"


def _load_script():
    """Import the generator by file path.

    Its filename has a hyphen (`build-seam-fixture.py`, matching this repo's
    other one-off `scripts/*.py` tools), which is not a legal module name, so
    a plain `import` cannot reach it.

    The module is registered in `sys.modules` before it is executed -- the
    recipe importlib's own "importing a source file directly" documentation
    gives, and not optional here. The script runs under `from __future__
    import annotations`, so every annotation in it is a string, and
    `@dataclass` resolves those by looking its class's module back up in
    `sys.modules`. Left unregistered, that lookup returns `None` and the
    decorator dies with a bare `AttributeError: 'NoneType' object has no
    attribute '__dict__'` -- pointing at `dataclasses.py`, not at anything
    this repo wrote.
    """
    spec = importlib.util.spec_from_file_location("build_seam_fixture", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_fixture_is_committed():
    assert FIXTURE_PATH.exists(), (
        f"{FIXTURE_PATH} is missing -- run `python {SCRIPT_PATH.relative_to(ROOT)}`"
    )


def test_regenerating_the_fixture_is_byte_identical():
    """The load-bearing check: what the generator produces right now, in
    memory, must equal what is committed on disk, byte for byte."""
    script = _load_script()
    fresh = script.render(script.build_rows())
    committed = FIXTURE_PATH.read_text(encoding="utf-8")
    assert fresh == committed, (
        "web/tests/fixtures/week-buckets.json is stale -- regenerate it with "
        f"`python {SCRIPT_PATH.relative_to(ROOT)}` and commit the result"
    )


def test_fixture_rows_agree_with_week_bucket_directly():
    """Every row's bucket is what `week_bucket` returns for its own `ts`,
    checked independently of the generator's code path -- so a bug shared by
    both `row()` and this test (e.g. importing the wrong `week_bucket`) is
    still caught, not just a mismatch between two copies of the same call.
    """
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert len(payload["rows"]) > 50, "fixture should cover far more than the five pinned rows"
    for entry in payload["rows"]:
        assert week_bucket(entry["ts"]) == entry["bucket"], entry


def test_fixture_matches_the_plans_pinned_table():
    """Cross-checks the Stage A task-5 brief's own table against real
    calendar dates, independently of the generator's `_pinned_rows` list --
    the same discipline `tests/test_week.py::test_bucket_zero_is_thursday_not_monday`
    applies to the same five values via epoch-offset arithmetic instead.
    """
    script = _load_script()
    t = script.taipei_ts
    assert week_bucket(t(2026, 9, 17, 0, 0)) == 0      # Thu 00:00 -- not Monday
    assert week_bucket(t(2026, 9, 14, 0, 0)) == 192     # Mon 00:00
    assert week_bucket(t(2026, 9, 14, 0, 29)) == 192    # Mon 00:29
    assert week_bucket(t(2026, 9, 14, 0, 30)) == 193    # Mon 00:30
    assert week_bucket(t(2026, 9, 13, 23, 30)) == 191   # Sun 23:30


# --- the seam blobs ---------------------------------------------------------
#
# `web/tests/seam.test.ts` asserts the client's week-table arithmetic at
# +120 min reproduces the number the server already put in `grid.bin`'s last
# column. Both blobs it reads are written here, by the real encoders, from one
# synthetic history -- so the same rot risk applies as to the bucket table
# above, with a sharper edge: a stale `seam-grid.bin` would leave the JS suite
# comparing today's client against a forecast built by an older `Blend`, and
# the failure would name the client.


def test_seam_blobs_are_committed():
    for path in (SEAM_GRID_PATH, SEAM_WEEK_PATH, SEAM_JSON_PATH):
        assert path.exists(), (
            f"{path} is missing -- run `python {SCRIPT_PATH.relative_to(ROOT)}`"
        )


def test_regenerating_the_seam_blobs_is_byte_identical():
    """The same load-bearing check the bucket table gets: what the generator
    produces right now, in memory, must equal what is committed on disk."""
    script = _load_script()
    fresh_grid, fresh_week, payload = script.build_seam_blobs()
    stale = (
        "web/tests/fixtures/seam-*.bin is stale -- regenerate it with "
        f"`python {SCRIPT_PATH.relative_to(ROOT)}` and commit the result"
    )
    assert fresh_grid == SEAM_GRID_PATH.read_bytes(), stale
    assert fresh_week == SEAM_WEEK_PATH.read_bytes(), stale
    assert script.render_seam_json(payload) == SEAM_JSON_PATH.read_text(encoding="utf-8"), stale


def test_seam_json_indexes_the_blobs_it_was_built_beside():
    """`seam.json` is the JS test's only index into two opaque blobs. If its
    row, its `f` or its `base_data_ts` ever drifted from the fixture the
    generator actually wrote, the JS test would compare the right grid column
    against the wrong lot's climatology -- and still produce a number."""
    script = _load_script()
    payload = json.loads(SEAM_JSON_PATH.read_text(encoding="utf-8"))
    lot = script.SEAM_LOTS[payload["lot_index"]]
    assert payload["lot_id"] == lot.bare_id
    assert payload["f"] == lot.free_now
    assert payload["base_data_ts"] == script.SEAM_BASE_TS
    header = artifacts.decode_header(SEAM_GRID_PATH.read_bytes())
    assert header["base_data_ts"] == payload["base_data_ts"]
    assert 0 <= payload["lot_index"] < header["n_lots"]
    # One roster across both files, or the JS test's row index means two
    # different lots in the two blobs it indexes with it.
    assert artifacts.decode_week_header(SEAM_WEEK_PATH.read_bytes())["roster_id"] == header["roster_id"]


def test_seam_fixture_lot_measures_the_seam_not_the_no_data_path():
    """The fixture lot must have a REAL climatology in its +120 min bucket.

    There is one legitimate divergence at this seam, and it is not what the JS
    test is for: where `Climatology.predict` returns `None` but `Persistence`
    does not, `Blend` hands back pure persistence and the grid stores 0 or
    100, while the week cell stores `WEEK_UNKNOWN` and the client honestly
    renders "no data". Were the fixture lot to drift into that state, the JS
    test would stop measuring the seam -- and, depending on how it was
    written, could still go green. This pins it shut from the Python side, in
    the suite that owns the generator.
    """
    script = _load_script()
    payload = json.loads(SEAM_JSON_PATH.read_text(encoding="utf-8"))
    index = payload["lot_index"]
    lot_id = script.SEAM_LOTS[index].lot_id
    target_ts = payload["base_data_ts"] + 120 * 60
    bucket = week_bucket(target_ts)

    history = script.build_seam_history()
    assert Climatology(history).predict(lot_id, target_ts, 0) is not None
    # Observations of this lot in this bucket specifically, so the cell is a
    # real time-of-week rate rather than the lot or citywide tier showing
    # through an empty bucket.
    assert history.counts.bucket.get((lot_id, bucket), (0, 0))[1] > 0

    week_blob = SEAM_WEEK_PATH.read_bytes()
    offset = artifacts.WEEK_HEADER_SIZE + (index * config.WEEK_BUCKETS + bucket) * 2
    assert week_blob[offset] != artifacts.WEEK_UNKNOWN
    assert week_blob[offset + 1] > 0

    grid_blob = SEAM_GRID_PATH.read_bytes()
    last_column = artifacts.HEADER_SIZE + (index + 1) * config.HORIZON_COUNT - 1
    assert grid_blob[last_column] != GRID_UNKNOWN
    # The reading and the arrival sit in different buckets, which is what lets
    # the JS test tell a client that buckets on the arrival time apart from one
    # that quietly reused the reading's own.
    assert week_bucket(payload["base_data_ts"]) != bucket


def test_seam_history_holds_nothing_after_its_own_reading():
    """No observation may postdate `latest_ts`.

    The grid is built to forecast from that reading; a history carrying rows
    from after it would let `Climatology` count the very answer it is being
    asked to predict, and the seam would agree for a reason that does not
    exist in production.
    """
    script = _load_script()
    history = script.build_seam_history()
    assert history.latest_ts == script.SEAM_BASE_TS
    assert max(ts for _, ts, _ in script._seam_observations()) == history.latest_ts
    assert set(history.current) == {lot.lot_id for lot in script.SEAM_LOTS}
