"""The arithmetic behind the deploy decision.

The formatting is not worth testing; the skill score is, because it is the
number a "should we ship this" conversation turns on.
"""
import importlib.util
import json
import pathlib
import sys

import pytest

_PATH = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "model-trend.py"
_spec = importlib.util.spec_from_file_location("model_trend", _PATH)
model_trend = importlib.util.module_from_spec(_spec)
sys.modules["model_trend"] = model_trend
_spec.loader.exec_module(model_trend)


def test_skill_is_the_fraction_of_the_references_error_removed():
    assert model_trend.skill(0.05, 0.10) == pytest.approx(0.5)


def test_a_worse_model_scores_negative():
    """The case that matters here: the candidate losing to blend."""
    assert model_trend.skill(0.0347, 0.0306) == pytest.approx(-0.134, abs=0.001)


def test_an_unmeasured_comparison_is_none_not_zero():
    """0% reads as "a dead heat", which is a claim. None is the absence of one
    -- the same distinction `evaluate.brier` makes about an empty set."""
    assert model_trend.skill(0.05, None) is None
    assert model_trend.skill(None, 0.05) is None


def test_a_perfect_reference_is_none_rather_than_a_division_error():
    assert model_trend.skill(0.05, 0.0) is None


def test_decisions_are_read_in_the_order_they_were_written(tmp_path):
    """The trend is the point, so the order is load-bearing."""
    path = tmp_path / "decisions.jsonl"
    path.write_text("\n".join(json.dumps({"day": d, "adopted": False, "scores": {}})
                              for d in ("2026-09-25", "2026-09-26", "2026-09-27")),
                    encoding="utf-8")

    assert [r["day"] for r in model_trend.load(path)] == [
        "2026-09-25", "2026-09-26", "2026-09-27"]


def test_a_blank_line_is_not_a_decision(tmp_path):
    path = tmp_path / "decisions.jsonl"
    path.write_text('{"day": "2026-09-25", "adopted": false, "scores": {}}\n\n',
                    encoding="utf-8")

    assert len(model_trend.load(path)) == 1


def test_a_missing_file_says_so_rather_than_reporting_nothing(tmp_path):
    """An empty table and a trainer that has never run must not look alike."""
    with pytest.raises(SystemExit, match="has the trainer run"):
        model_trend.load(tmp_path / "nope.jsonl")
