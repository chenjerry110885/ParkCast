"""Parse the feed's free-text Chinese fare field into a numeric price.

The feed gives one prose string per lot covering hourly rates, per-entry rates,
monthly rentals and vehicle classes at once. Only the car hourly rate is wanted,
and the two neighbouring figures are dangerous in opposite directions: monthly
rentals run to thousands of NT$, motorcycle rates to about a fifth of a car's.

Where the rate genuinely varies -- by weekday, by hour, by exhibition period --
the text does not expose the conditions structurally, so no single rate can be
recovered honestly. Those lots get a range. Anything that cannot be read at all
is `unknown`, which is a real answer and must never be filled in with a default.
"""
import re
from dataclasses import dataclass

PLAUSIBLE_MIN = 5
PLAUSIBLE_MAX = 300

# Everything before the monthly/seasonal rental section.
_TIMING = re.compile(r"^(.*?)(?:月租|月票|季租|$)", re.S)
# Clauses about anything that is not a car, up to the next clause separator.
_NON_CAR = re.compile(r"[；;，,。]?\s*(?:機車|大型車|大客車|重型機車)[^；;。]*")
_HOURLY = re.compile(r"(\d+)\s*元\s*/\s*(?:小)?時")
_ENTRY = re.compile(r"(\d+)\s*元\s*/\s*次")


@dataclass(frozen=True, slots=True)
class Price:
    kind: str            # "exact" | "range" | "entry" | "unknown"
    low: int | None      # NT$/hour, or NT$/entry when kind == "entry"
    high: int | None


UNKNOWN = Price("unknown", None, None)


def parse_fare(payex: str | None) -> Price:
    if not payex:
        return UNKNOWN

    timing = _NON_CAR.sub("", _TIMING.match(payex).group(1))

    rates = sorted({int(r) for r in _HOURLY.findall(timing)})
    rates = [r for r in rates if PLAUSIBLE_MIN <= r <= PLAUSIBLE_MAX]
    if rates:
        # A single rate is a fact; several mean the price varies under
        # conditions this text does not expose, so report the span.
        return Price("exact", rates[0], rates[0]) if len(rates) == 1 \
            else Price("range", rates[0], rates[-1])

    entry = _ENTRY.search(timing)
    if entry:
        fee = int(entry.group(1))
        if PLAUSIBLE_MIN <= fee <= PLAUSIBLE_MAX:
            return Price("entry", fee, fee)

    return UNKNOWN
