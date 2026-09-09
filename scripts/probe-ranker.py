"""Calibration probe for the client-side ranker.

`rank.ts` scores every car park with four constants -- the value of a minute,
the assumed length of a visit, the cost of arriving to find no space, and the
price charged to a lot whose fare did not parse. Its own module comment says
they are exported "so a reader can find them and argue with them". This is the
argument, run against the live artifacts.

It answers three questions the constants cannot answer on their own:

  1. What exchange rates do they actually imply? Only the *ratios* matter, and
     the interesting one is how much money, and how much walking, the ranker is
     willing to trade for a better chance of a space.
  2. How much does the forecast vary across the roster right now? A ranker
     dominated by price is the correct outcome when every candidate is equally
     available -- and a problem when they are not.
  3. Can a lot the model thinks is probably full still reach the top of a list?
     That is the failure the whole project exists to avoid, so it is worth
     searching for exhaustively rather than spot-checking.

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
        "MEDIAN_PRICE_FALLBACK": _const(rank, "MEDIAN_PRICE_FALLBACK"),
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

    def probability(self, lot: dict, column: int) -> float | None:
        row = lot["i"]
        if row >= self.n_lots:
            return None
        cell = self.body[row * self.n_horizons + column]
        return None if cell == UNKNOWN else cell / 100.0

    def walk_min(self, meters: float) -> int:
        return math.ceil(max(0.0, meters) / self.k["WALK_METERS_PER_MIN"])

    def fee(self, price: dict) -> float:
        """`priceOf`: a per-entry fare is charged once, an hourly one per visit."""
        if price.get("k") == "unknown" or "lo" not in price:
            return self.k["MEDIAN_PRICE_FALLBACK"] * self.k["EXPECTED_HOURS"]
        mid = (price["lo"] + price["hi"]) / 2
        return mid if price["k"] == "entry" else mid * self.k["EXPECTED_HOURS"]

    def rank(self, destination: tuple[float, float], column: int) -> list[dict]:
        scored = []
        for lot in self.lots:
            meters = haversine_m(destination, (lot["y"], lot["x"]), self.k["EARTH_RADIUS_M"])
            walk = self.walk_min(meters)
            fee = self.fee(lot["p"])
            p = self.probability(lot, column)
            certain = walk * self.k["TIME_VALUE"] + fee
            risk = None if p is None else (1 - p) * self.k["CIRCLING_PENALTY_MIN"] * self.k["TIME_VALUE"]
            scored.append({
                "lot": lot, "p": p, "meters": meters, "walk": walk, "fee": fee,
                "certain": certain, "cost": None if risk is None else certain + risk,
            })
        # Unknown-probability lots sort last, then by cost -- exactly as rank.ts does.
        scored.sort(key=lambda r: (r["cost"] is None, r["cost"] if r["cost"] is not None else r["certain"]))
        return scored


def report_exchange_rates(k: dict[str, float]) -> None:
    span = k["CIRCLING_PENALTY_MIN"] * k["TIME_VALUE"]
    print("EXCHANGE RATES implied by the shipped constants")
    print(f"  a certain space over a certainly-full one is worth NT${span:.0f}")
    print(f"    = {span / k['TIME_VALUE']:.0f} minutes of walking")
    print(f"    = NT${span / k['EXPECTED_HOURS']:.0f} per hour of parking price")
    print(f"    = {span / k['TIME_VALUE'] * k['WALK_METERS_PER_MIN']:.0f} metres on foot")
    print("  Only the ratios matter; scaling all four constants changes no ranking.\n")


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


def report_inversions(ranker: Ranker, column: int, top: int, gap: float) -> int:
    """Search every tight neighbourhood for a likely-full lot beating a reliable one.

    The destination is each low-probability lot's own position, which is the
    hardest case on purpose: it puts the risky lot at zero walking distance,
    where it has every advantage the model can give it.
    """
    starts = [l for l in ranker.lots
              if (p := ranker.probability(l, column)) is not None and p < LIKELY_FULL]
    print(f"INVERSION SEARCH -- {len(starts)} destinations (every lot under {LIKELY_FULL:.0%})")
    print(f"  looking for: a lot under {LIKELY_FULL:.0%} ranked above one at least "
          f"{gap:.0%} better, inside the top {top}")

    found = []
    for start in starts:
        rows = ranker.rank((start["y"], start["x"]), column)[:top]
        for i, row in enumerate(rows):
            if row["p"] is None or row["p"] >= LIKELY_FULL:
                continue
            better = [q for q in rows[i + 1:] if q["p"] is not None and q["p"] - row["p"] > gap]
            if better:
                found.append((i + 1, row, better[0]))

    print(f"  found: {len(found)}\n")
    for position, row, beaten in sorted(found, key=lambda f: -(f[2]["p"] - f[1]["p"]))[:8]:
        print(f"  #{position} {row['lot']['n'][:24]:24s} P={row['p']:>4.0%} "
              f"{row['meters']:>5.0f}m NT${row['fee']:>5.0f}  ranks above  "
              f"{beaten['lot']['n'][:24]:24s} P={beaten['p']:>4.0%} "
              f"{beaten['meters']:>5.0f}m NT${beaten['fee']:>5.0f}")
        _explain(row, beaten, ranker.k)
    return len(found)


def _explain(risky: dict, reliable: dict, k: dict[str, float]) -> None:
    """Why the model prefers the risky lot, and what it leaves out.

    `CIRCLING_PENALTY_MIN` is the time lost *circling*. It does not include
    getting to wherever you end up instead, so the model charges a failed
    attempt less than a failed attempt costs. Spelling both out is the point of
    this probe: the gap between them is the argument for changing the constant,
    and it is an argument only if it is quantified.
    """
    p = risky["p"]
    fallback = reliable["cost"]
    modelled = risky["cost"]
    # What trying the risky lot really costs: you pay its fee only if you get in,
    # and otherwise you pay the circling time AND the whole fallback trip.
    honest = p * (risky["walk"] * k["TIME_VALUE"] + risky["fee"]) + (1 - p) * (
        k["CIRCLING_PENALTY_MIN"] * k["TIME_VALUE"] + fallback
    )
    print(f"      model scores it {modelled:6.1f} vs the reliable option's {fallback:6.1f}")
    print(f"      but a failed attempt also has to reach that option: {honest:6.1f}"
          f"  ({'still better' if honest < fallback else 'worse — the model is under-charging failure'})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", default="data/artifacts",
                        help="directory holding grid.bin and lots.json")
    parser.add_argument("--column", type=int, default=2,
                        help="horizon column to read (default 2 = +15 min)")
    parser.add_argument("--top", type=int, default=10, help="list depth searched")
    parser.add_argument("--gap", type=float, default=0.40,
                        help="probability gap that counts as an inversion")
    args = parser.parse_args()

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
    found = report_inversions(ranker, args.column, args.top, args.gap)
    # Non-zero when the thing the project exists to prevent is reachable, so this
    # can be wired into a check later without rewriting it.
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
