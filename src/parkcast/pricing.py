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
_CAR = re.compile(r"小型車|小客車")

# Sentence boundaries -- the widest a single stripped clause can reach.
_SENTENCE = re.compile(r"[；;。]")
# A colon introduces a fresh subject, so it opens a clause outright:
# `計次：機車20元/次` prices bikes however the sentence began.
_INTRODUCER = "：:"
# `，`, `,` and `、` enumerate both clauses and bare subjects, so they open a
# clause only once a rate has been quoted -- see `_opens_a_clause`.
_ENUMERATOR = "，,、"
_RATE = re.compile(r"\d[\d,]*\s*元")

_HOURLY = re.compile(r"(\d+)\s*元\s*/\s*(?:小)?時")
_ENTRY = re.compile(r"(\d+)\s*元\s*/\s*次")


@dataclass(frozen=True, slots=True)
class Price:
    kind: str            # "exact" | "range" | "entry" | "unknown"
    low: int | None      # NT$/hour, or NT$/entry when kind == "entry"
    high: int | None


UNKNOWN = Price("unknown", None, None)


def _opens_a_clause(sentence: str, at: int) -> bool:
    """Whether the word at `at` heads its own clause rather than sitting
    inside one.

    It does at the head of the sentence, after a colon, or after an enumerator
    that follows a rate already quoted. That last condition is the whole
    distinction between two readings of `、`:

        小型車、大型重型機車：計時40元/時   one rate, two subjects  -> keep
        小型車30元/時、機車10元/時          cars priced, then bikes -> strip

    In the first the car has not been priced yet, so the enumeration is still
    naming who the coming rate applies to; in the second it has, so what
    follows is a new clause with a new subject and a rate cars cannot get.
    """
    before = sentence[:at]
    head = before.rstrip()
    if not head:
        return True
    if head[-1] in _INTRODUCER:
        return True
    return head[-1] in _ENUMERATOR and bool(_RATE.search(before))


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


def _strip_non_car(text: str) -> str:
    """Drop the clauses that price something other than a car."""
    return "；".join(_strip_sentence(s)
                     for s in _SENTENCE.split(_ASIDE.sub("", text)))


def parse_fare(payex: str | None) -> Price:
    if not payex:
        return UNKNOWN

    timing = _strip_non_car(_TIMING.match(payex).group(1))

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
