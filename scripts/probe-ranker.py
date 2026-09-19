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
  5. Does that answer survive the driver being allowed to choose? A preference
     moves what a minute on foot is worth, so it moves the ranking, so it could
     in principle move a car park the model believes is full to the top. That
     is the one thing it must not do, and asserting it would be worthless, so
     the sweep measures it -- every preset, over two samples: car parks as
     destinations, which is adversarial, and real places, which is common.

Nothing here changes the product. It reads `data/artifacts/` and
`web/public/places/`, and reports.

The constants are **parsed out of the TypeScript**, never copied: a probe that
carries its own copy of the numbers it is auditing will eventually audit the
wrong ones. If a constant is renamed this fails loudly instead of drifting --
which is exactly what happened when `TIME_VALUE` became `WALK_VALUE` and
`DELAY_VALUE`, and is why this file needed repairing rather than aliasing.

The preset pairs are parsed the same way, with one wrinkle: `PREFERENCES` in
rank.ts derives its three delay prices through a floor rule instead of writing
them down, so there is nothing to read. The probe therefore parses the rule's
whole shape as well as the walk prices, applies it, and refuses to run if the
shape changes -- see `FLOOR_RULE`.

    python scripts/probe-ranker.py
    python scripts/probe-ranker.py --artifacts web/public/artifacts
"""
import argparse
import json
import math
import random
import re
import statistics
import struct
import sys
from pathlib import Path
from typing import NamedTuple

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


def _rank_source() -> str:
    return (ROOT / "web/src/rank.ts").read_text(encoding="utf-8")


def load_constants() -> dict[str, float]:
    """The shipped constants, parsed.

    `WALK_VALUE` and `DELAY_VALUE` were one constant, `TIME_VALUE`, until the
    preference control needed to move the price of a walk without moving the
    price of a failed attempt. This function asked for `TIME_VALUE` by name and
    therefore stopped working the day it was split, which is the arrangement
    working as intended: an alias here would have kept the probe running while
    it scored a world that no longer exists.
    """
    rank = _rank_source()
    geo = (ROOT / "web/src/geo.ts").read_text(encoding="utf-8")
    return {
        "WALK_VALUE": _const(rank, "WALK_VALUE"),
        "DELAY_VALUE": _const(rank, "DELAY_VALUE"),
        "EXPECTED_HOURS": _const(rank, "EXPECTED_HOURS"),
        "CIRCLING_PENALTY_MIN": _const(rank, "CIRCLING_PENALTY_MIN"),
        "DRIVE_MIN_PER_KM": _const(rank, "DRIVE_MIN_PER_KM"),
        "MEDIAN_PRICE_FALLBACK": _const(rank, "MEDIAN_PRICE_FALLBACK"),
        "RELIABLE_P": _const(rank, "RELIABLE_P"),
        "WALK_METERS_PER_MIN": _const(geo, "WALK_METERS_PER_MIN"),
        "EARTH_RADIUS_M": _const(geo, "EARTH_RADIUS_M"),
    }


class Prices(NamedTuple):
    """The two numbers a preference moves: NT$ a minute, on foot and in delay."""

    walk: float
    delay: float


# `pricesFor` in rank.ts, as it must be written for the parse below to stand:
#
#     function pricesFor(walk: number): { walk: number; delay: number } {
#       return { walk, delay: Math.max(DELAY_VALUE, walk) };
#     }
#
# The three preset pairs are *derived* through it, so `max(5, walk)` appears in
# the source exactly once and the delay values are not literals anywhere. That
# is good for rank.ts and awkward here: the probe cannot read three pairs off
# the page, it has to read the rule and apply it. So it matches the rule's whole
# shape, and refuses to run if the shape changes -- a probe that quietly kept
# applying `max` to a rule that had become something else would be reporting a
# safety margin nobody had measured.
FLOOR_RULE = re.compile(
    r"function\s+pricesFor\s*\(\s*(?P<arg>\w+)\s*:[^)]*\)[^\n]*\{\s*"
    r"return\s*\{\s*(?P=arg)\s*,\s*delay\s*:\s*"
    r"Math\.max\(\s*(?P<floor>\w+)\s*,\s*(?P=arg)\s*\)\s*,?\s*\}\s*;?\s*\}"
)


def load_preferences() -> dict[str, Prices]:
    """`PREFERENCES` from rank.ts -- the walk prices parsed, the delays derived.

    Returned in source order, so the report reads down the control.
    """
    rank = _rank_source()

    rule = FLOOR_RULE.search(rank)
    if rule is None:
        raise SystemExit(
            "could not match `pricesFor(walk) => { walk, delay: Math.max(<floor>, walk) }` "
            "in rank.ts -- the floor rule changed shape, and this probe would otherwise "
            "keep measuring the old one. Read the new rule and teach it to `FLOOR_RULE`."
        )
    floor = _const(rank, rule.group("floor"))

    block = re.search(r"export const PREFERENCES[^=]*=\s*\{(.*?)\n\};", rank, re.S)
    if block is None:
        raise SystemExit("could not find `export const PREFERENCES = {...}` in rank.ts")
    body = block.group(1)

    entries = re.findall(r"(\w+)\s*:\s*pricesFor\(\s*([A-Za-z_]\w*|[0-9_.]+)\s*\)", body)
    keys = re.findall(r"^\s*(\w+)\s*:", body, re.M)
    if [name for name, _ in entries] != keys:
        raise SystemExit(
            f"PREFERENCES has entries that do not go through `pricesFor`: parsed "
            f"{[n for n, _ in entries]} out of {keys}. A preset built by hand would not "
            f"be held to the floor rule, and this probe must not pretend otherwise."
        )

    presets: dict[str, Prices] = {}
    for name, argument in entries:
        walk = float(argument.replace("_", "")) if argument[0].isdigit() else _const(rank, argument)
        presets[name] = Prices(walk, max(floor, walk))
    return presets


def load_default_preference() -> str:
    match = re.search(r'export const DEFAULT_PREFERENCE\s*:[^=]*=\s*"(\w+)"', _rank_source())
    if match is None:
        raise SystemExit("could not find `export const DEFAULT_PREFERENCE` in rank.ts")
    return match.group(1)


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
        # What a minute costs when nobody has asked for anything else. Every
        # method below takes `prices` and falls back to this, so the reports
        # that predate the preference control read the shipped pair unchanged.
        self.prices = Prices(k["WALK_VALUE"], k["DELAY_VALUE"])
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

    def fallback(self, scored: list[dict], delay: float) -> tuple[float, dict | None]:
        """`fallbackCost` from rank.ts: the cheapest reliable lot scored simply, and which lot."""
        penalty = self.k["CIRCLING_PENALTY_MIN"] * delay
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

    def score(self, destination: tuple[float, float], column: int,
              prices: Prices | None = None) -> tuple[list[dict], float]:
        """Everything about each lot that no model changes, and the fallback's cost.

        `drive_m` is the straight line from each lot to the fallback lot -- the
        drive a failure there forces. Zero for the fallback itself.

        `prices` is not free of the model: `certain` is priced at the walk rate
        and the fallback at the delay rate, exactly as `rankLots` does it, so a
        preference has to be chosen here rather than at sort time.
        """
        price = self.prices if prices is None else prices
        radius = self.k["EARTH_RADIUS_M"]
        scored = []
        for lot, p in zip(self.lots, self._probabilities(column)):
            meters = haversine_m(destination, (lot["y"], lot["x"]), radius)
            walk = self.walk_min(meters)
            fee = self.fee(lot["p"])
            scored.append({
                "lot": lot, "p": p, "meters": meters, "walk": walk, "fee": fee,
                "certain": walk * price.walk + fee,
            })
        cost, chosen = self.fallback(scored, price.delay)
        there = None if chosen is None else (chosen["lot"]["y"], chosen["lot"]["x"])
        for r in scored:
            r["drive_m"] = 0.0 if there is None else haversine_m(
                (r["lot"]["y"], r["lot"]["x"]), there, radius)
        return scored, cost

    def sort(self, scored: list[dict], fallback: float, model: str = "shipped",
             drive_min_per_km: float | None = None, prices: Prices | None = None) -> list[dict]:
        """One model's costs over `score`'s rows, sorted exactly as rank.ts sorts.

        `drive_min_per_km` overrides the shipped constant, for the sensitivity
        sweep only. `prices` must be whatever `score` was called with, or the
        two branches are priced under different preferences. Returns fresh row
        dicts, so models never see each other's.
        """
        if model not in MODELS:
            raise ValueError(f"unknown model {model!r}")
        k = self.k
        price = self.prices if prices is None else prices
        penalty = k["CIRCLING_PENALTY_MIN"] * price.delay
        rate = k["DRIVE_MIN_PER_KM"] if drive_min_per_km is None else drive_min_per_km
        per_km = rate * price.delay
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
             drive_min_per_km: float | None = None, prices: Prices | None = None) -> list[dict]:
        """The list for one destination under one of `MODELS`, at one pair of prices."""
        scored, fallback = self.score(destination, column, prices)
        return self.sort(scored, fallback, model, drive_min_per_km, prices)


def report_exchange_rates(k: dict[str, float]) -> None:
    span = k["CIRCLING_PENALTY_MIN"] * k["DELAY_VALUE"]
    per_km = k["DRIVE_MIN_PER_KM"] * k["DELAY_VALUE"]
    print("EXCHANGE RATES implied by the shipped constants")
    print("  A failed attempt costs the circling penalty, the drive to the fallback")
    print("  and the fallback's own cost, so the worth of a certain space is not a")
    print("  constant -- it depends on the neighbourhood. The floor is:")
    print(f"  circling alone = NT${span:.0f}  ({k['CIRCLING_PENALTY_MIN']:g} min at the "
          f"delay price, NT${k['DELAY_VALUE']:g}/min)")
    print(f"    = {span / k['WALK_VALUE']:.0f} minutes of walking (at NT${k['WALK_VALUE']:g}/min)")
    print(f"    = NT${span / k['EXPECTED_HOURS']:.0f} per hour of parking price")
    print(f"    = {span / k['WALK_VALUE'] * k['WALK_METERS_PER_MIN']:.0f} metres on foot")
    print(f"  plus the drive = NT${per_km:g} per straight-line km to the fallback lot")
    print(f"    = {k['DRIVE_MIN_PER_KM']:g} min/km, {60 / k['DRIVE_MIN_PER_KM']:.0f} km/h as the crow flies")
    print("  Only the ratios between them matter -- and the one a preference moves is")
    print("  the delay price against the walk price. See PREFERENCE SWEEP below.\n")


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


def risky_destinations(ranker: Ranker, column: int) -> list[tuple[float, float]]:
    """Every likely-full lot's own position -- the adversarial inversion sample.

    It is the hardest case on purpose: it puts the risky lot at zero walking
    distance, where it has every advantage the model can give it, and no
    preference can take that advantage away because no preference changes the
    price of a walk of zero.
    """
    return [(l["y"], l["x"]) for l in ranker.lots
            if (p := ranker.probability(l, column)) is not None and p < LIKELY_FULL]


def count_inversions(ranker: Ranker, column: int, top: int, gap: float, model: str,
                     destinations: list[tuple[float, float]] | None = None,
                     prices: Prices | None = None) -> list[tuple[int, dict, dict]]:
    """Every top-`top` ordering that puts a likely-full lot above a much better one.

    `destinations` defaults to `risky_destinations`, the sample the probe has
    always used. The preference sweep passes its own, including one drawn from
    real places rather than from car parks.
    """
    starts = risky_destinations(ranker, column) if destinations is None else destinations
    found = []
    for start in starts:
        rows = ranker.rank(start, column, model=model, prices=prices)[:top]
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


def reach_metrics(rows: list[dict], depth: int) -> dict | None:
    """The LIST REACH columns for one destination's list, or None if it has no forecast.

    One definition, used by the reach report and by the preference sweep, so the
    two can be read against each other without wondering whether "far" means the
    same thing in both.
    """
    head = [r for r in rows[:depth] if r["p"] is not None]
    if not head:
        return None
    far = [i for i, r in enumerate(head) if r["p"] < LIKELY_FULL and r["meters"] > FAR_M]
    return {
        "far": bool(far),
        "far5": any(i < 5 for i in far),
        "hopeless3": any(r["p"] < HOPELESS and r["meters"] > HOPELESS_M for r in head[:3]),
        "full1": head[0]["p"] < LIKELY_FULL,
        "reach": max(r["meters"] for r in head) / 1000,
        "first": head[0]["lot"]["id"],
    }


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
        (f"shipped, NT${k['DRIVE_MIN_PER_KM'] * k['DELAY_VALUE']:g}/km", "shipped", None),
    ]
    variants += [(f"what-if, NT${rate:g}/km", "shipped", rate / k["DELAY_VALUE"]) for rate in rates]
    tally = {name: {"far": 0, "far5": 0, "hopeless3": 0, "full1": 0, "moved1": 0, "reach": []}
             for name, _, _ in variants}

    for destination in ranker.lots:
        scored, fallback = ranker.score((destination["y"], destination["x"]), column)
        firsts = {}
        for name, model, rate in variants:
            m = reach_metrics(ranker.sort(scored, fallback, model, rate), depth)
            if m is None:
                continue
            t = tally[name]
            for column_name in ("far", "far5", "hopeless3", "full1"):
                t[column_name] += m[column_name]
            t["reach"].append(m["reach"])
            firsts[name] = m["first"]
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


# Where the realistic sample comes from, and what counts as a destination.
# Roads are not places anybody drives *to*, administrative labels are areas
# rather than points, and `parking` would put the sample back on car parks --
# which is the other sample's job. What is left is the stuff of actual trips:
# temples, parks, clinics, schools, hotels, stations, shops, offices.
PLACE_INDEX = "web/public/places/taipei.json"
PLACE_EXCLUDED = frozenset({
    "minor_road", "major_road", "highway",      # ways, not destinations
    "locality", "neighbourhood", "macrohood",   # areas, not points
    "parking",                                  # the adversarial sample's job
})
# A destination this close to a car park is that car park's own position under
# another name, and the adversarial sample already covers those.
PLACE_MIN_M = 50.0


def place_destinations(ranker: Ranker, path: Path, count: int, seed: int,
                       min_m: float = PLACE_MIN_M) -> list[tuple[float, float]]:
    """Real destinations, drawn from the offline place index the app ships.

    The inversion search has always used car parks as destinations, which is
    the adversarial case and not the common one. This is the common one: places
    people drive to, none of which is a car park and none of which is within
    `min_m` of one, so no lot starts the ranking at zero metres.

    Deterministic: the same seed draws the same sample every run, so two runs of
    this probe differ only where the roster or the forecast differs.
    """
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))["rows"]
    except OSError:
        return []
    candidates = [r for r in rows if len(r) > 4 and r[2] not in PLACE_EXCLUDED]
    random.Random(seed).shuffle(candidates)

    radius = ranker.k["EARTH_RADIUS_M"]
    lots = [(lot["y"], lot["x"]) for lot in ranker.lots]
    # A latitude gap alone already exceeding `min_m` settles a pair without a
    # haversine, which is most pairs: the sample is 50 m against a whole city.
    lat_guard = min_m / (math.pi / 180 * radius)

    kept: list[tuple[float, float]] = []
    for row in candidates:
        here = (row[3], row[4])
        near = [lot for lot in lots if abs(lot[0] - here[0]) < lat_guard]
        if any(haversine_m(here, lot, radius) < min_m for lot in near):
            continue
        kept.append(here)
        if len(kept) == count:
            break
    return kept


def sweep_preset(ranker: Ranker, column: int, top: int, gap: float, depth: int,
                 prices: Prices, inversion_destinations: list[tuple[float, float]],
                 reach_destinations: list[tuple[float, float]]) -> dict:
    """One preset over one sample: the inversion columns and the LIST REACH ones.

    The inversions come from `count_inversions` itself rather than from a copy
    of its rule, so "inversion" cannot come to mean one thing in the sweep and
    another in the search above it.
    """
    found = count_inversions(ranker, column, top, gap, "shipped",
                             inversion_destinations, prices)
    tally = {"far": 0, "far5": 0, "hopeless3": 0, "full1": 0, "reach": []}
    for destination in reach_destinations:
        m = reach_metrics(ranker.rank(destination, column, prices=prices), depth)
        if m is None:
            continue
        for name in ("far", "far5", "hopeless3", "full1"):
            tally[name] += m[name]
        tally["reach"].append(m["reach"])
    reach = tally["reach"]
    return {
        "inversions": len(found),
        "worst": min((f[0] for f in found), default=None),
        "at1": sum(1 for f in found if f[0] == 1),
        "far": tally["far"], "far5": tally["far5"],
        "hopeless3": tally["hopeless3"], "full1": tally["full1"],
        "median": statistics.median(reach) if reach else math.nan,
        "p90": (statistics.quantiles(reach, n=10, method="inclusive")[-1]
                if len(reach) > 1 else (reach[0] if reach else math.nan)),
    }


def report_preferences(ranker: Ranker, column: int, top: int, gap: float, depth: int,
                       places: list[tuple[float, float]]) -> int:
    """The invariant, measured: no preference may put an inversion at #1.

    Not "no preference may reorder past probability" -- that claim is stronger,
    and the inversion search above shows it is already false at the shipped
    constants, so an invariant built on it would protect nothing. Position is
    the line, for the reason the search already gives: a likely-full lot deep in
    a list is a trade-off the driver can see and reject; one at the top is the
    app recommending a car park it believes is full.

    Returns the number of (preset, sample) pairs that put one at #1 -- the gate.
    """
    presets = load_preferences()
    default = load_default_preference()
    lot_positions = [(lot["y"], lot["x"]) for lot in ranker.lots]
    risky = risky_destinations(ranker, column)

    samples: list[tuple[str, str, list, list]] = [
        ("adversarial", f"{len(risky)} lots under {LIKELY_FULL:.0%} at their own positions "
                        f"(0 m); reach over all {len(lot_positions)}", risky, lot_positions),
    ]
    if places:
        samples.append(("realistic", f"{len(places)} places from {PLACE_INDEX}, POIs only, "
                                     f"at least {PLACE_MIN_M:.0f} m from every lot", places, places))

    print("PREFERENCE SWEEP -- every preset, both samples")
    print(f"  walk and delay are NT$ a minute. The delay column is *derived*: the probe")
    print(f"  parses the walk prices and `pricesFor`'s floor rule out of rank.ts and")
    print(f"  applies it, because the three pairs are not literals in the source.")
    print(f"  inversions: the same rule the search above uses -- a lot under "
          f"{LIKELY_FULL:.0%} ranked")
    print(f"  above one at least {gap:.0%} better, inside the top {top}. "
          f"The other columns are LIST REACH's,")
    print(f"  over the top {depth}. `*` marks the default, which no driver has to choose.")
    if presets.get(default) == ranker.prices:
        print(f"  {default} is the shipped pair, so its adversarial row is the same measurement")
        print("  as the `shipped` lines above and must match them column for column. It is")
        print("  the sweep's own sanity check, and it is free -- read it rather than trust it.\n")
    else:
        print(f"  WARNING: {default} is {presets.get(default)}, not the shipped pair "
              f"{tuple(ranker.prices)}.")
        print("  The default is supposed to be what the app already did, so that a driver who")
        print("  never opens the control sees no change. It no longer is. Every figure below")
        print("  is still measured honestly; it is the promise in rank.ts that has moved.\n")

    at_one = 0
    for name, described, inversion_destinations, reach_destinations in samples:
        print(f"  {name} -- {described}")
        print(f"  {'preset':12s} {'walk':>4s} {'delay':>5s} {'inversions':>10s} {'worst':>5s} "
              f"{'at #1':>5s}   {'far@' + str(depth):>7s} {'far@5':>5s} {'hopeless3':>9s} "
              f"{'#1 under 50%':>12s}   {'median':>6s} {'p90':>6s}")
        for preset, prices in presets.items():
            r = sweep_preset(ranker, column, top, gap, depth, prices,
                             inversion_destinations, reach_destinations)
            at_one += r["at1"] > 0
            label = f"{preset}{' *' if preset == default else ''}"
            worst = "-" if r["worst"] is None else f"#{r['worst']}"
            print(f"  {label:12s} {prices.walk:4.0f} {prices.delay:5.0f} {r['inversions']:10d} "
                  f"{worst:>5s} {r['at1']:5d}   {r['far']:7d} {r['far5']:5d} {r['hopeless3']:9d} "
                  f"{r['full1']:12d}   {r['median']:6.2f} {r['p90']:6.2f}")
        print()

    if at_one:
        print(f"  FAILED: {at_one} preset/sample pair(s) put a likely-full lot at #1.")
        print("  The answer is to narrow the range of the presets, not to widen what")
        print("  counts as acceptable. See PREFERENCES in rank.ts.\n")
    else:
        print("  No preset puts an inversion at #1, in either sample. That is the whole")
        print("  claim: a preference changes what a walk and a fare are worth beside")
        print("  availability, and is not allowed to erode availability itself.\n")
    return at_one


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
    parser.add_argument("--places", default=PLACE_INDEX,
                        help="offline place index the realistic sample is drawn from")
    parser.add_argument("--places-n", type=int, default=700,
                        help="how many real destinations to draw (0 to skip the sample)")
    parser.add_argument("--places-seed", type=int, default=0,
                        help="which draw; the sample is deterministic given this")
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

    places: list[tuple[float, float]] = []
    if args.places_n > 0:
        index = (ROOT / args.places) if not Path(args.places).is_absolute() else Path(args.places)
        places = place_destinations(ranker, index, args.places_n, args.places_seed)
        if not places:
            print(f"no place index at {index} -- the realistic sample is skipped, and with")
            print("it the only evidence that lot-position sampling was not flattering us.\n")
    failures = report_preferences(ranker, args.column, args.top, args.gap, args.depth, places)
    # The gate is *first place*, not the raw count. Several of the orderings this
    # reports are genuine trade-offs -- a lot at 12% that is half the distance and
    # the same price is a reasonable bet, and tuning until the count reaches zero
    # would mean over-weighting probability to flatter a metric. What must never
    # happen is a car park the model believes is full being the app's own top
    # recommendation, so that is what fails the check. The reach report is not a
    # gate for the same reason: its counts are there to be read, not minimised.
    #
    # The sweep is gated on the same line, for every preset and both samples: a
    # preference that reached #1 would be the app recommending a car park it
    # believes is full because the driver said they would rather walk less.
    return 1 if worst == 1 or failures else 0


if __name__ == "__main__":
    sys.exit(main())
