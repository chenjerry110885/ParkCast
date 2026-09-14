"""Calibration probe for the client-side ranker.

`rank.ts` scores every car park with a handful of constants -- the value of a
minute, the assumed length of a visit, the cost of arriving to find no space,
the cost of driving on to somewhere that has one, and the price charged to a lot
whose fare did not parse. Its own module comment says they live where "a reader
can find them and argue with them". This is the argument, run against the live
artifacts.

It answers four questions the constants cannot answer on their own:

  1. What exchange rates do they actually imply? Only the *ratios* matter, and
     the interesting one is how much money, and how much walking, the ranker is
     willing to trade for a better chance of a space.
  2. How much does the forecast vary across the roster right now? A ranker
     dominated by price is the correct outcome when every candidate is equally
     available -- and a problem when they are not.
  3. Can a lot the model thinks is probably full still reach the top of a list?
     That is the failure the whole project exists to avoid, so it is worth
     searching for exhaustively rather than spot-checking.
  4. How far out does the list reach for lots it thinks are probably full? The
     top of a list can be right while its tail recommends a car park at 2% six
     kilometres away, which is not a trade-off anybody makes. Found 2026-09-14,
     when the tail had gone unmeasured for five days.

Nothing here changes the product. It reads `data/artifacts/` and reports.

The constants are **parsed out of the TypeScript**, never copied: a probe that
carries its own copy of the numbers it is auditing will eventually audit the
wrong ones. If a constant is renamed this fails loudly instead of drifting.

    python scripts/probe-ranker.py
    python scripts/probe-ranker.py --artifacts web/public/artifacts
"""
import argparse
import json
import math
import re
import statistics
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HEADER_FORMAT = "<4sBIIHBBI"
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)
UNKNOWN = 255

# How the report reads a probability. Both ends are deliberately generous: a lot
# under 50% is one the model expects to be full more often than not, and 90% is
# where "reliable" starts for a driver who has to commit to a destination.
LIKELY_FULL = 0.50
RELIABLE = 0.90

# What makes a row in a list a mistake rather than a trade-off. "Far" is past a
# 19-minute walk; "hopeless" is under one chance in ten and further than anyone
# walks. A lot at 23% 1.6 km away is a bet a driver can take. One at 2% 6 km away
# is not, and neither belongs near the top of the list.
FAR_M = 1500
HOPELESS = 0.10
HOPELESS_M = 3000

# The scorings kept side by side, so a change to the model is argued about on
# one grid rather than on two runs an hour apart: the roster and the forecast
# both move through the day, and comparing across that credits a calibration
# change with whatever the clock did.
MODELS = {
    "legacy": "before 09-09: walk + fare + (1-p) x circling",
    "09-09": "09-09: expected cost, no drive",
    "shipped": "shipped: expected cost, with the drive",
}


def _const(source: str, name: str) -> float:
    """One `export const NAME = <number>` out of a TypeScript module."""
    match = re.search(rf"export const {name}\s*=\s*([0-9_.]+)", source)
    if match is None:
        raise SystemExit(
            f"could not find `export const {name}` -- it was renamed or moved, "
            f"and this probe would otherwise report stale numbers as current"
        )
    return float(match.group(1).replace("_", ""))


def load_constants() -> dict[str, float]:
    rank = (ROOT / "web/src/rank.ts").read_text(encoding="utf-8")
    geo = (ROOT / "web/src/geo.ts").read_text(encoding="utf-8")
    return {
        "TIME_VALUE": _const(rank, "TIME_VALUE"),
        "EXPECTED_HOURS": _const(rank, "EXPECTED_HOURS"),
        "CIRCLING_PENALTY_MIN": _const(rank, "CIRCLING_PENALTY_MIN"),
        "DRIVE_MIN_PER_KM": _const(rank, "DRIVE_MIN_PER_KM"),
        "MEDIAN_PRICE_FALLBACK": _const(rank, "MEDIAN_PRICE_FALLBACK"),
        "RELIABLE_P": _const(rank, "RELIABLE_P"),
        "WALK_METERS_PER_MIN": _const(geo, "WALK_METERS_PER_MIN"),
        "EARTH_RADIUS_M": _const(geo, "EARTH_RADIUS_M"),
    }


def haversine_m(a: tuple[float, float], b: tuple[float, float], radius: float) -> float:
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = lat2 - lat1
    dlon = math.radians(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))


class Ranker:
    """`rankLots` from `rank.ts`, faithfully -- including `Math.ceil` on the walk."""

    def __init__(self, doc: dict, grid: bytes, k: dict[str, float]):
        self.lots = doc["lots"]
        self.k = k
        header = struct.unpack(HEADER_FORMAT, grid[:HEADER_SIZE])
        if header[0] != b"PCG1":
            raise SystemExit("grid.bin does not start with the PCG1 magic")
        self.n_lots, self.n_horizons = header[4], header[5]
        self.body = grid[HEADER_SIZE:]
        self._columns: dict[int, list[float | None]] = {}

    def probability(self, lot: dict, column: int) -> float | None:
        row = lot["i"]
        if row >= self.n_lots:
            return None
        cell = self.body[row * self.n_horizons + column]
        return None if cell == UNKNOWN else cell / 100.0

    def _probabilities(self, column: int) -> list[float | None]:
        if column not in self._columns:
            self._columns[column] = [self.probability(lot, column) for lot in self.lots]
        return self._columns[column]

    def walk_min(self, meters: float) -> int:
        return math.ceil(max(0.0, meters) / self.k["WALK_METERS_PER_MIN"])

    def fee(self, price: dict) -> float:
        """`priceOf`: a per-entry fare is charged once, an hourly one per visit."""
        if price.get("k") == "unknown" or "lo" not in price:
            return self.k["MEDIAN_PRICE_FALLBACK"] * self.k["EXPECTED_HOURS"]
        mid = (price["lo"] + price["hi"]) / 2
        return mid if price["k"] == "entry" else mid * self.k["EXPECTED_HOURS"]

    def fallback(self, scored: list[dict]) -> tuple[float, dict | None]:
        """`fallbackCost` from rank.ts: the cheapest reliable lot scored simply, and which lot."""
        penalty = self.k["CIRCLING_PENALTY_MIN"] * self.k["TIME_VALUE"]
        reliable: tuple[float, dict | None] = (math.inf, None)
        any_forecast: tuple[float, dict | None] = (math.inf, None)
        for r in scored:
            if r["p"] is None:
                continue
            simple = r["certain"] + (1 - r["p"]) * penalty
            if simple < any_forecast[0]:
                any_forecast = (simple, r)
            if r["p"] >= self.k["RELIABLE_P"] and simple < reliable[0]:
                reliable = (simple, r)
        if reliable[1] is not None:
            return reliable
        if any_forecast[1] is not None:
            return any_forecast
        return 0.0, None

    def score(self, destination: tuple[float, float], column: int) -> tuple[list[dict], float]:
        """Everything about each lot that no model changes, and the fallback's cost.

        `drive_m` is the straight line from each lot to the fallback lot -- the
        drive a failure there forces. Zero for the fallback itself.
        """
        radius = self.k["EARTH_RADIUS_M"]
        scored = []
        for lot, p in zip(self.lots, self._probabilities(column)):
            meters = haversine_m(destination, (lot["y"], lot["x"]), radius)
            walk = self.walk_min(meters)
            fee = self.fee(lot["p"])
            scored.append({
                "lot": lot, "p": p, "meters": meters, "walk": walk, "fee": fee,
                "certain": walk * self.k["TIME_VALUE"] + fee,
            })
        cost, chosen = self.fallback(scored)
        there = None if chosen is None else (chosen["lot"]["y"], chosen["lot"]["x"])
        for r in scored:
            r["drive_m"] = 0.0 if there is None else haversine_m(
                (r["lot"]["y"], r["lot"]["x"]), there, radius)
        return scored, cost

    def sort(self, scored: list[dict], fallback: float, model: str = "shipped",
             drive_min_per_km: float | None = None) -> list[dict]:
        """One model's costs over `score`'s rows, sorted exactly as rank.ts sorts.

        `drive_min_per_km` overrides the shipped constant, for the sensitivity
        sweep only. Returns fresh row dicts, so models never see each other's.
        """
        if model not in MODELS:
            raise ValueError(f"unknown model {model!r}")
        k = self.k
        penalty = k["CIRCLING_PENALTY_MIN"] * k["TIME_VALUE"]
        rate = k["DRIVE_MIN_PER_KM"] if drive_min_per_km is None else drive_min_per_km
        per_km = rate * k["TIME_VALUE"]
        rows = []
        for r in scored:
            row = dict(r)
            if r["p"] is None:
                row["failure"] = row["cost"] = None
            elif model == "legacy":
                row["failure"] = r["certain"] + penalty
                row["cost"] = r["certain"] + (1 - r["p"]) * penalty
            else:
                drive = per_km * r["drive_m"] / 1000 if model == "shipped" else 0.0
                row["failure"] = penalty + drive + fallback
                row["cost"] = r["p"] * r["certain"] + (1 - r["p"]) * row["failure"]
            rows.append(row)
        # Unknown-probability lots sort last, then by cost -- exactly as rank.ts does.
        rows.sort(key=lambda r: (r["cost"] is None, r["cost"] if r["cost"] is not None else r["certain"]))
        return rows

    def rank(self, destination: tuple[float, float], column: int, model: str = "shipped",
             drive_min_per_km: float | None = None) -> list[dict]:
        """The list for one destination under one of `MODELS`."""
        scored, fallback = self.score(destination, column)
        return self.sort(scored, fallback, model, drive_min_per_km)


def report_exchange_rates(k: dict[str, float]) -> None:
    span = k["CIRCLING_PENALTY_MIN"] * k["TIME_VALUE"]
    per_km = k["DRIVE_MIN_PER_KM"] * k["TIME_VALUE"]
    print("EXCHANGE RATES implied by the shipped constants")
    print("  A failed attempt costs the circling penalty, the drive to the fallback")
    print("  and the fallback's own cost, so the worth of a certain space is not a")
    print("  constant -- it depends on the neighbourhood. The floor is:")
    print(f"  circling alone = NT${span:.0f}")
    print(f"    = {span / k['TIME_VALUE']:.0f} minutes of walking")
    print(f"    = NT${span / k['EXPECTED_HOURS']:.0f} per hour of parking price")
    print(f"    = {span / k['TIME_VALUE'] * k['WALK_METERS_PER_MIN']:.0f} metres on foot")
    print(f"  plus the drive = NT${per_km:g} per straight-line km to the fallback lot")
    print(f"    = {k['DRIVE_MIN_PER_KM']:g} min/km, {60 / k['DRIVE_MIN_PER_KM']:.0f} km/h as the crow flies")
    print("  Only the ratios between them matter.\n")


def report_spread(ranker: Ranker, column: int) -> None:
    values = [p for p in (ranker.probability(l, column) for l in ranker.lots) if p is not None]
    if not values:
        print("no usable forecasts in this grid\n")
        return
    buckets = {"<50%": 0, "50-89%": 0, ">=90%": 0}
    for v in values:
        buckets["<50%" if v < LIKELY_FULL else "50-89%" if v < RELIABLE else ">=90%"] += 1
    print(f"FORECAST SPREAD across {len(values)} lots")
    for label, n in buckets.items():
        print(f"  {label:8s} {n:5d}  ({n / len(values):5.1%})")
    print("  A price-dominated ranking is the right answer when this is one-sided,")
    print("  and the wrong one when it is not. That is why it is measured here.\n")


def count_inversions(ranker: Ranker, column: int, top: int, gap: float,
                     model: str) -> list[tuple[int, dict, dict]]:
    """Every top-`top` ordering that puts a likely-full lot above a much better one."""
    starts = [l for l in ranker.lots
              if (p := ranker.probability(l, column)) is not None and p < LIKELY_FULL]
    found = []
    for start in starts:
        rows = ranker.rank((start["y"], start["x"]), column, model=model)[:top]
        for i, row in enumerate(rows):
            if row["p"] is None or row["p"] >= LIKELY_FULL:
                continue
            better = [q for q in rows[i + 1:] if q["p"] is not None and q["p"] - row["p"] > gap]
            if better:
                found.append((i + 1, row, better[0]))
    return found


def report_inversions(ranker: Ranker, column: int, top: int, gap: float) -> int:
    """Search every tight neighbourhood for a likely-full lot beating a reliable one.

    The destination is each low-probability lot's own position, which is the
    hardest case on purpose: it puts the risky lot at zero walking distance,
    where it has every advantage the model can give it.
    """
    starts = sum(1 for l in ranker.lots
                 if (p := ranker.probability(l, column)) is not None and p < LIKELY_FULL)
    print(f"INVERSION SEARCH -- {starts} destinations (every lot under {LIKELY_FULL:.0%})")
    print(f"  looking for: a lot under {LIKELY_FULL:.0%} ranked above one at least "
          f"{gap:.0%} better, inside the top {top}")

    found = {model: count_inversions(ranker, column, top, gap, model) for model in MODELS}
    worst = {model: min((f[0] for f in rows), default=None) for model, rows in found.items()}
    for model, label in MODELS.items():
        reached = "-" if worst[model] is None else f"#{worst[model]}"
        print(f"  {label:46s} {len(found[model]):4d}  highest reaches {reached}")
    print("  Position is the number that matters. A likely-full lot deep in a list is")
    print("  a trade-off the driver can see and reject; one at the top is the app")
    print("  recommending a car park it believes is full.")
    print()

    shipped = found["shipped"]
    for position, row, beaten in sorted(shipped, key=lambda f: (f[0], -(f[2]["p"] - f[1]["p"])))[:6]:
        print(f"  #{position} {row['lot']['n'][:24]:24s} P={row['p']:>4.0%} "
              f"{row['meters']:>5.0f}m NT${row['fee']:>5.0f}  ranks above  "
              f"{beaten['lot']['n'][:24]:24s} P={beaten['p']:>4.0%} "
              f"{beaten['meters']:>5.0f}m NT${beaten['fee']:>5.0f}")
        _explain(row, beaten)
    print()
    return worst["shipped"] if worst["shipped"] is not None else 0


def _explain(risky: dict, likelier: dict) -> None:
    """The two branches of the score, so an inversion can be argued with."""
    p = risky["p"]
    print(f"      {p:.0%} x NT${risky['certain']:.1f} (park here) + {1 - p:.0%} x "
          f"NT${risky['failure']:.1f} (circle, drive {risky['drive_m'] / 1000:.1f} km, "
          f"fall back) = NT${risky['cost']:.1f}")
    print(f"      against the likelier lot: NT${likelier['cost']:.1f}")


def report_reach(ranker: Ranker, column: int, depth: int, rates: list[float]) -> None:
    """How far out the top of the list reaches for lots the model thinks are full.

    Every lot's own position serves as a destination, so the city is covered in
    proportion to where its car parks are. The inversion search asks whether a
    likely-full lot beats a better one; this asks whether a lot nobody would
    drive to is on the list at all, which is what a driver actually sees.

    The drive rate is swept as well as shipped. That is a sensitivity check, not
    a menu: the rate is a judgment (see `DRIVE_MIN_PER_KM`), and adopting
    whichever value scores best here would be tuning it to this report.
    """
    k = ranker.k
    baseline = "09-09, no drive"
    variants: list[tuple[str, str, float | None]] = [
        ("before 09-09", "legacy", None),
        (baseline, "09-09", None),
        (f"shipped, NT${k['DRIVE_MIN_PER_KM'] * k['TIME_VALUE']:g}/km", "shipped", None),
    ]
    variants += [(f"what-if, NT${rate:g}/km", "shipped", rate / k["TIME_VALUE"]) for rate in rates]
    tally = {name: {"far": 0, "far5": 0, "hopeless3": 0, "full1": 0, "moved1": 0, "reach": []}
             for name, _, _ in variants}

    for destination in ranker.lots:
        scored, fallback = ranker.score((destination["y"], destination["x"]), column)
        firsts = {}
        for name, model, rate in variants:
            rows = [r for r in ranker.sort(scored, fallback, model, rate)[:depth] if r["p"] is not None]
            if not rows:
                continue
            t = tally[name]
            far = [i for i, r in enumerate(rows) if r["p"] < LIKELY_FULL and r["meters"] > FAR_M]
            t["far"] += bool(far)
            t["far5"] += any(i < 5 for i in far)
            t["hopeless3"] += any(r["p"] < HOPELESS and r["meters"] > HOPELESS_M for r in rows[:3])
            t["full1"] += rows[0]["p"] < LIKELY_FULL
            t["reach"].append(max(r["meters"] for r in rows) / 1000)
            firsts[name] = rows[0]["lot"]["id"]
        for name, first in firsts.items():
            tally[name]["moved1"] += first != firsts.get(baseline)

    print(f"LIST REACH -- {len(ranker.lots)} destinations (every lot's own position), top {depth}")
    print(f"  far: under {LIKELY_FULL:.0%} and over {FAR_M / 1000:g} km away.  "
          f"hopeless: under {HOPELESS:.0%} and over {HOPELESS_M / 1000:g} km away.")
    print(f"  Each column counts destinations, not rows.\n")
    print(f"  {'':22s} {'far in':>7s} {'far in':>7s} {'hopeless':>9s} {'#1 under':>9s} "
          f"{'#1 not':>7s}   {'farthest row (km)':>17s}")
    print(f"  {'':22s} {'top ' + str(depth):>7s} {'top 5':>7s} {'in top 3':>9s} {'50%':>9s} "
          f"{'09-09s':>7s}   {'median':>8s} {'p90':>8s}")
    for name, _, _ in variants:
        t = tally[name]
        reach = t["reach"]
        median = statistics.median(reach) if reach else math.nan
        p90 = statistics.quantiles(reach, n=10, method="inclusive")[-1] if len(reach) > 1 else median
        print(f"  {name:22s} {t['far']:7d} {t['far5']:7d} {t['hopeless3']:9d} {t['full1']:9d} "
              f"{t['moved1']:7d}   {median:8.2f} {p90:8.2f}")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", default="data/artifacts",
                        help="directory holding grid.bin and lots.json")
    parser.add_argument("--column", type=int, default=2,
                        help="horizon column to read (default 2 = +15 min)")
    parser.add_argument("--top", type=int, default=10, help="list depth the inversion search reads")
    parser.add_argument("--gap", type=float, default=0.40,
                        help="probability gap that counts as an inversion")
    parser.add_argument("--depth", type=int, default=20,
                        help="list length the reach report reads (the app lists 20)")
    parser.add_argument("--rates", default="15,20",
                        help="what-if drive rates in NT$ per km, comma-separated; empty to skip")
    args = parser.parse_args()
    rates = [float(r) for r in args.rates.split(",") if r.strip()]

    base = (ROOT / args.artifacts) if not Path(args.artifacts).is_absolute() else Path(args.artifacts)
    try:
        doc = json.loads((base / "lots.json").read_text(encoding="utf-8"))
        grid = (base / "grid.bin").read_bytes()
    except OSError as err:
        raise SystemExit(f"could not read artifacts from {base}: {err}")

    k = load_constants()
    ranker = Ranker(doc, grid, k)
    print(f"ranker calibration probe -- {doc['n_lots']} lots, "
          f"column {args.column} (+{(args.column + 1) * 5} min)\n")
    report_exchange_rates(k)
    report_spread(ranker, args.column)
    worst = report_inversions(ranker, args.column, args.top, args.gap)
    report_reach(ranker, args.column, args.depth, rates)
    # The gate is *first place*, not the raw count. Several of the orderings this
    # reports are genuine trade-offs -- a lot at 12% that is half the distance and
    # the same price is a reasonable bet, and tuning until the count reaches zero
    # would mean over-weighting probability to flatter a metric. What must never
    # happen is a car park the model believes is full being the app's own top
    # recommendation, so that is what fails the check. The reach report is not a
    # gate for the same reason: its counts are there to be read, not minimised.
    return 1 if worst == 1 else 0


if __name__ == "__main__":
    sys.exit(main())
