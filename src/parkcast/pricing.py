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

# A bracketed aside that merely names a non-car vehicle. `小型車(含大型重型機車)`
# is a car clause whose subject happens to include big bikes; the mention must
# not be read as the start of a clause about them.
_ASIDE = re.compile(r"[（(][^）)]*(?:機車|大型車|大客車)[^）)]*[）)]")

# Longest form first: `、大型重型機車` must match at 大, not at 機 four
# characters in, or the separator test below looks at the wrong character.
_NON_CAR = re.compile(r"大型重型機車|大型重機|重型機車|大客車|大型車|機車")
# `汽車` is as common a way to say car as `小型車`, and ten fixture lots price
# in it -- five of which never write `小型車` at all. The feed names its large
# vehicles 大型車/大客車/大型重型機車, never `大型汽車`, so a bare `汽車` is
# always the small-vehicle subject here.
_CAR = re.compile(r"小型車|小客車|汽車")

# A surcharge is not a tariff. `加收`, `另收` and `加計` -- and `再加收`, which
# contains `加收` -- introduce an extra levied on top of the rate, most often
# for occupying a charging bay. `另計` is deliberately absent: `隔日另計` says
# the next day is counted separately, not that anything extra is charged.
_SURCHARGE = re.compile(r"加收|另收|加計")

# Clause delimiters, kept in the split so that blanking a clause leaves the
# surrounding structure -- and so the clause test -- undisturbed.
_CLAUSE = re.compile(r"([，,、；;。：:])")

# Sentence boundaries -- the widest a single stripped clause can reach.
_SENTENCE = re.compile(r"[；;。]")
# A colon introduces a fresh subject, so everything before it is out of reach:
# `計次：機車20元/次` prices bikes however the sentence began.
_INTRODUCER = "：:"
# What may stand between two vehicle nouns that share a single rate: `、`, `，`
# and `,` enumerate, and `及`/`與`/`和`/`暨`/`含`/`或` conjoin. Anything else --
# a rate, a floor, `惟`, `其中` -- ends the enumeration.
_CONJOINED = re.compile(r"^[、，,及與和暨含或\s]*$")

# The feed comma-groups every four-digit figure it prints, so a rate must be
# read as `\d[\d,]*` and not `\d+`: matching `1,200元/時` from the comma on
# yields 200, a number no guard downstream can tell from a real NT$200 rate.
_HOURLY = re.compile(r"(\d[\d,]*)\s*元\s*/\s*(?:小)?時")
_ENTRY = re.compile(r"(\d[\d,]*)\s*元\s*/\s*次")


# A bare figure carrying an explicit hour window -- `40元(08-22)` -- is a
# tariff; the window is what it is charged per. A bare figure *without* one
# stays unrecognised, because it is far too ambiguous to publish: a deposit, a
# daily cap, a per-entry fee and a penalty all take that shape.
_HOUR = r"\d{1,2}\s*(?:時|:\d{2})?"
_WINDOWED = re.compile(
    rf"(\d[\d,]*)\s*元\s*[（(]\s*{_HOUR}\s*[-~～至到]\s*{_HOUR}\s*[）)]")
# A ceiling is not a tariff, however it is qualified.
_CEILING = re.compile(r"上限|最高|免費|優惠|折扣")


def _amount(digits: str) -> int:
    return int(digits.replace(",", ""))


@dataclass(frozen=True, slots=True)
class Price:
    kind: str            # "exact" | "range" | "entry" | "unknown"
    low: int | None      # NT$/hour, or NT$/entry when kind == "entry"
    high: int | None     # equal to `low` for "exact"; a span otherwise


UNKNOWN = Price("unknown", None, None)


def _clause_start(sentence: str, at: int) -> int:
    """Where the clause containing `at` begins -- just past the nearest
    introducer, since a colon puts everything before it out of reach."""
    return max(sentence.rfind(c, 0, at) for c in _INTRODUCER) + 1


def _opens_a_clause(sentence: str, at: int) -> bool:
    """Whether the vehicle noun at `at` heads its own clause rather than
    standing as a second subject of one rate.

    It is a second subject exactly when a car noun stands before it in the
    same clause joined by nothing but enumerators and conjunctions:

        小型車、大型重型機車：計時40元/時   one rate, two subjects  -> keep
        小型車30元/時、機車10元/時          cars priced, then bikes -> strip
        小型車30元/時，惟機車10元/時        `惟` ends the enumeration -> strip
        24小時營業，機車10元/時             no car named at all     -> strip
        地下一樓機車20元/時                 no car named at all     -> strip

    Testing only the character immediately before the noun was too narrow:
    any intervening word (`惟`, `其中`, a floor, a rate) defeated the strip and
    let a motorcycle rate be published as the car price.
    """
    span = sentence[_clause_start(sentence, at):at]
    joined = None
    for m in _CAR.finditer(span):
        joined = span[m.end():]
    return joined is None or not _CONJOINED.match(joined)


def _first_clause(pattern: re.Pattern[str], sentence: str, start: int = 0) -> int | None:
    for m in pattern.finditer(sentence, start):
        if _opens_a_clause(sentence, m.start()):
            return m.start()
    return None


def _strip_sentence(sentence: str) -> str:
    """Drop the non-car clauses of one sentence.

    A non-car clause runs to the end of the sentence unless a car clause
    starts first -- `大型車200元/小時，小型車100元/時` prices both, and eating
    to the full stop would throw the car's rate away with the truck's.
    """
    cut = _first_clause(_NON_CAR, sentence)
    if cut is None:
        return sentence
    resume = _first_clause(_CAR, sentence, cut)
    if resume is None:
        return sentence[:cut]
    return sentence[:cut] + _strip_sentence(sentence[resume:])


def _drop_surcharges(text: str) -> str:
    """Blank the clauses that levy an extra on top of the tariff.

    TPE0007 writes its real tariff bare (`40元(08-22)`) while every one of its
    charging-bay surcharges carries `元/時`, so without this the surcharge is
    the only thing `_HOURLY` can see and a NT$40 lot is published at NT$10-20.
    No plausibility guard can catch that -- 10-20 is an ordinary hourly rate.
    """
    parts = _CLAUSE.split(text)
    return "".join("" if i % 2 == 0 and _SURCHARGE.search(part) else part
                   for i, part in enumerate(parts))


def _strip_non_car(text: str) -> str:
    """Drop the clauses that price something other than a car."""
    return "；".join(_strip_sentence(s)
                     for s in _SENTENCE.split(_ASIDE.sub("", text)))


def _windowed_rates(timing: str) -> list[int]:
    """Bare rates carrying an explicit hour window, ignoring clauses that quote
    a ceiling rather than a rate."""
    parts = _CLAUSE.split(timing)
    return [_amount(m)
            for i, part in enumerate(parts)
            if i % 2 == 0 and not _CEILING.search(part)
            for m in _WINDOWED.findall(part)]


def _span(values: list[int]) -> Price | None:
    """One rate is a fact; several mean the price varies under conditions this
    text does not expose, so report the span. None if nothing is plausible."""
    rates = sorted({v for v in values if PLAUSIBLE_MIN <= v <= PLAUSIBLE_MAX})
    if not rates:
        return None
    return Price("exact", rates[0], rates[0]) if len(rates) == 1 \
        else Price("range", rates[0], rates[-1])


def parse_fare(payex: str | None) -> Price:
    if not payex:
        return UNKNOWN

    timing = _strip_non_car(_drop_surcharges(_TIMING.match(payex).group(1)))

    hourly = _span([_amount(r) for r in _HOURLY.findall(timing)])
    if hourly:
        return hourly

    # Fallback only. A bare windowed rate is good evidence of a tariff, but a
    # quoted `元/時` is better evidence, so the two never compete.
    windowed = _span(_windowed_rates(timing))
    if windowed:
        return windowed

    # Per-entry fees tier by weekday/weekend exactly as hourly rates do, and
    # taking the first match would ship the weekday fee on a Sunday. Report
    # the span instead; the kind stays `entry` because the unit is not hours.
    fees = sorted({_amount(f) for f in _ENTRY.findall(timing)})
    fees = [f for f in fees if PLAUSIBLE_MIN <= f <= PLAUSIBLE_MAX]
    if fees:
        return Price("entry", fees[0], fees[-1])

    return UNKNOWN
