"""Coverage and plausibility guards over the whole real fixture.

Unit tests pin individual strings; these pin the aggregate, so a regex change
that quietly stops matching a third of the city fails here rather than
shipping. This is exactly what Task 1b caught: the non-car strip was silently
discarding a valid rate for 133 lots, and no unit test noticed because each
one only exercises a single hand-picked string.

Thresholds below reflect Task 1b's raised coverage (measured on the committed
fixture: 87.61% priced / 12.39% unknown), not Task 1's original 81%.
"""
import json
from collections import Counter
from pathlib import Path

from parkcast.metadata import parse_metadata
from parkcast.pricing import PLAUSIBLE_MAX, PLAUSIBLE_MIN, parse_fare

FIXTURE = Path(__file__).parent / "fixtures" / "desc_sample.json"


def _prices():
    lots = parse_metadata(json.loads(FIXTURE.read_text(encoding="utf-8")))
    return [parse_fare(lot.fare_text) for lot in lots]


def test_most_lots_get_a_usable_price():
    prices = _prices()
    priced = [p for p in prices if p.kind != "unknown"]
    share = len(priced) / len(prices)
    assert share >= 0.85, f"only {share:.2%} of lots priced; measured 87.61% after task 1b"


def test_no_parsed_price_is_implausible():
    """A monthly rental read as an hourly rate would land in the thousands."""
    for p in _prices():
        if p.low is not None:
            assert PLAUSIBLE_MIN <= p.low <= PLAUSIBLE_MAX, p
            assert PLAUSIBLE_MIN <= p.high <= PLAUSIBLE_MAX, p


def test_ranges_are_ordered_and_exact_prices_are_degenerate():
    for p in _prices():
        if p.kind == "range":
            assert p.low < p.high
        elif p.kind in ("exact", "entry"):
            assert p.low == p.high


def test_the_mix_of_outcomes_is_stable():
    """Measured after task 1b: 73.5/12.3/1.8/12.4 exact/range/entry/unknown.
    These are the raised guards -- generous enough to absorb normal drift in
    the feed, tight enough to catch a regex regression that eats a chunk of
    the city (this is what task 1b's bug looked like before it was found)."""
    kinds = Counter(p.kind for p in _prices())
    total = sum(kinds.values())
    assert kinds["exact"] / total > 0.55
    assert kinds["unknown"] / total <= 0.15
