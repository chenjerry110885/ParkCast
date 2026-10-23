"""Which change to the trained model actually helps? Fit the variants, score them.

    python scripts/ablate-model.py --test-fraction 0.20 --origins 200

Run in the collector image -- the only place lightgbm is installed -- with the
corpus mounted read-only. Cold only: the hot store is WAL and cannot be opened
from a read-only mount (see `store.connect_empty`).

One time split. Everything before the cutoff trains; the latest
`--test-fraction` of collected timestamps is scored, at `--origins` origins,
each with its OWN history cut at that origin -- the contract
`train.score_at_origins` documents, and the one whose absence once made a
leaking climatology look like the best forecaster in the room. Every variant
and `Blend` are scored on exactly the same rows: those where `Blend` has an
answer, which is every row the app publishes.

The variants, each a single change from the one before it:

  base, nightly rows   the 26 original columns, rows built the way the nightly
                       trainer built them until now: one history cut at the
                       cutoff, whose two-hour tail left almost every row
                       without the live reading
  base                 the same columns on served rows -- each origin sees the
                       readings the collector held then (`iter_served_rows`)
  +blend_p             ... plus the number `Blend` ships, as a feature
  +is_holiday          ... plus whether the target date is a public holiday
  +both                both
  +both, full x3       both, with every "no space" row counted three times
  +both, hard x3       both, with every row of a hard lot counted three times

Nothing is written. Every model lives in memory and dies with the process;
whatever wins, `Blend` keeps serving until the nightly gate adopts something.
`tests/test_ablate.py` holds that line.
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import numpy as np                                                    # noqa: E402

from parkcast import config, features, ids, store, train             # noqa: E402
from parkcast.evaluate import (                                       # noqa: E402
    choose_origins, hard_lots, load_labels, reading_series, skill, taipei,
)
from parkcast.forecast import Blend, Climatology, by_city, load_history  # noqa: E402
from parkcast.trainset import (                                       # noqa: E402
    iter_rows, iter_served_rows, sample_origins, spans_for,
)

HORIZONS = (5, 15, 30, 60, 120)
HARD_THRESHOLD = 0.9
#: The columns every model before this one was fitted on.
BASE = features.FEATURES[:26]
_ALL = features.FEATURES
#: name -> (columns, rows, weighting). `rows` is "served" or "nightly".
_SPEC = {
    "base, nightly rows": (BASE, "nightly", None),
    "base": (BASE, "served", None),
    "+blend_p": (BASE + ("blend_p",), "served", None),
    "+is_holiday": (BASE + ("is_holiday",), "served", None),
    "+both": (_ALL, "served", None),
    "+both, full x3": (_ALL, "served", "full"),
    "+both, hard x3": (_ALL, "served", "hard"),
}
VARIANTS = tuple(_SPEC)
#: Calibration bands reported, as [low, high) over the predicted probability.
GAP_BANDS = ((0.0, 0.2), (0.2, 0.9))


def _brier(p: np.ndarray, y: np.ndarray) -> float | None:
    return None if len(y) == 0 else float(np.mean((p - y) ** 2))


def _gap(p: np.ndarray, y: np.ndarray, low: float, high: float) -> float | None:
    """Count-weighted |observed - predicted| over the 0.1-wide bands in
    [low, high). The mid band is where the shipped forecaster was measured
    overconfident (said 0.862, happened 0.791), and a Brier column can hide a
    variant that moved that gap rather than closing it."""
    total, weighted = 0, 0.0
    band = np.minimum((p * 10).astype(int), 9)
    for b in range(round(low * 10), round(high * 10)):
        mask = band == b
        n = int(mask.sum())
        if n:
            total += n
            weighted += n * abs(float(y[mask].mean()) - float(p[mask].mean()))
    return None if total == 0 else weighted / total


def _columns(names) -> list[int]:
    return [features.FEATURES.index(n) for n in names]


def _tapped(rows, lot_ids: list):
    """Pass rows through, remembering the lot of each labelled one -- the only
    per-row fact `to_arrays` drops that a weighting needs."""
    for r in rows:
        if r.label is not None:
            lot_ids.append(r.lot_id)
        yield r


def _score_rows(conn, cold_dir, *, city, lots, origins, horizons, labels, spans):
    """Test rows at each origin from that origin's own history, with Blend's answer.

    Rows Blend cannot answer are dropped for everyone, so every forecaster is
    scored on the same set."""
    xs, ys, hs, hard_ids, blend = [], [], [], [], []
    for origin in origins:
        history = by_city(load_history(conn, cold_dir=cold_dir, before_ts=origin + 1)).get(city)
        if history is None:
            continue
        clim = Climatology(history)
        shipped = Blend(history)
        for r in iter_rows(history, clim, lots, origins=[origin], horizons=horizons,
                           labels=labels, spans=spans):
            if r.label is None:
                continue
            p = shipped.predict(r.lot_id, r.origin_ts + r.horizon_min * 60, r.horizon_min)
            if p is None:
                continue
            xs.append([np.nan if v is None else v for v in r.values])
            ys.append(r.label)
            hs.append(r.horizon_min)
            hard_ids.append(r.lot_id)
            blend.append(p)
    return (np.array(xs, dtype=np.float32).reshape(-1, len(features.FEATURES)),
            np.array(ys, dtype=np.int8), np.array(hs), hard_ids, np.array(blend))


def _summary(p, y, h, hard_mask, horizons) -> dict:
    return {
        "rows": len(y),
        "brier": _brier(p, y),
        "hard": _brier(p[hard_mask], y[hard_mask]),
        "by_horizon": {m: _brier(p[h == m], y[h == m]) for m in horizons},
        "gaps": [_gap(p, y, lo, hi) for lo, hi in GAP_BANDS],
    }


def fmt(value, width=9, places=4):
    return f"{'--':>{width}}" if value is None else f"{value:{width}.{places}f}"


def run(conn, cold_dir, *, city: str, lots=None, test_fraction: float, n_origins: int,
        every_minutes: int = 30, horizons=HORIZONS, num_rounds: int = train.NUM_ROUNDS,
        threads: int = 1, out=print) -> dict:
    """Fit every variant, score them and `Blend`, print the tables, return the numbers."""
    labels = load_labels(conn, cold_dir, city=city)
    if not labels:
        raise SystemExit(f"no observations for {city}")
    series = reading_series(labels)
    spans = spans_for(series)
    stamps = sorted(labels)
    cutoff = stamps[int(len(stamps) * (1 - test_fraction))]
    if lots is None:
        lots = list(train.latest_roster(Path(cold_dir) / "meta", before_ts=cutoff, city=city))
        if not lots:
            raise SystemExit(f"no dated roster at or before the cutoff for {city}")

    # Train origins stop a full horizon short of the cutoff, so no training
    # label falls inside the test period.
    train_origins = [t for t in sample_origins(labels) if t < cutoff - max(horizons) * 60]
    train_history = by_city(load_history(conn, cold_dir=cold_dir, before_ts=cutoff)).get(city)
    if train_history is None or not train_origins:
        raise SystemExit("nothing before the cutoff to train on")
    train_clim = Climatology(train_history)

    lot_ids: list[str] = []
    x_served, y_served = train.to_arrays(_tapped(iter_served_rows(
        train_history, train_clim, lots, origins=train_origins, horizons=horizons,
        labels=labels, reading_series=series, spans=spans), lot_ids))
    x_nightly, y_nightly = train.to_arrays(iter_rows(
        train_history, train_clim, lots, origins=train_origins, horizons=horizons,
        labels=labels, spans=spans))
    hard = hard_lots(conn, cold_dir, before_ts=cutoff, threshold=HARD_THRESHOLD)
    hard_train = np.fromiter((i in hard for i in lot_ids), dtype=bool, count=len(lot_ids))

    origins = choose_origins(labels, start_ts=cutoff, every_minutes=every_minutes, limit=n_origins)
    x_test, y_test, h_test, test_ids, p_blend = _score_rows(
        conn, cold_dir, city=city, lots=lots, origins=origins, horizons=horizons,
        labels=labels, spans=spans)
    if len(y_test) == 0:
        raise SystemExit("no test rows scored -- the test period has no paired labels")
    hard_test = np.fromiter((i in hard for i in test_ids), dtype=bool, count=len(test_ids))

    free_now = features.FEATURES.index("free_now")
    out(f"ParkCast model ablation -- {city}")
    out(f"  corpus   {taipei(stamps[0]):%Y-%m-%d %H:%M} -> {taipei(stamps[-1]):%Y-%m-%d %H:%M} Taipei")
    out(f"  train    {len(train_origins)} origins before {taipei(cutoff):%Y-%m-%d %H:%M}; "
        f"{len(y_served):,} labelled rows")
    out(f"           reading missing on {np.isnan(x_served[:, free_now]).mean():.1%} of served rows, "
        f"{np.isnan(x_nightly[:, free_now]).mean():.1%} of nightly rows")
    out(f"  test     {len(origins)} origins {taipei(origins[0]):%m-%d %H:%M} -> "
        f"{taipei(origins[-1]):%m-%d %H:%M}; {len(y_test):,} rows, base rate {y_test.mean():.3f}")
    out(f"  hard set {len(hard)} lots free <{HARD_THRESHOLD:.0%} of the time before the cutoff; "
        f"{int(hard_test.sum()):,} test rows, base rate "
        f"{(y_test[hard_test].mean() if hard_test.any() else float('nan')):.3f}")

    params = {**train.PARAMS, "num_threads": threads}
    results = {"blend": _summary(p_blend, y_test, h_test, hard_test, horizons)}
    for name, (names, rows, weighting) in _SPEC.items():
        cols = _columns(names)
        x, y = (x_nightly, y_nightly) if rows == "nightly" else (x_served, y_served)
        weight = None
        if weighting == "full":
            weight = np.where(y == 0, 3.0, 1.0)
        elif weighting == "hard":
            weight = np.where(hard_train, 3.0, 1.0)
        booster = train.fit(np.ascontiguousarray(x[:, cols]), y, params=params,
                            num_rounds=num_rounds, weight=weight, feature_names=names)
        p = booster.predict(np.ascontiguousarray(x_test[:, cols]))
        results[name] = _summary(p, y_test, h_test, hard_test, horizons)

    width = max(len(n) for n in results) + 2
    ref = results["blend"]
    out("")
    out(f"{'':{width}}{'Brier':>9}{'vs blend':>10}{'hard':>9}{'vs blend':>10}"
        f"{'|gap| 0-.2':>12}{'|gap| .2-.9':>13}")
    for name, r in results.items():
        # Skill against blend: the fraction of blend's error removed, so
        # positive is better and blend's own row has nothing to say.
        vs = (lambda mine, theirs: f"{'--':>10}") if name == "blend" else \
            (lambda mine, theirs: fmt(skill(mine, theirs), 10, 3))
        out(f"{name:{width}}{fmt(r['brier'])}{vs(r['brier'], ref['brier'])}"
            f"{fmt(r['hard'])}{vs(r['hard'], ref['hard'])}"
            f"{fmt(r['gaps'][0], 12)}{fmt(r['gaps'][1], 13)}")
    out("")
    out("BY HORIZON  (Brier)")
    out(f"{'':{width}}" + "".join(f"{f'{m} min':>9}" for m in horizons))
    for name, r in results.items():
        out(f"{name:{width}}" + "".join(fmt(r["by_horizon"][m]) for m in horizons))
    return results


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--city", default=ids.LEGACY_CITY)
    ap.add_argument("--cold", default=str(config.PARQUET_DIR))
    ap.add_argument("--test-fraction", type=float, default=0.20)
    ap.add_argument("--origins", type=int, default=200)
    ap.add_argument("--every-minutes", type=int, default=30)
    ap.add_argument("--threads", type=int, default=1,
                    help="LightGBM threads; 1 (the nightly's) is reproducible, more is faster")
    args = ap.parse_args(argv)

    conn = store.connect_empty()
    try:
        run(conn, Path(args.cold), city=args.city, test_fraction=args.test_fraction,
            n_origins=args.origins, every_minutes=args.every_minutes, threads=args.threads)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
