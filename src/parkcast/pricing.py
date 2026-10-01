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
from datetime import datetime

from parkcast import config

PLAUSIBLE_MIN = 5
PLAUSIBLE_MAX = 300

# Everything before the monthly/seasonal rental section.
_TIMING = re.compile(r"^(.*?)(?:月租|月票|季租|$)", re.S)

# A bracketed aside that merely names a non-car vehicle. `小型車(含大型重型機車)`
# is a car clause whose subject happens to include big bikes; the mention must
# not be read as the start of a clause about them.
_ASIDE = re.compile(r"[（(][^）)]*(?:機車|大型車|大客車)[^）)]*[）)]")

# Longest form first: `、大型重型機車` must match at 大, not at 機 four
# characters in, or the clause test sees `大型重` between the noun and the
# enumerator and reads a shared subject as a clause of its own.
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


# --- the schedule -----------------------------------------------------------
#
# `parse_fare` above answers "what does this lot charge?" with a number or a
# span. What follows answers "what does it charge at 19:00 on a Tuesday?", which
# the span cannot: ranking on a midpoint prices a 50/10 lot at 30, a number no
# sign at that car park displays.
#
# Measured on tests/fixtures/desc_sample.json: of the 219 lots `parse_fare`
# reports as `range`, 143 carry a rate with an explicit hour window and 137 a
# weekday or weekend marker. The module docstring's claim that the conditions
# are not exposed structurally describes the parser above, not the data.


#: How specific a segment's day scope is. A lot states its ordinary rate and then
#: its exception, so the exception wins where both could apply.
_SCOPE_RANK = {"all": 0, "weekday": 1, "weekend": 1, "holiday": 2}

#: `週一至週五`, `平日`, `非假日` -- the ordinary working week.
_WEEKDAY_MARK = re.compile(r"週一?[至~～-]?週?五|週一|周一|平日|非假日")
#: `週六`, `週日`, `假日`, `例假日` -- and `週六至週日`, which both halves match.
_WEEKEND_MARK = re.compile(r"週六|週日|周六|周日|週末|周末|假日|例假")
#: `行政機關放假之紀念日與民俗日` and its many spellings. Never resolvable: see
#: `rate_at`.
_HOLIDAY_MARK = re.compile(r"行政機關放假|紀念日|民俗")

_HOUR_PART = r"(\d{1,2})\s*(?:時|:\d{2})?"
_WINDOW = rf"[（(]\s*{_HOUR_PART}\s*[-~～至到]\s*{_HOUR_PART}\s*[）)]"
_RATE = r"(\d[\d,]*)\s*元(?:\s*/\s*(?:小)?時)?"
#: Both orders occur in the corpus, and a parser handling one collapses the
#: other into a range: `50元/時(08-20)` and `(10時~22時)50元/時`.
_RATE_THEN_WINDOW = re.compile(rf"{_RATE}\s*{_WINDOW}")
_WINDOW_THEN_RATE = re.compile(rf"{_WINDOW}\s*{_RATE}")


@dataclass(frozen=True, slots=True)
class Segment:
    """One rate, the hours it covers and the days it applies to.

    `end_hour` may be less than or equal to `start_hour`, meaning the segment
    wraps midnight. That is the normal case, not an edge one -- `22時~08時` is how
    the corpus writes an overnight rate, and a rule assuming `start < end` would
    drop every one of them.
    """
    scope: str        # "all" | "weekday" | "weekend" | "holiday"
    start_hour: int   # 0-23, inclusive
    end_hour: int     # 0-23, exclusive; <= start_hour means it wraps midnight
    rate: int         # NT$ per hour

    def covers(self, hour: int) -> bool:
        if self.start_hour < self.end_hour:
            return self.start_hour <= hour < self.end_hour
        # Wrapping, or a full day when the two are equal.
        if self.start_hour == self.end_hour:
            return True
        return hour >= self.start_hour or hour < self.end_hour


@dataclass(frozen=True, slots=True)
class Tariff:
    segments: tuple[Segment, ...]


def prices_holidays(tariff: Tariff | None) -> bool:
    """Whether any segment is holiday-scoped.

    The display needs this. 95 of the fixture's 219 varying lots price public
    holidays as their own category, and a driver on one of those days should be
    told the rate shown is the ordinary one rather than trust it.
    """
    return tariff is not None and any(s.scope == "holiday" for s in tariff.segments)


def _scope_of(clause: str, carried: str) -> str:
    """The day scope a clause states, or the one carried into it.

    Scope is **sticky**. In `週一至週五50元/時(08-20)，10元/時(20-08)` the second
    clause carries no marker and is still a weekday rate. A parser that scoped
    only the marked clause would file half the corpus under `all` and then
    resolve the wrong rate at every hour of the day.

    `週六、週日、行政機關放假之紀念日與民俗日60元/時(10-20)` is the corpus's
    standard phrasing for a weekend rate, and `_CLAUSE` splits it on the
    enumerating `、` -- so the rate lands in a clause naming only the holiday.
    That rate genuinely applies to Saturdays, which a date can settle, so a
    holiday marker **never overrides a weekend or weekday scope already carried
    into the clause**; it only sets the scope where nothing else has.

    That rule misattributes one shape: `週一至週五20元/時，行政機關放假之紀念日
    30元/時` would read the holiday clause as a weekday one. It is safe anyway,
    because the result is two weekday segments claiming the same hours at
    different rates -- which `_conflicts` rejects, so the lot falls back to its
    range rather than publishing a wrong number. A misattribution that becomes a
    fallback is the failure mode to aim for.
    """
    if _WEEKEND_MARK.search(clause):
        return "weekend"
    if _WEEKDAY_MARK.search(clause):
        return "weekday"
    if _HOLIDAY_MARK.search(clause):
        return carried if carried in ("weekday", "weekend") else "holiday"
    return carried


def _hour(raw: str) -> int | None:
    """`24` is midnight, and both `(10時~24時)` and `(24時~10時)` are real."""
    value = int(raw)
    return value % 24 if value <= 24 else None


def _segments_in(clause: str, scope: str) -> list[Segment]:
    found = []
    for pattern, order in ((_RATE_THEN_WINDOW, "rate"), (_WINDOW_THEN_RATE, "window")):
        for match in pattern.finditer(clause):
            rate_raw, start_raw, end_raw = (
                (match.group(1), match.group(2), match.group(3)) if order == "rate"
                else (match.group(3), match.group(1), match.group(2)))
            start, end = _hour(start_raw), _hour(end_raw)
            rate = _amount(rate_raw)
            if start is None or end is None:
                continue
            if not PLAUSIBLE_MIN <= rate <= PLAUSIBLE_MAX:
                # The same bound `_span` applies. A monthly figure that escaped
                # `_TIMING` must never become an hourly rate.
                continue
            found.append(Segment(scope, start, end, rate))
    return found


def _conflicts(segments: list[Segment]) -> bool:
    """Whether two segments of the same scope claim the same hour.

    Not a tie to break. Guessing which the sign means is precisely what this
    feature exists to stop, so a conflict makes the whole tariff unusable and
    the lot keeps the range `parse_fare` gave it.
    """
    for i, a in enumerate(segments):
        for b in segments[i + 1:]:
            if a.scope != b.scope:
                continue
            if any(a.covers(h) and b.covers(h) for h in range(24)):
                return True
    return False


def parse_tariff(payex: str | None) -> Tariff | None:
    """The lot's rate as a function of time, or None when there is no such thing.

    None for a single flat rate (73.4% of the roster -- a schedule saying one
    thing would be noise in every artifact), for a fare that cannot be read, and
    for one whose clauses conflict. In every case the caller falls back to
    `parse_fare`'s span, which is why absence is the signal rather than an empty
    schedule.

    Runs on the same cleaned text `parse_fare` builds, so monthly rentals,
    surcharges and non-car clauses are excluded by the code that already
    excludes them rather than by a second copy of that judgement.
    """
    if not payex:
        return None

    timing = _strip_non_car(_drop_surcharges(_TIMING.match(payex).group(1)))
    segments: list[Segment] = []
    scope = "all"
    for i, clause in enumerate(_CLAUSE.split(timing)):
        if i % 2:                       # a delimiter kept by the split
            continue
        if _CEILING.search(clause):     # 上限/最高/免費 -- not a tariff
            continue
        scope = _scope_of(clause, scope)
        segments.extend(_segments_in(clause, scope))

    unique = list(dict.fromkeys(segments))
    if len(unique) < 2 or _conflicts(unique):
        return None

    # A tariff must agree with the span `parse_fare` reported, because the client
    # uses `lo`/`hi` as its fallback and the two must never contradict each other
    # on the same lot.
    #
    # One fixture lot fails this and shows why it is a guard rather than an
    # assertion: `週一至週五50元/時(08-22)，…60元/時(08-22)，…每日(22-08)10元`
    # reports 50-60, because `_HOURLY` sees the two `元/時` rates and the bare
    # windowed `10元` is only a fallback that "never competes" with them. The
    # tariff here is arguably the better reading, but widening `parse_fare` to
    # agree would move the published range -- and the ranking -- for an unmeasured
    # number of lots. So the lot keeps its range, and costs 1 of 219.
    span = parse_fare(payex)
    if span.low is None or span.high is None or span.kind != "range":
        return None
    if any(not span.low <= s.rate <= span.high for s in unique):
        return None
    return Tariff(tuple(unique))


def rate_at(tariff: Tariff, when: datetime) -> int | None:
    """The hourly rate in force at `when`, or None when none can be claimed.

    None rather than a guess in three cases, and the third is a decision rather
    than a limitation:

    * No segment covers the hour. Saturday 09:00 at a lot whose only weekend
      segment is 10-20 has no stated rate, and the weekday rate is not it.
    * The tariff is unusable, which `parse_tariff` reports as None already.
    * **The only applicable segment is holiday-scoped.** Taipei car parks price
      `行政機關放假之紀念日與民俗日` differently from ordinary weekends. Saturday
      and Sunday are readable from the date; a public holiday is not, and this
      project has no holiday calendar and is not acquiring one for about ten days
      a year. So that moment reports nothing and the UI shows the range.

      Note what this does NOT refuse. A lot stating weekday, weekend AND holiday
      rates resolves perfectly well at 14:00 on an ordinary Tuesday -- the
      weekday segment applies and the date says it is a Tuesday. 95 of the
      fixture's 219 varying lots price holidays, so refusing all of them would
      cost 43% of the feature to protect about ten days a year.

    A naive `when` raises. Which hour applies depends entirely on the zone, and
    assuming Taipei would be right for this project's callers and silently wrong
    for any future one that passed UTC.
    """
    if when.tzinfo is None:
        raise ValueError("rate_at needs an aware datetime: the hour depends on the zone")

    local = when.astimezone(config.TAIPEI_TZ)
    wanted = "weekend" if local.weekday() >= 5 else "weekday"
    applicable = [s for s in tariff.segments
                  if s.covers(local.hour) and s.scope in (wanted, "all")]
    if not applicable:
        return None
    best = max(_SCOPE_RANK[s.scope] for s in applicable)
    return next(s.rate for s in applicable if _SCOPE_RANK[s.scope] == best)
