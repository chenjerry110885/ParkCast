# Time-aware pricing

**Status:** proposed 2026-10-01
**Supersedes a claim in:** `src/parkcast/pricing.py`'s module docstring — see §1

## 0. What this is

The fare a car park charges often depends on the hour and the day. The app currently collapses that
into a range and ranks on the range's **midpoint**, so for a lot charging NT$50/hr by day and NT$10/hr
overnight it both displays and *computes with* NT$30 — a number no sign at that car park ever shows.

This spec makes the price a function of time: displayed for the arrival time the driver has chosen,
and charged across the stay the ranker assumes.

It is **not** a change to the forecast, the ranker's structure, or the preference presets. The money
term in `rank.ts` keeps its place in the formula; only the number flowing into it becomes accurate.

## 1. Why — and a claim this corrects

`pricing.py` says today:

> Where the rate genuinely varies — by weekday, by hour, by exhibition period — the text does not
> expose the conditions structurally, so no single rate can be recovered honestly.

**Measured 2026-10-01 against the committed 1,751-lot fixture, that describes the parser, not the
data.** The conditions are exposed, and in a regular shape:

```
週一~週五(10時~22時)50元/時，(22時~10時)10元/時，週六、週日…(10時~24時)60元/時，(24時~10時)10元/時
40元(08-22)、20元(22-08)
30元/時(02時~19時)，40元/時(19時~02時)
```

Weekday scope, hour window, rate. The existing parser only recognises the bare `40元(08-22)` form and
collapses everything else into a span.

What the fixture actually holds:

| kind today | lots | share | what this spec does |
|---|---|---|---|
| `exact` | 1,285 | 73.4% | nothing — one rate is already correct at every hour |
| `range` | 219 | **12.5%** | the work: resolve to a rate per time where the text allows |
| `unknown` | 216 | 12.3% | nothing — unreadable stays unreadable |
| `entry` | 31 | 1.8% | nothing — a per-visit charge has no hourly rate to resolve |

So this touches **one lot in eight**, and for those the current number can be wrong by a factor of
three. What the 219 carry, counted rather than estimated:

| | lots | share of the 219 |
|---|---|---|
| a rate with an explicit hour window — resolvable by hour | 143 | 65.3% |
| a weekday / weekend marker | 137 | 62.6% |
| both | 64 | 29.2% |
| **a public-holiday category** | **95** | **43.4%** |
| neither marker — must stay a range | 3 | 1.4% |

### The holiday share is large enough to shape the design

**95 of the 219 price public holidays as their own category.** That is not a corner: it is 43% of the
lots this spec touches, so how §3 treats them decides how much of the benefit survives.

The resolution is the one taken on 2026-10-01, and it is narrower than "these lots cannot be
resolved". A lot stating weekday, weekend *and* holiday rates resolves perfectly well at 14:00 on an
ordinary Tuesday — the weekday segment applies, and the date says it is a Tuesday. What cannot be
known is whether *that particular* Tuesday is a public holiday.

So: resolve by weekday and weekend from the date, and where the lot has a holiday category at all,
**carry that fact to the display** so a driver on Double Tenth Day knows to check the sign. Only a
moment whose applicable segment is holiday-scoped and nothing else reports no rate.

The strict alternative — refusing to resolve any day for a lot that mentions holidays, because any day
might be one — would be defensible and would throw away 43% of the feature for about ten days a year.
Not taken, and recorded here so the choice is visible rather than implicit.

## 2. The tariff model

```python
@dataclass(frozen=True, slots=True)
class Segment:
    scope: str        # "all" | "weekday" | "weekend" | "holiday"
    start_hour: int   # 0-23, inclusive
    end_hour: int     # 0-24, exclusive; may be <= start_hour, meaning it wraps midnight
    rate: int         # NT$ per hour

@dataclass(frozen=True, slots=True)
class Tariff:
    segments: tuple[Segment, ...]
```

`Price` keeps `kind`/`low`/`high` exactly as it is and gains an optional `tariff`. Every existing
consumer keeps working unchanged; `low`/`high` remain the honest fallback and the thing displayed when
a time cannot be resolved.

**Wrapping is the normal case, not an edge one.** `22時~08時` is one segment, and a rule that assumed
`start < end` would silently drop every overnight rate in the corpus.

**Overlap resolves to the most specific scope**, `holiday` → `weekend`/`weekday` → `all`, because the
texts are written that way: a lot states its weekday rate and then its weekend exception. Two segments
of the same scope that overlap are a parse failure, not a tie to break — the lot falls back to a range,
because guessing which the sign means is exactly what this spec exists to stop.

## 3. Resolving a rate

```python
def rate_at(tariff: Tariff, when: datetime) -> int | None
```

`None` where no segment covers the moment, and — the decision taken 2026-10-01 — **`None` when the
only segment that could apply is holiday-scoped.** Not for every lot that mentions a holiday: see §1,
where 95 of the 219 do, and where refusing all of them would cost 43% of the feature to protect about
ten days a year.

Taipei car parks price `行政機關放假之紀念日與民俗日` differently from ordinary weekends. Saturday and
Sunday are readable from the date; a public holiday is not, and this project has no holiday calendar
and is not acquiring one for roughly ten days a year. So a lot whose rate at that moment would depend
on a holiday scope reports no rate, and the UI shows its range and says it varies on holidays.

The alternative — treating public holidays as weekends — is wrong on about ten days a year, and wrong
in the expensive direction, since holiday rates are the higher ones. It would understate the price on
precisely the days most people drive.

## 4. What is published

`artifacts._price_field` gains `t` beside the existing keys, and **only when a tariff was parsed**:

```json
"p": {"k": "range", "lo": 10, "hi": 50,
      "t": [["weekday", 8, 20, 50], ["weekday", 20, 8, 10],
            ["weekend", 10, 20, 60], ["weekend", 20, 10, 10]]}
```

- Omitted for the 73.4% `exact` lots: a single rate needs no schedule, and emitting one would grow
  every artifact to say nothing.
- Omitted when parsing failed, which is how the client knows to fall back rather than having to infer it.
- `lo`/`hi` stay, and stay authoritative for the fallback. A client that ignores `t` behaves exactly as
  today, so this is additive and needs no coordinated release.

**Size is a gate, not an afterthought.** At ~220 lots × ~4 segments × 4 short values this should add
well under 20 KB to `lots.json`. The plan measures it before and after; if it exceeds 50 KB the
encoding gets packed rather than the feature getting shipped fat.

## 5. The ranker

Two different questions, and conflating them is the mistake to avoid.

**The display answers "what does it cost here, now?"** — the rate at the arrival time, which is what
the sign at the entrance says.

**The score answers "what will this stay cost me?"** — and `EXPECTED_HOURS` is 2, so a stay beginning
at 21:00 crosses a 22:00 boundary. Charging it at the arrival rate for two hours would be as wrong as
the midpoint is now, just differently. So the money term integrates the rate across the expected stay:

```
fee = Σ over each covered interval of (hours in it × that interval's rate)
```

Some lots even state their own crossing rule — `停放時間若跨越不同費率時段，則該跨越時段之費率以前一時段費率標準計算`
— which this spec deliberately does **not** implement. Reading per-lot crossing rules out of prose is
a second parsing problem, and a straight integral is already far closer than a midpoint.

Where `rate_at` returns `None` for any part of the stay, the fee falls back to the midpoint exactly as
today, and `priceKnown` stays false. **No invented hour.**

**This changes rankings**, for about one lot in eight, which is the point and also the risk.
`scripts/probe-ranker.py` already exists to measure inversions against the shipped baseline, and the
plan runs it before and after and reports the count — the lesson from
`docs/superpowers/specs/2026-09-18-ranking-preferences-design.md` §5 being that such counts are a
photograph, not a constant.

## 6. The display

The card's price tile shows the rate for the arrival time already on screen, so it moves with the
time scrubber — which is the whole point of the request.

- A resolved rate reads as the hourly rate it is, with the time it applies to made explicit, so a
  driver who scrubs from 21:00 to 23:00 and sees the number drop understands why.
- An unresolved time keeps today's range display, with a short note that the rate varies — "varies on
  holidays" where that is the reason, because a driver who can see *why* a number is missing can act
  on it, and this project does not render an absence as a number.
- `exact` lots are unchanged in every respect, which is 73.4% of the roster.

## 7. Honesty rules, restated because this is a money claim

- **Never show a rate for a time no segment covers.** The range, labelled, instead.
- **Never resolve a holiday scope.** No calendar, no claim.
- **A midpoint is a fallback, never a display.** Today the app shows a number no sign shows; after
  this, an unresolvable lot shows a range, which is true.
- `priceKnown` stays false whenever the fee came from the fallback, so nothing downstream can mistake
  an assumption for a reading.
- The `entry` kind is untouched: a per-visit charge has no hourly rate, and inventing one would push
  all 31 such lots wrongly through every ranking.

## 8. Out of scope

- Per-lot crossing rules stated in prose (§5).
- Exhibition-period and event pricing (`展覽期間`): a condition no date can resolve.
- Monthly and seasonal rentals, already excluded by `_TIMING`.
- Motorcycle and large-vehicle tariffs, already excluded by `_strip_non_car`.
- Daily caps and free-entry grace periods (`15分鐘內離場免收費`) — real, visible on the signs, and a
  separate feature.
- Any change to the forecast or to the preference presets.

## 9. Risks

- **A wrong rate is worse than a range.** A driver who is charged NT$60 after being shown NT$10 has
  been actively misled, where a range would merely have been vague. This is why overlapping same-scope
  segments fall back rather than resolve, and why the parser's tests matter more than its coverage.
- **Parser coverage is not the goal; precision is.** It is better to resolve 150 of the 219 correctly
  and leave 69 as ranges than to resolve all 219 with a few confident errors.
- **The ranking shift is user-visible** and lands on the lots most sensitive to price. Measured with
  `probe-ranker.py`, not assumed.
- **The corpus is Taipei's fare prose.** The other five cities' fare fields are not surveyed here, so
  nothing in this spec should be assumed to parse them; `exact`/`range`/`unknown` behaviour is
  unchanged for them until measured.
