#!/usr/bin/env python
"""What the nightly gate has been deciding, and whether the gap is closing.

    python scripts/model-trend.py
    python scripts/model-trend.py --models data/models --city taipei

One night is a sample. The question a deploy decision actually turns on is
whether the trained model is *approaching* the forecaster it would replace, and
that only shows up across nights -- which is why every decision, adopted or
declined, is appended to `decisions.jsonl` rather than logged and lost.

Read the `vs blend` column, not `vs persist`. Blend is what ships; persistence
and climatology are its components, and a blend routinely beats both of them.
A model can look good against the parts while losing to the whole -- which is
exactly what the gate let through on 2026-09-23 before `Blend` was added to the
bar it has to clear.

Takes its paths as arguments and reads nothing else. Nothing here writes.
"""
import argparse
import json
from pathlib import Path


def skill(model: float | None, reference: float | None) -> float | None:
    """Fraction of the reference's error removed. Positive is better.

    None rather than 0.0 when either side is missing: an unmeasured comparison
    and a dead heat must not print the same number.
    """
    if model is None or reference is None or not reference:
        return None
    return 1.0 - model / reference


def fmt(value: float | None) -> str:
    return f"{'--':>8}" if value is None else f"{value:>+7.1%}"


def brier(value: float | None) -> str:
    return f"{'--':>8}" if value is None else f"{value:>8.4f}"


def load(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"no decisions at {path} -- has the trainer run yet?")
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--models", default="data/models")
    ap.add_argument("--city", default="taipei")
    args = ap.parse_args()

    rows = load(Path(args.models) / args.city / "decisions.jsonl")
    print(f"NIGHTLY GATE  {args.city}  ({len(rows)} decision"
          f"{'' if len(rows) == 1 else 's'})\n")
    print(f"{'served':11}{'rows':>9}{'candidate':>10}{'blend':>9}"
          f"{'vs blend':>10}{'vs persist':>11}{'vs clim':>9}  verdict")

    gaps = []
    for row in rows:
        s = row.get("scores", {})
        gap = skill(s.get("candidate"), s.get("blend"))
        if gap is not None:
            gaps.append((row["day"], gap))
        verdict = "ADOPTED" if row["adopted"] else "declined"
        print(f"{row['day']:11}{s.get('rows', 0):>9,}{brier(s.get('candidate'))}"
              f"{brier(s.get('blend'))}{fmt(gap)}"
              f"{fmt(skill(s.get('candidate'), s.get('persistence')))}"
              f"{fmt(skill(s.get('candidate'), s.get('climatology')))}  {verdict}")

    if len(gaps) < 2:
        print("\nOne night is a sample, not a trend. Run it again tomorrow.")
        return 0

    first, last = gaps[0][1], gaps[-1][1]
    print(f"\nagainst blend: {first:+.1%} on {gaps[0][0]} -> {last:+.1%} on {gaps[-1][0]}")
    best = max(gaps, key=lambda g: g[1])
    print(f"best night:    {best[1]:+.1%} on {best[0]}")
    if all(g < 0 for _, g in gaps):
        print("\nThe model has not beaten blend on any night. Blend stays in the grid.")
        moving = last - first
        direction = ("closing" if moving > 0.01 else
                     "widening" if moving < -0.01 else "flat")
        print(f"The gap is {direction} ({moving:+.1%} across these nights).")
        print("A gap that is flat as the corpus grows is the answer, not a wait.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
