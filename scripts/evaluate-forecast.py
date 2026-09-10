"""Score the shipped forecasters against what actually happened.

    python scripts/evaluate-forecast.py
    python scripts/evaluate-forecast.py --test-fraction 0.3 --origins 60

The split is by time and the cutoff is data-driven: by default the earliest 70%
of collected timestamps train, the latest 30% are scored. Nothing is chosen at
random -- see `parkcast.evaluate` for why that would invalidate the result.

Read the support table before the headline. This corpus is a week old with
34% coverage, so the honest reading of a small difference is "not yet
distinguishable", not "climatology wins".
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from parkcast import config, store                                    # noqa: E402
from parkcast.evaluate import (                                       # noqa: E402
    FORECASTERS, backtest, brier, calibration, choose_origins,
    hard_lots, load_labels, skill, taipei,
)

HORIZONS = (5, 15, 30, 60, 120)
HARD_THRESHOLD = 0.9


def fmt(value, width=7, places=4):
    return f"{'--':>{width}}" if value is None else f"{value:{width}.{places}f}"


def table(title, subsets):
    """One block: Brier per forecaster over a named set of predictions."""
    print(f"\n{title}")
    print(f"  {'':14s}{'n':>9}{'Brier':>9}{'vs persist':>12}{'vs clim':>10}")
    for label, by_model in subsets:
        scores = {name: brier(preds) for name, preds in by_model.items()}
        for name, _ in FORECASTERS:
            preds = by_model[name]
            row = f"  {(label + ' ' + name) if label else name:14s}"
            row += f"{len(preds):>9,}{fmt(scores[name], 9)}"
            row += fmt(skill(scores[name], scores['persistence']), 12) if name != "persistence" else f"{'--':>12}"
            row += fmt(skill(scores[name], scores['climatology']), 10) if name != "climatology" else f"{'--':>10}"
            print(row)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--test-fraction", type=float, default=0.30,
                    help="share of the collected timespan held out (default 0.30)")
    ap.add_argument("--origins", type=int, default=48, help="how many origins to score")
    ap.add_argument("--every-minutes", type=int, default=30, help="spacing between origins")
    args = ap.parse_args()

    conn = store.connect(config.DB_PATH)
    labels = load_labels(conn, config.PARQUET_DIR)
    if not labels:
        raise SystemExit("no observations -- nothing to evaluate")

    stamps = sorted(labels)
    cutoff = stamps[int(len(stamps) * (1 - args.test_fraction))]
    origins = choose_origins(labels, start_ts=cutoff, every_minutes=args.every_minutes,
                             limit=args.origins)
    if not origins:
        raise SystemExit("no origins in the test period")

    print("ParkCast forecast evaluation")
    print(f"  corpus   {taipei(stamps[0]):%Y-%m-%d %H:%M} -> {taipei(stamps[-1]):%Y-%m-%d %H:%M} Taipei"
          f"  ({len(stamps):,} collected ticks)")
    print(f"  train    everything before {taipei(cutoff):%Y-%m-%d %H:%M}")
    print(f"  test     {len(origins)} origins, {taipei(origins[0]):%m-%d %H:%M} -> "
          f"{taipei(origins[-1]):%m-%d %H:%M}, horizons {HORIZONS} min")

    hard = hard_lots(conn, config.PARQUET_DIR, before_ts=cutoff, threshold=HARD_THRESHOLD)
    print(f"  hard set {len(hard)} lots free <{HARD_THRESHOLD:.0%} of the time in training")

    result = backtest(conn, config.PARQUET_DIR, origins=origins, horizons=HORIZONS)
    if not any(result.by_model.values()):
        raise SystemExit("no predictions scored -- the test period has no paired labels")

    base = sum(p.outcome for p in result.by_model["blend"]) / len(result.by_model["blend"])
    print(f"\n  scored   {len(result.by_model['blend']):,} predictions per forecaster")
    print(f"  base rate {base:.3f} of them had a space "
          f"(a forecast of a flat {base:.3f} scores {base * (1 - base):.4f})")

    table("CITYWIDE  -- dominated by easy cases; read the hard subset below",
          [("", result.by_model)])

    hard_only = {name: [p for p in preds if p.lot_id in hard]
                 for name, preds in result.by_model.items()}
    if any(hard_only.values()):
        hb = sum(p.outcome for p in hard_only["blend"]) / max(1, len(hard_only["blend"]))
        table(f"HARD SUBSET -- lots that actually fill up (base rate {hb:.3f})",
              [("", hard_only)])
    else:
        print("\nHARD SUBSET: no predictions -- no hard lot had a paired label.")

    # Persistence is the bar the spec gates on, so it gets its own column here:
    # a blend that never overtakes it at any horizon is not a better forecast,
    # it is a worse one with more machinery.
    print("\nBY HORIZON")
    print(f"  {'horizon':>8}{'n':>9}{'persist':>9}{'blend':>9}{'blend vs persist':>18}{'vs clim':>10}")
    for h in HORIZONS:
        at_h = {n: [p for p in preds if p.horizon_min == h] for n, preds in result.by_model.items()}
        b, c = brier(at_h["blend"]), brier(at_h["climatology"])
        pe = brier(at_h["persistence"])
        print(f"  {h:>6} min{len(at_h['blend']):>9,}{fmt(pe, 9)}{fmt(b, 9)}"
              f"{fmt(skill(b, pe), 18)}{fmt(skill(b, c), 10)}")

    # The product question, isolated: on the lots a driver actually needs help
    # with, at the horizons the app actually opens on, does the probability beat
    # "is it free right now?" Neither aggregate above answers it -- the citywide
    # one is drowned in easy lots, the by-horizon one in easy horizons.
    if any(hard_only.values()):
        print("\nHARD SUBSET BY HORIZON  -- the question the app exists to answer")
        print(f"  {'horizon':>8}{'n':>9}{'persist':>9}{'blend':>9}{'blend vs persist':>18}")
        for h in HORIZONS:
            at_h = {n: [p for p in preds if p.horizon_min == h] for n, preds in hard_only.items()}
            b, pe = brier(at_h["blend"]), brier(at_h["persistence"])
            print(f"  {h:>6} min{len(at_h['blend']):>9,}{fmt(pe, 9)}{fmt(b, 9)}{fmt(skill(b, pe), 18)}")

    print("\nCALIBRATION (blend)  -- does '21%' happen 21% of the time?")
    print(f"  {'band':>12}{'n':>9}{'said':>8}{'happened':>10}{'gap':>8}")
    for b in calibration(result.by_model["blend"]):
        gap = b.observed_rate - b.mean_predicted
        print(f"  {b.low:.1f}-{b.high:.1f}{'':>4}{b.count:>9,}{b.mean_predicted:>8.3f}"
              f"{b.observed_rate:>10.3f}{gap:>+8.3f}")

    print("\nSUPPORT  -- training observations behind each prediction's climatology bucket")
    print(f"  {'bucket n':>12}{'predictions':>13}{'blend Brier':>13}")
    for lo, hi, label in ((0, 1, "0 (no bucket)"), (1, 6, "1-5"), (6, 20, "6-19"),
                          (20, 10**9, "20+")):
        subset = [p for p in result.by_model["blend"] if lo <= p.support < hi]
        print(f"  {label:>12}{len(subset):>13,}{fmt(brier(subset), 13)}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
