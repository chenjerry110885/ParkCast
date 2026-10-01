# ParkCast — time-aware pricing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The Stage B todo is archived at `docs/superpowers/plans/2026-09-21-stage-b-archive.md`, with what its measurements concluded.

**Goal:** Show a driver the fare that applies at the arrival time they picked, and charge the ranker for the stay it actually assumes — instead of the midpoint of a range, which is a number no sign at the car park displays.

**Architecture:** `pricing.py` gains a tariff of `(scope, hour window, rate)` segments and a `rate_at`. `artifacts.py` publishes it as an optional `t` key, so a client that ignores it behaves exactly as today. `rank.ts` integrates the rate across `EXPECTED_HOURS` instead of taking a midpoint. The card shows the rate for the arrival time on screen.

**Tech Stack:** Python 3.13+ (stdlib), TypeScript/React. No new dependency.

**Spec:** [`docs/superpowers/specs/2026-10-01-time-aware-pricing-design.md`](../docs/superpowers/specs/2026-10-01-time-aware-pricing-design.md)

## Global Constraints

- **Never read or write anything under `data/`.** A live collector owns it. Tests use `tmp_path` and the committed `tests/fixtures/desc_sample.json`.
- **Never show a rate for a time no segment covers.** The range, labelled, instead. A midpoint is a fallback, never a display.
- **Never resolve a holiday scope.** No calendar, no claim. Weekday and weekend come from the date.
- **Precision over coverage.** Resolving 150 of 219 lots correctly beats resolving all 219 with a few confident errors: a driver shown NT$10 and charged NT$60 has been misled, where a range would merely have been vague.
- **`priceKnown` stays false whenever the fee came from the fallback**, so nothing downstream mistakes an assumption for a reading.
- **Additive artifact change.** `lo`/`hi` keep their meaning; `t` is omitted when absent. No coordinated release.
- **No `Co-Authored-By:` trailers and no AI attribution of any kind in commit messages** (CLAUDE.md).
- Python suite: `docker run --rm --user 0:0 -v "D:/Projects/ParkCast/src:/repo/src:ro" -v "D:/Projects/ParkCast/tests:/repo/tests:ro" -v "D:/Projects/ParkCast/scripts:/repo/scripts:ro" -v "D:/Projects/ParkCast/web/tests:/repo/web/tests:ro" -v "D:/Projects/ParkCast/pyproject.toml:/repo/pyproject.toml:ro" -w /repo -e PYTHONDONTWRITEBYTECODE=1 docker-collector:latest sh -c "pip install -q pytest 2>/dev/null; python -m pytest -q -p no:cacheprovider tests/"`
- Web suite: `npm test --prefix web`

## File structure

| file | responsibility |
|---|---|
| `src/parkcast/pricing.py` | modify: `Segment`, `Tariff`, scope-aware parsing, `rate_at` |
| `src/parkcast/artifacts.py` | modify: the optional `t` key in `_price_field` |
| `web/src/rank.ts` | modify: fee integrated across the stay, at the arrival time |
| `web/src/components/LotCard.tsx` | modify: the rate for the time on screen |
| `tests/test_pricing_schedule.py` | **new.** The parser, on real fixture strings. |
| `web/tests/rank-price.test.ts` | **new.** The fee across a rate boundary. |

---

### Task 1: The tariff, parsed from the shapes the feed actually uses

**Files:**
- Modify: `src/parkcast/pricing.py`
- Test: `tests/test_pricing_schedule.py` (new)

**Interfaces:**
- Produces: `Segment(scope, start_hour, end_hour, rate)`, `Tariff(segments)`, `Price.tariff: Tariff | None`, `parse_tariff(payex) -> Tariff | None`

The two shapes both occur, and a parser that handles one silently collapses the other:

```
50元/時(08-20)        rate then window
(10時~22時)50元/時     window then rate
```

Scope is **sticky across clauses**, which is the parsing insight this task turns on. In
`週一至週五50元/時(08-20)，10元/時(20-08)，週六、週日60元/時(10-20)，10元/時(20-10)` the second clause
has no marker of its own and is still a weekday rate; the fourth is a weekend one. A parser that
scoped only the clause carrying the marker would file half the corpus under `all` and resolve the
wrong rate at every hour.

- [ ] **Step 1: Write the failing tests, from real fixture strings**

```python
WEEKDAY_AND_WEEKEND = (
    "小型車：計時 週一至週五50元/時(08-20)，10元/時(20-08)，"
    "週六、週日、行政機關放假之紀念日與民俗日60元/時(10-20)，10元/時(20-10)，"
    "停車全程以半小時計；月租 全日4,800元，日間3,600元(07-19)。"
)


def test_a_bare_windowed_pair_becomes_two_segments():
    """`40元(08-22)、20元(22-08)` -- the one shape the old parser already saw."""
    tariff = pricing.parse_tariff("計時:40元(08-22)、20元(22-08)，全程半小時計。")

    assert tariff.segments == (
        pricing.Segment("all", 8, 22, 40),
        pricing.Segment("all", 22, 8, 20),
    )


def test_a_window_before_the_rate_parses_too():
    tariff = pricing.parse_tariff("計時 (10時~22時)50元/時，(22時~10時)10元/時。")

    assert {(s.start_hour, s.end_hour, s.rate) for s in tariff.segments} == {
        (10, 22, 50), (22, 10, 10)}


def test_scope_carries_to_the_clauses_after_it():
    """The parsing insight: `10元/時(20-08)` has no marker and is still a weekday
    rate, because the clause before it said 週一至週五."""
    segments = pricing.parse_tariff(WEEKDAY_AND_WEEKEND).segments

    assert pricing.Segment("weekday", 8, 20, 50) in segments
    assert pricing.Segment("weekday", 20, 8, 10) in segments
    assert pricing.Segment("weekend", 10, 20, 60) in segments
    assert pricing.Segment("weekend", 20, 10, 10) in segments


def test_the_monthly_rental_section_contributes_nothing():
    """`月租 日間3,600元(07-19)` is a window and a figure and not a tariff. `_TIMING`
    already cuts it; this proves the new parser inherits that rather than
    reaching past it."""
    segments = pricing.parse_tariff(WEEKDAY_AND_WEEKEND).segments

    assert all(s.rate in (10, 50, 60) for s in segments), segments


def test_a_24_hour_boundary_normalises_to_midnight():
    """`(10時~24時)` and `(24時~10時)` are real in the corpus. Hour 24 is hour 0,
    and a segment of 24->10 wraps like any other."""
    segments = pricing.parse_tariff("計時 (10時~24時)60元/時，(24時~10時)10元/時。").segments

    assert pricing.Segment("all", 10, 0, 60) in segments
    assert pricing.Segment("all", 0, 10, 10) in segments


def test_a_surcharge_is_not_a_segment():
    """`停放於充電格位之車輛，加收10元/時` is an extra levied on top, and
    `_drop_surcharges` already removes it."""
    segments = pricing.parse_tariff(
        "計時:40元(08-22)、20元(22-08)，停放於充電格位之車輛，加收10元/時。").segments

    assert all(s.rate in (20, 40) for s in segments)


def test_a_single_rate_needs_no_tariff():
    """73.4% of lots. A schedule for one rate would be noise in every artifact."""
    assert pricing.parse_tariff("小型車：計時 30元/時，全程以半小時計。") is None


def test_an_unreadable_fare_has_no_tariff():
    assert pricing.parse_tariff("詳見現場公告") is None


def test_two_overlapping_segments_of_the_same_scope_are_a_parse_failure():
    """Not a tie to break. Guessing which the sign means is the thing this
    feature exists to stop, so the lot keeps its range."""
    assert pricing.parse_tariff("計時 50元/時(08-20)，30元/時(10-18)。") is None
```

- [ ] **Step 2: Run them to verify they fail**

Expected: FAIL, `AttributeError: parse_tariff`.

- [ ] **Step 3: Implement**

Reuse `_TIMING`, `_drop_surcharges` and `_strip_non_car` unchanged — the new parser runs on the same
cleaned text `parse_fare` already builds, so monthly rentals, surcharges and motorcycle clauses are
excluded by the code that already excludes them, not by a second copy of that judgement.

Scan `_CLAUSE.split(...)` left to right, carrying the current scope. Recognise a scope marker
(`週一至週五`/`平日` → `weekday`; `週六`/`週日`/`假日`/`例假` → `weekend`; the holiday phrases add
`holiday` to whichever scope the clause already carries) and then both rate/window orders.

- [ ] **Step 4: Run them to verify they pass**

- [ ] **Step 5: Measure coverage against the whole fixture, and write the number down**

A script in the scratchpad over `tests/fixtures/desc_sample.json`: how many of the 219 `range` lots now
yield a tariff, how many yield none, and — the number that matters — **how many yield a tariff whose
segments disagree with the published `lo`/`hi`**. That last is the error class: a tariff that resolves
confidently to a rate outside the span the old parser read is a parser bug, not a win. Put all three in
the commit message.

- [ ] **Step 6: Commit**

---

### Task 2: Resolving a moment to a rate

**Files:**
- Modify: `src/parkcast/pricing.py`
- Test: `tests/test_pricing_schedule.py`

**Interfaces:**
- Consumes: `Tariff` from Task 1
- Produces: `rate_at(tariff, when: datetime) -> int | None`

- [ ] **Step 1: Write the failing tests**

```python
TARIFF = pricing.Tariff((
    pricing.Segment("weekday", 8, 20, 50),
    pricing.Segment("weekday", 20, 8, 10),
    pricing.Segment("weekend", 10, 20, 60),
))
TUESDAY_1400 = datetime(2026, 10, 6, 14, 0, tzinfo=config.TAIPEI_TZ)
TUESDAY_2300 = datetime(2026, 10, 6, 23, 0, tzinfo=config.TAIPEI_TZ)
SATURDAY_1400 = datetime(2026, 10, 3, 14, 0, tzinfo=config.TAIPEI_TZ)
SATURDAY_0900 = datetime(2026, 10, 3, 9, 0, tzinfo=config.TAIPEI_TZ)


def test_a_weekday_afternoon_takes_the_weekday_rate():
    assert pricing.rate_at(TARIFF, TUESDAY_1400) == 50


def test_a_segment_that_wraps_midnight_covers_both_sides_of_it():
    """`20-08` is one segment, and a rule assuming start < end would drop every
    overnight rate in the corpus."""
    assert pricing.rate_at(TARIFF, TUESDAY_2300) == 10
    assert pricing.rate_at(TARIFF, TUESDAY_1400.replace(hour=3)) == 10


def test_a_saturday_takes_the_weekend_rate_not_the_weekday_one():
    assert pricing.rate_at(TARIFF, SATURDAY_1400) == 60


def test_a_moment_no_segment_covers_has_no_rate():
    """Saturday 09:00 is outside the only weekend segment. None, never the
    weekday rate and never a midpoint -- an absence is not a number."""
    assert pricing.rate_at(TARIFF, SATURDAY_0900) is None


def test_a_more_specific_scope_wins_over_all():
    tariff = pricing.Tariff((pricing.Segment("all", 0, 24, 30),
                             pricing.Segment("weekend", 10, 20, 60)))

    assert pricing.rate_at(tariff, SATURDAY_1400) == 60
    assert pricing.rate_at(tariff, TUESDAY_1400) == 30


def test_a_holiday_only_segment_is_never_resolved():
    """No calendar, no claim. Any day might be a public holiday, so a moment
    whose only applicable segment is holiday-scoped reports nothing."""
    tariff = pricing.Tariff((pricing.Segment("holiday", 10, 20, 80),))

    assert pricing.rate_at(tariff, SATURDAY_1400) is None
    assert pricing.rate_at(tariff, TUESDAY_1400) is None


def test_a_lot_that_also_prices_holidays_still_resolves_an_ordinary_tuesday():
    """95 of the 219 price holidays as their own category. Refusing all of them
    would cost 43% of the feature to protect about ten days a year; what is
    refused is only the moment whose SOLE applicable segment is holiday-scoped.
    """
    tariff = pricing.Tariff((pricing.Segment("weekday", 8, 20, 50),
                             pricing.Segment("holiday", 8, 20, 80)))

    assert pricing.rate_at(tariff, TUESDAY_1400) == 50


def test_whether_a_tariff_prices_holidays_is_reportable():
    """The display needs it: a driver on Double Tenth Day should be told the
    rate shown is the ordinary one."""
    assert pricing.prices_holidays(pricing.Tariff(
        (pricing.Segment("holiday", 8, 20, 80),))) is True
    assert pricing.prices_holidays(TARIFF) is False
```

- [ ] **Steps 2–4: Run, implement, run**

- [ ] **Step 5: Commit**

---

### Task 3: Publishing the schedule

**Files:**
- Modify: `src/parkcast/artifacts.py` (`_price_field`)
- Test: `tests/test_artifacts.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_a_varying_fare_publishes_its_schedule():
    field = artifacts._price_field(pricing.parse_fare("計時:40元(08-22)、20元(22-08)。"))

    assert field["t"] == [["all", 8, 22, 40], ["all", 22, 8, 20]]
    assert field["lo"] == 20 and field["hi"] == 40, "the fallback stays authoritative"


def test_a_single_rate_publishes_no_schedule():
    """73.4% of the roster. A schedule saying one thing would grow every
    artifact to say nothing."""
    assert "t" not in artifacts._price_field(pricing.parse_fare("30元/時"))


def test_an_unparsed_schedule_publishes_no_key_so_the_client_can_tell():
    """Absence is how the client knows to fall back, rather than having to infer
    it from a schedule that does not cover the time."""
    assert "t" not in artifacts._price_field(pricing.parse_fare("詳見現場公告"))
```

- [ ] **Steps 2–4: Run, implement, run**

- [ ] **Step 5: Measure the artifact**

Build `lots.json` from the committed fixture before and after, and report both sizes plus the gzipped
delta in the commit message. The spec's gate: **under 20 KB added, and if it exceeds 50 KB the encoding
gets packed rather than the feature shipping fat.**

- [ ] **Step 6: Commit**

---

### Task 4: The fee the ranker charges

**Files:**
- Modify: `web/src/rank.ts`
- Test: `web/tests/rank-price.test.ts` (new)

**Interfaces:**
- Consumes: the `t` key from Task 3
- Produces: `rateAt(price, at) -> number | null`, and a `priceOf(price, arrivalMs)` that integrates

The display and the score answer different questions. The display says what it costs *here, now*; the
score says what the *stay* costs — and `EXPECTED_HOURS` is 2, so a stay from 21:00 crosses a 22:00
boundary. Charging two hours at the arrival rate would be as wrong as the midpoint, just differently.

- [ ] **Step 1: Write the failing tests**

```ts
const SCHEDULE: Price = { k: "range", lo: 10, hi: 50,
  t: [["all", 8, 22, 50], ["all", 22, 8, 10]] };

it("charges the rate at the arrival time when the stay stays inside one segment", () => {
  // 14:00 + 2h is wholly inside 08-22.
  expect(feeFor(SCHEDULE, at(14, 0))).toBeCloseTo(50 * 2);
});

it("integrates across a rate boundary inside the stay", () => {
  // 21:00 + 2h = one hour at 50, one at 10. The arrival rate alone would say
  // 100 and the midpoint would say 60; neither is what the driver pays.
  expect(feeFor(SCHEDULE, at(21, 0))).toBeCloseTo(50 + 10);
});

it("falls back to the midpoint when any part of the stay has no rate", () => {
  const partial: Price = { k: "range", lo: 10, hi: 50, t: [["all", 8, 10, 50]] };
  expect(feeFor(partial, at(9, 0))).toBeCloseTo(30 * 2);
});

it("reports a fallback fee as not known", () => {
  expect(priceOf({ k: "range", lo: 10, hi: 50 }, at(14, 0)).priceKnown).toBe(false);
});

it("leaves an entry fare alone", () => {
  // A per-visit charge enters the score once and has no hourly rate to resolve.
  expect(priceOf({ k: "entry", lo: 50, hi: 50 }, at(14, 0)).perEntry).toBe(50);
});

it("leaves a single-rate lot exactly as it was", () => {
  expect(feeFor({ k: "exact", lo: 30, hi: 30 }, at(3, 0))).toBeCloseTo(30 * 2);
});
```

- [ ] **Steps 2–4: Run, implement, run**

- [ ] **Step 5: Measure the ranking shift**

`python scripts/probe-ranker.py` before and after, and report the inversion count against the shipped
baseline in the commit message. Per `docs/superpowers/specs/2026-09-18-ranking-preferences-design.md`
§5, that count is **a photograph, not a constant** — report what it was on the day and do not tune
toward a number.

- [ ] **Step 6: Commit**

---

### Task 5: The rate on the card

**Files:**
- Modify: `web/src/components/LotCard.tsx`, `web/src/i18n.ts`
- Test: `web/tests/` alongside the existing card tests

- [ ] **Step 1: Write the failing tests**

- the price tile shows the rate for the arrival time on screen, and changes when the scrubber moves
- an unresolvable time keeps the range, with a note that the rate varies
- a lot that also prices public holidays carries that note, because a driver on a holiday should check
  the sign rather than trust the ordinary rate
- an `exact` lot renders byte-identically to today — 73.4% of the roster must not move

- [ ] **Steps 2–4: Run, implement, run**

- [ ] **Step 5: Verify in the browser**

Preview, scrub the arrival time across a boundary on a known varying lot, and screenshot both sides.

- [ ] **Step 6: Commit**

---

### Task 6: Release

- [ ] **Step 1: Full suites** — Python, web, worker, scripts.
- [ ] **Step 2:** `npm run deploy:check --prefix worker -- --with-python` from the repository root.
- [ ] **Step 3:** The user runs the release phase from a fresh PowerShell. The build stamp refuses a stale bundle, so a check that aborted cannot ship.
- [ ] **Step 4: Record it** in `docs/state-of-play.md`: the coverage number from Task 1 step 5, the artifact delta from Task 3, and the inversion count from Task 4.

---

## Not in this plan

- **Per-lot crossing rules** stated in prose (`跨越不同費率時段…以前一時段費率計算`). A second parsing problem; a straight integral is already far closer than a midpoint.
- **Exhibition and event pricing** (`展覽期間`): no date resolves it.
- **Daily caps and free grace periods** (`15分鐘內離場免收費`): real, on the signs, and a separate feature.
- **The other five cities' fare prose**, unsurveyed. Their behaviour is unchanged until measured.
- **The forecaster hybrid** — blend short, model long. Waiting on the replication of the 120-minute finding; see the Stage B archive.
