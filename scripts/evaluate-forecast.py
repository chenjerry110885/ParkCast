"""Score the shipped forecasters against what actually happened.

    python scripts/evaluate-forecast.py
    python scripts/evaluate-forecast.py --city kaohsiung
    python scripts/evaluate-forecast.py --test-fraction 0.3 --origins 60

One city per run, defaulting to Taipei. The store holds six, each on its own
feed clock and with its own published climatology, and a run over all of them
reports a number about none of them -- see `parkcast.evaluate.backtest`. To
compare cities, run it once per city; there is deliberately no combined
headline.

The split is by time and the cutoff is data-driven: by default the earliest 70%
of collected timestamps train, the latest 30% are scored. Nothing is chosen at
random -- see `parkcast.evaluate` for why that would invalidate the result.

Read the support table before the headline. A thin corpus makes a small
difference mean "not yet distinguishable", not "climatology wins".
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from parkcast import config, ids, store                               # noqa: E402
from parkcast.evaluate import (                                       # noqa: E402
    FORECASTERS, backtest, brier, calibration, choose_origins,
    hard_lots, load_labels, skill, taipei,
)

HORIZONS = (5, 15, 30, 60, 120)
HARD_THRESHOLD = 0.9


def fmt(value, width=7, places=4):
    return f"{'--':>{width}}" if value is None else f"{value:{width}.{places}f}"


#: Row order. Not `FORECASTERS`, which no longer names the trained model: it
#: needs a model directory and a roster, so `backtest` adds it to `by_model`
#: instead. Iterating what was actually scored also means an absent model shows
#: no row at all, rather than a row of `--` that reads as a forecaster which had
#: nothing to say.
ROW_ORDER = ("persistence", "climatology", "blend", "trained")


def rows_of(by_model):
    return [n for n in ROW_ORDER if n in by_model]


def by_horizon(title, by_model):
    """Brier per forecaster at each horizon, with blend as the reference.

    Blend rather than persistence: persistence is blend's component, and the
    product question turns on whether anything beats the forecaster currently
    serving -- at the horizons the app actually opens on.
    """
    names = rows_of(by_model)
    print(f"\n{title}")
    header = f"  {'horizon':>8}{'n':>9}" + "".join(f"{n[:9]:>10}" for n in names)
    if "trained" in names:
        header += f"{'trained vs blend':>18}"
    print(header)
    for h in HORIZONS:
        at_h = {n: [p for p in preds if p.horizon_min == h] for n, preds in by_model.items()}
        scores = {n: brier(at_h[n]) for n in names}
        row = f"  {h:>6} min{len(at_h[names[0]]):>9,}"
        row += "".join(fmt(scores[n], 10) for n in names)
        if "trained" in names:
            row += fmt(skill(scores["trained"], scores.get("blend")), 18)
        print(row)


def table(title, subsets):
    """One block: Brier per forecaster over a named set of predictions.

    `vs blend` is the column that decides anything. Blend is what ships;
    persistence and climatology are its components, and a blend routinely beats
    both -- so a model can look strong against the parts while losing to the
    whole. That is not hypothetical: the nightly gate let exactly that through
    on 2026-09-23, before blend was added to the bar it has to clear.
    """
    print(f"\n{title}")
    print(f"  {'':14s}{'n':>9}{'Brier':>9}{'vs persist':>12}{'vs clim':>10}{'vs blend':>10}")
    for label, by_model in subsets:
        scores = {name: brier(preds) for name, preds in by_model.items()}
        for name in rows_of(by_model):
            preds = by_model[name]
            row = f"  {(label + ' ' + name) if label else name:14s}"
            row += f"{len(preds):>9,}{fmt(scores[name], 9)}"
            row += fmt(skill(scores[name], scores['persistence']), 12) if name != "persistence" else f"{'--':>12}"
            row += fmt(skill(scores[name], scores['climatology']), 10) if name != "climatology" else f"{'--':>10}"
            row += fmt(skill(scores[name], scores.get('blend')), 10) if name != "blend" else f"{'--':>10}"
            print(row)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--test-fraction", type=float, default=0.30,
                    help="share of the collected timespan held out (default 0.30)")
    ap.add_argument("--origins", type=int, default=48, help="how many origins to score")
    ap.add_argument("--every-minutes", type=int, default=30, help="spacing between origins")
    ap.add_argument("--include-not-updating", action="store_true",
                    help="also score lots the app shows as not updating (to compare)")
    ap.add_argument("--city", default=ids.LEGACY_CITY,
                    help="which city's shard to score (default taipei)")
    ap.add_argument("--models", default=None,
                    help="score the trained model in data/models too (e.g. --models data/models)")
    args = ap.parse_args()

    conn = store.connect(config.DB_PATH)
    labels = load_labels(conn, config.PARQUET_DIR, city=args.city)
    if not labels:
        raise SystemExit(f"no observations for {args.city} -- nothing to evaluate")

    stamps = sorted(labels)
    cutoff = stamps[int(len(stamps) * (1 - args.test_fraction))]
    origins = choose_origins(labels, start_ts=cutoff, every_minutes=args.every_minutes,
                             limit=args.origins)
    if not origins:
        raise SystemExit("no origins in the test period")

    print(f"ParkCast forecast evaluation -- {args.city}")
    print(f"  corpus   {taipei(stamps[0]):%Y-%m-%d %H:%M} -> {taipei(stamps[-1]):%Y-%m-%d %H:%M} Taipei"
          f"  ({len(stamps):,} collected ticks)")
    print(f"  train    everything before {taipei(cutoff):%Y-%m-%d %H:%M}")
    print(f"  test     {len(origins)} origins, {taipei(origins[0]):%m-%d %H:%M} -> "
          f"{taipei(origins[-1]):%m-%d %H:%M}, horizons {HORIZONS} min")

    hard = hard_lots(conn, config.PARQUET_DIR, before_ts=cutoff, threshold=HARD_THRESHOLD)
    print(f"  hard set {len(hard)} lots free <{HARD_THRESHOLD:.0%} of the time in training")

    # The trained model, and the roster as it stood at the training cutoff --
    # `train.latest_roster` rather than today's, so a lot that has since left
    # the feed is not described as though it were still there.
    model_dir, lots = None, None
    if args.models:
        from parkcast import train

        model_dir = Path(args.models) / args.city
        lots = list(train.latest_roster(config.PARQUET_DIR / "meta",
                                        before_ts=cutoff, city=args.city))
        if not lots:
            raise SystemExit(f"no dated roster at or before the cutoff for {args.city}")

    result = backtest(conn, config.PARQUET_DIR, city=args.city, origins=origins,
                      horizons=HORIZONS,
                      withhold_not_updating=not args.include_not_updating,
                      model_dir=model_dir, lots=lots)
    if not any(result.by_model.values()):
        raise SystemExit("no predictions scored -- the test period has no paired labels")

    if result.origins_before_cutoff:
        # Said out loud, because a report about a shorter span than its header
        # claims is the kind of number that gets quoted later.
        print(f"\n  NOTE  {result.origins_before_cutoff} of "
              f"{len(origins)} origins precede the model's training cutoff and were "
              f"dropped from EVERY forecaster -- scoring the model there would score "
              f"it on its own training data, and dropping it alone would compare the "
              f"rest on a different sample. {len(result.origins)} origins remain.")
    if args.models and "trained" not in result.by_model:
        print("\n  NOTE  no trained model was scored: none loaded from "
              f"{model_dir} (see the log above for why). The baselines below are "
              "unaffected.")

    base = sum(p.outcome for p in result.by_model["blend"]) / len(result.by_model["blend"])
    print(f"\n  scored   {len(result.by_model['blend']):,} predictions per forecaster")
    if args.include_not_updating:
        print("  withheld nothing -- lots shown as not updating are scored too (--include-not-updating)")
    else:
        print(f"  withheld {result.withheld:,} labels for lots the app showed as not updating at "
              f"their origin (no forecast is published for them, so none is scored)")
    print(f"  base rate {base:.3f} of them had a space "
          f"(a forecast of a flat {base:.3f} scores {base * (1 - base):.4f})")

    table(f"{args.city.upper()}  -- dominated by easy cases; read the hard subset below",
          [("", result.by_model)])

    hard_only = {name: [p for p in preds if p.lot_id in hard]
                 for name, preds in result.by_model.items()}
    if any(hard_only.values()):
        hb = sum(p.outcome for p in hard_only["blend"]) / max(1, len(hard_only["blend"]))
        table(f"HARD SUBSET -- lots that actually fill up (base rate {hb:.3f})",
              [("", hard_only)])
    else:
        print("\nHARD SUBSET: no predictions -- no hard lot had a paired label.")

    by_horizon("BY HORIZON", result.by_model)

    # The product question, isolated: on the lots a driver actually needs help
    # with, at the horizons the app actually opens on, does the probability beat
    # "is it free right now?" Neither aggregate above answers it -- the citywide
    # one is drowned in easy lots, the by-horizon one in easy horizons.
    if any(hard_only.values()):
        by_horizon("HARD SUBSET BY HORIZON  -- the question the app exists to answer",
                   hard_only)

    # Every forecaster that ran, because mid-band overconfidence is one of the
    # two defects Stage B exists to fix -- 0.8-0.9 said 0.862 and happened 0.791
    # on the last citywide run -- and a trained model that MOVED the gap rather
    # than closing it would be invisible in a Brier column.
    for name in rows_of(result.by_model):
        if name not in ("blend", "trained"):
            continue
        print()
        print(f"CALIBRATION ({name})  -- does '21%' happen 21% of the time?")
        print(f"  {'band':>12}{'n':>9}{'said':>8}{'happened':>10}{'gap':>8}")
        for b in calibration(result.by_model[name]):
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
