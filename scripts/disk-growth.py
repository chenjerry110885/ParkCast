#!/usr/bin/env python
"""How fast the cold store is growing, and what that means for a month.

    python scripts/disk-growth.py
    python scripts/disk-growth.py --cold data/cold --hot data/hot.sqlite

Open since 2026-09-17: the nationwide spec estimated 150-400 MB/month for six
cities and the plan deliberately left it unmeasured. The corpus is the only
asset in this project that cannot be recreated -- a feed serves the present, so
a day not collected is gone for good -- which makes "does it fit" worth a script
rather than a one-off `du`, because the question returns every time a city is
added and the answers have to be comparable.

**The newest full day matters more than the mean.** Cities were switched on over
two weeks, so most of the corpus's life was spent smaller than it is now and the
mean understates today's rate. Both are printed; the projection uses the newest.

Takes its paths as arguments and reads nothing else. Nothing here writes.
"""
import argparse
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

DAYS_PER_MONTH = 30


@dataclass(frozen=True)
class Report:
    days: int
    total_bytes: int
    hot_bytes: int
    mean_bytes_per_day: float | None
    projected_bytes_per_month: float | None
    newest_day_bytes: int | None


def summarise(sizes: dict[date, int], *, hot_bytes: int) -> Report:
    """Turn per-day byte counts into the numbers the question needs.

    None rather than 0 for an empty corpus. `0 MB/month` is a claim -- that
    collecting costs nothing -- where None is the absence of one, which is what
    an empty cold store actually supports. The same distinction `brier([])`
    makes for the same reason.
    """
    if not sizes:
        return Report(0, 0, hot_bytes, None, None, None)
    total = sum(sizes.values())
    mean = total / len(sizes)
    return Report(
        days=len(sizes),
        total_bytes=total,
        hot_bytes=hot_bytes,
        mean_bytes_per_day=mean,
        projected_bytes_per_month=mean * DAYS_PER_MONTH,
        newest_day_bytes=sizes[max(sizes)],
    )


@dataclass(frozen=True)
class Entry:
    day: date
    component: str
    bytes: int


def scan(cold_dir: Path) -> tuple[list[Entry], int]:
    """Every dated file under the cold store, and the bytes of everything else.

    **Recursive, and that is the whole point.** The first version of this script
    globbed `*.parquet` at the top level only, which is what `forecast._read_cold`
    reads -- and missed `cold/meta/`, the dated JSON metadata snapshots that
    `__main__.build_capacities` writes and that `docs/state-of-play.md` measured
    at 2.17 MB a day, ~90% of the cold store. It reported 4.7 MB where the real
    figure was several times that, and concluded the corpus fitted comfortably.
    An undercount is the dangerous direction for this particular question.

    So nothing is silently dropped: a file whose stem is not an ISO date cannot
    be attributed to a day, but its bytes are still returned and still printed.
    A measurement that quietly omits what it does not recognise is how the first
    version got the answer wrong.
    """
    entries: list[Entry] = []
    unattributed = 0
    for path in sorted(cold_dir.rglob("*")):
        if not path.is_file():
            continue
        size = path.stat().st_size
        try:
            day = date.fromisoformat(path.stem)
        except ValueError:
            unattributed += size
            continue
        folder = path.parent.relative_to(cold_dir)
        entries.append(Entry(day, "observations" if folder == Path(".")
                             else folder.as_posix(), size))
    return entries, unattributed


def day_totals(entries: Iterable[Entry]) -> dict[date, int]:
    """Bytes per day, every component summed."""
    totals: dict[date, int] = {}
    for entry in entries:
        totals[entry.day] = totals.get(entry.day, 0) + entry.bytes
    return totals


def component_totals(entries: Iterable[Entry]) -> dict[str, int]:
    """Bytes per component, so a surprise is attributable to whatever wrote it."""
    totals: dict[str, int] = {}
    for entry in entries:
        totals[entry.component] = totals.get(entry.component, 0) + entry.bytes
    return totals


def mb(value: float | None) -> str:
    return f"{'--':>10}" if value is None else f"{value / 1_000_000:>7,.1f} MB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cold", default="data/cold")
    ap.add_argument("--hot", default="data/hot.sqlite")
    ap.add_argument("--estimate-low", type=float, default=150.0,
                    help="the nationwide spec's low estimate, MB/month")
    ap.add_argument("--estimate-high", type=float, default=400.0,
                    help="the nationwide spec's high estimate, MB/month")
    args = ap.parse_args()

    cold = Path(args.cold)
    if not cold.exists():
        raise SystemExit(f"no cold store at {cold}")
    hot = Path(args.hot)
    entries, unattributed = scan(cold)
    report = summarise(day_totals(entries),
                       hot_bytes=hot.stat().st_size if hot.exists() else 0)

    print(f"COLD STORE  {args.cold}")
    print(f"  dated days       {report.days:>10}")
    print(f"  total            {mb(report.total_bytes)}")
    for component, size in sorted(component_totals(entries).items()):
        print(f"    {component:<14} {mb(size)}")
    if unattributed:
        print(f"    {'(undated)':<14} {mb(unattributed)}   not attributable to a day")
    print(f"  mean day         {mb(report.mean_bytes_per_day)}")
    print(f"  newest full day  {mb(report.newest_day_bytes)}   <- today's rate")
    print(f"  hot store        {mb(report.hot_bytes)}   (bounded: a 48 h window)")

    if report.newest_day_bytes is None:
        print("\nnothing compacted yet, so there is no rate to project.")
        return 0

    at_current = report.newest_day_bytes * DAYS_PER_MONTH / 1_000_000
    print(f"\nprojected from the newest day: {at_current:,.1f} MB/month")
    print(f"the nationwide spec estimated  {args.estimate_low:,.0f}-{args.estimate_high:,.0f} MB/month")
    if at_current > args.estimate_high:
        print(f"  OVER the high estimate by {at_current - args.estimate_high:,.1f} MB/month")
    elif at_current < args.estimate_low:
        print(f"  under the low estimate by {args.estimate_low - at_current:,.1f} MB/month")
    else:
        print("  inside the estimate")
    print(f"\na year at this rate: {at_current * 12 / 1000:,.2f} GB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
