"""Guards `web/tests/fixtures/week-buckets.json` against silent rot.

The file is generated, not hand-maintained -- see `scripts/build-seam-fixture.py`.
If `forecast.week_bucket`, `config.TAIPEI_TZ`, or the generator's own row list
ever changed without the fixture being regenerated and recommitted, the
committed file and a fresh run would quietly diverge, and the first sign would
be an unexplained failure in the JS suite (`web/tests/week.test.ts`) with no
clue that the fixture, not `weekBucket`, was the stale half. This test catches
that here instead, in the same suite the generator lives in.
"""
import importlib.util
import json
from pathlib import Path

from parkcast.forecast import week_bucket

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = ROOT / "scripts" / "build-seam-fixture.py"
FIXTURE_PATH = ROOT / "web" / "tests" / "fixtures" / "week-buckets.json"


def _load_script():
    """Import the generator by file path.

    Its filename has a hyphen (`build-seam-fixture.py`, matching this repo's
    other one-off `scripts/*.py` tools), which is not a legal module name, so
    a plain `import` cannot reach it.
    """
    spec = importlib.util.spec_from_file_location("build_seam_fixture", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
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
