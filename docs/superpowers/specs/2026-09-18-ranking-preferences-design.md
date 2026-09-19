# Ranking preferences — cheaper, balanced, closer

**Status:** proposed, 2026-09-18
**Follows:** the ranker as it stands after `2026-09-09` (expected cost) and `2026-09-14` (the drive to the fallback)
**Precedes:** Stage B, the trained model — and deliberately does not depend on it

## 1. Goal

> "Some people doesn't care about cost then distance is prioritized, something similar to this."

A driver on an expense account and a driver paying their own NT$40 want different car parks from
the same street corner. Today the app has one opinion, held on everyone's behalf, in a constant.

This spec lets the driver choose between **cheaper**, **balanced** and **closer**, and does it
without inventing a weighting scheme — because the dial already exists and is already calibrated.

## 2. What the ranker computes today

```
cost = p       × (walkMin × TIME_VALUE + fee)
     + (1 − p) × (CIRCLING_PENALTY_MIN × TIME_VALUE
                  + DRIVE_MIN_PER_KM × TIME_VALUE × km to the fallback
                  + the fallback lot's own cost)
```

`TIME_VALUE = 5` — five New Taiwan dollars per minute. `EXPECTED_HOURS = 2` sets the fare.
`CIRCLING_PENALTY_MIN = 12`, `DRIVE_MIN_PER_KM = 2.4`.

The score is the expected cost of the whole trip in NT$, meant literally. That is what makes this
spec small: **the exchange rate between walking and money is already a number in the code**, ratified
against the live roster by `scripts/probe-ranker.py`. A preference is a different value for it, not
a new formula.

## 3. The constant has to split first

`TIME_VALUE` is doing two unrelated jobs. It prices **the walk from the car park to where you are
going**, and it prices **the delay when a lot turns you away** — the circling, and the drive to
somewhere else.

Those are the same unit and not the same quantity, and conflating them breaks this feature at
exactly the wrong moment. If a "cheaper" preset simply lowered `TIME_VALUE`, it would also shrink the
circling penalty from NT$60 to NT$24 — **quietly weakening the availability signal for the driver who
asked about price**, who is the one least likely to notice. The app's central claim is that it ranks
by how likely you are to get a space. A preference must not be able to erode that.

So:

| Constant | Prices | Preference moves it? |
|---|---|---|
| `WALK_VALUE` | a minute walking from the car park to the destination | **yes** |
| `DELAY_VALUE` | a minute lost circling, and driving to the fallback | **upward only**: `max(5, WALK_VALUE)` |

**`DELAY_VALUE = max(5, WALK_VALUE)` — floor-coupled, and that rule is measured, not reasoned.**
An earlier draft of this spec pinned `DELAY_VALUE` at 5 outright. §5 shows why that is unsafe at the
Closer end, and why coupling the two symmetrically — the obvious repair — is unsafe at the Cheaper
end instead. The floor satisfies both: the delay price can never fall below today's value, so a
preference still cannot erode the penalty for being sent away, but it rises with `WALK_VALUE` so
that making walking expensive does not *relatively* cheapen being turned away.

## 4. The three presets

| Preset | `WALK_VALUE` | `DELAY_VALUE` | What it means in practice |
|---|---|---|---|
| Cheaper | 2 | 5 | A 10-minute walk costs NT$20 against a typical NT$60–120 fare: fare dominates |
| **Balanced** (default) | **5** | **5** | 10 minutes ≈ NT$50, comparable to the fare — today's behaviour, unchanged |
| Closer | 12 | 12 | 10 minutes ≈ NT$120, more than a typical fare: distance dominates — and being turned away costs proportionately more too, which is what keeps it safe |

Only Closer's `DELAY_VALUE` moves. Balanced is the shipped pair unchanged, so **a driver who never
opens the control sees exactly what they see today** — the property that makes this safe to ship.

## 5. The invariant: availability still leads

**A preference must never make the app recommend a car park it believes is full.**

> **Correction, 2026-09-19 — read this before quoting any number below.** The inversion *counts* in
> this section are a property of the **roster snapshot they were measured on**, not of the ranker.
> Task 5's sweep did not reproduce them, and established that the code is not the reason: the
> pre-split probe run against the pre-split `rank.ts` gives numerically identical output to the
> repaired probe on today's artifacts. The input moved. On a snapshot taken ~3 h later (1,089 lots
> against 1,090), **the shipped probe's own Balanced baseline went from 11 to 57 on code nobody
> touched**, and varying only the horizon column swings the same roster's count 22 → 84.
>
> So: **the counts are not settled figures and must never be quoted as though they were.** Any
> figure recorded here needs its roster size, generation time and horizon column beside it. What is
> durable is the **direction** of each comparison and the **`at #1` column**, which reproduced in
> all six cells across both samples. The tables below are kept with their provenance attached,
> because the decisions they drove were the right ones — but they are a photograph, not a constant.

The first draft of this spec said "must never reorder past probability", which is a stronger claim
and **already false before this feature exists**. `scripts/probe-ranker.py` finds **11 inversions at
the shipped constants**, the worst reaching position #3 — a lot at P=14% and 0 m outranking one at
P=97% and 777 m, because the failure branch (NT$107.9) is narrowly cheaper than the likelier lot's
total (NT$110.4). An invariant that fails on day one protects nothing.

So the line is **position**, and the probe already argues why: *"A likely-full lot deep in a list is
a trade-off the driver can see and reject; one at the top is the app recommending a car park it
believes is full."* The invariant is that **no preset puts an inversion at #1**, and that no preset
is materially worse than Balanced on inversion count or worst position.

### What the measurement found

Measured with a harness reusing the probe's own `Ranker`, `load_constants` and `count_inversions`,
verified to reproduce the shipped figures exactly at 5/5. Lot-position destinations (the adversarial
sample — you have driven somewhere and there is a car park right there):

| Scheme | WALK | DELAY | Inversions | Worst | At #1 | far@20 |
|---|---|---|---|---|---|---|
| Cheaper, pinned | 2 | 5 | **0** | — | 0 | 19 |
| Balanced (shipped) | 5 | 5 | 11 | #3 | 0 | 299 |
| Closer, pinned | 12 | 5 | **35** | **#2** | 0 | **963** |
| Cheaper, symmetric | 2 | 2 | **19** | **#2** | 0 | 618 |
| **Closer, floor-coupled** | **12** | **12** | **8** | **#6** | 0 | **173** |

Three findings, none of which survived being guessed at:

1. **Closer is the dangerous direction, not Cheaper.** Every inversion has the shape *near, cheap,
   unlikely* beating *far, expensive, likely*. Raising `WALK_VALUE` penalises only the **far** lot —
   which is the reliable one — while the risky lot sits at the destination paying nothing.
2. **Symmetric coupling fixes Closer and breaks Cheaper.** Dropping `DELAY_VALUE` to 2 makes being
   turned away cheap, and Cheaper goes from 0 inversions to 19.
3. **Floor-coupling fixes both.** Closer at 12/12 is safer than the *shipped* ranker on inversion
   count and on nearly every reach column, while still changing the top pick for **29.8%** of
   destinations against the unsafe version's 30.3%. It loses none of its point.

   **Amended 2026-09-19:** "safer on every column" was too strong, and the re-measurement withdraws
   it. On the realistic sample Closer reaches **worst position #2** against Balanced's #3 — better
   on count, *worse* on position, one place from the gate. That is a real trade rather than a
   defect, and it is the honest description of what "prioritise closeness" costs: a driver asking to
   walk less is accepting a higher chance of being turned away, and the card still shows them the
   probability, so the trade is visible rather than hidden. The values are **not** re-tuned against
   this — tuning a constant against a single snapshot is chasing noise. See the correction above.

**Realistic destinations sharpen this rather than softening it.** Re-run over 700 points from the
offline place index (POIs only, ≥ 50 m from every lot), the effect is larger, not smaller: Balanced
88 inversions, Closer-pinned **603**, Cheaper-symmetric 195. Lot-position sampling was not
exaggerating anything. **No scheme, in either sample, ever reaches #1.**

### What ships as a check

`probe-ranker.py` gains a preference sweep **measuring** the invariant above across both samples —
and it gates on **`at #1` alone**. An earlier draft added "and no preset is materially worse than
Balanced on inversion count or worst position"; that clause is **withdrawn**. It was invented rather
than measured, and the 2026-09-19 sweep shows why: the quantity it constrains moves by a factor of
five without the ranker changing at all. It
already **parses the constants out of the TypeScript rather than copying them**, precisely so a probe
cannot report stale numbers as current — and renaming `TIME_VALUE` will break `load_constants()`,
which is the design working: it fails loudly rather than silently scoring the old world.

## 6. What the list shows

Today: the top 20 by expected cost, plus a few rescued no-forecast neighbours (`listRows`).

That cap is the reason a driver sees a green dot near their destination and cannot find it in the
list. The fix is to bound the list by **distance rather than by count**: `NEARBY_RADIUS_M = 1500`
— about a nineteen-minute walk at the app's own 80 m/min.

Why distance and not a bigger number: a count is arbitrary and a radius is a claim a driver can check
against the street. "Everything you could reasonably walk to, in order" is a sentence the list can
honestly make; "the twenty best" is not one anybody asked for.

**Measured, not assumed.** Against the live 1,090-lot Taipei roster, sampling 120 destinations drawn
from lot positions — the realistic case, since that is where people drive to:

| Radius | Walk | Median lots | 90th pct | Worst |
|---|---|---|---|---|
| 1.0 km | 12 min | 35 | 66 | 79 |
| **1.5 km** | **19 min** | **64** | **140** | **157** |
| 2.0 km | 25 min | 106 | 234 | 256 |

(An earlier draft of this spec guessed "on the order of a dozen extra rows" at 1 km. That was wrong
by about threefold. Taipei is denser than it looks on a map, which is the whole reason these numbers
are measured here instead of estimated.)

**So the radius is not the constraint; rendering is.** Laying out 157 cards on a phone is exactly the
kind of cost this project has already been told about once. The list therefore keeps its ranked head
at today's length and puts the remainder — out to `NEARBY_RADIUS_M`, in the same cost order — behind
a **"show more nearby" expander**. Full reach, and a phone pays only for what the driver opens.
Distant lots sink to the tail under the ranking anyway, so nothing good is hidden by the fold.

Lots beyond 1.5 km remain reachable by tapping their dot on the map, which shows the same card —
out to `COVERAGE_RADIUS_M` from the destination. Past that the dot answers with the map's own popup
instead: the card's walk, price-vs-walk and arrival tiles would be describing a trip nobody is going
to make.

## 7. The control

- Three segmented options, defaulting to Balanced. Every tap target ≥ 44 px.
- It sits with the arrival picker: both answer "what am I asking for", as against the list, which
  answers "here is what we found".
- The choice persists in `localStorage`, like the language toggle, and like it never leaves the
  device.
- Changing it re-ranks in place. It does not scroll, re-centre the map, or move the arrival — the
  same restraint `ArrivalPicker` already observes.
- **The score itself is never shown.** That rule is unchanged: the control names a preference, not a
  number, and no card gains a "NT$142" anywhere.

## 8. i18n

New keys in both languages, none invented in a component: the group label and the three option
names. Traditional characters, Taiwan orthography. "Cheaper" and "closer" are comparatives on
purpose — they describe a lean, not a guarantee, because the ranker will still put a likely space
above an unlikely bargain and the copy must not promise otherwise.

## 9. What this means for Stage B

**The trained model should not learn preferences, and this spec is what keeps them apart.**

The model predicts one thing: how likely a space is. The ranker turns that probability, plus the
walk, plus the fare, plus the driver's preference, into an order. Three consequences:

1. **One artifact serves everyone.** A single `grid.bin` and `week.bin`, as today. Preferences
   baked into the model would mean a model per combination — impossible on the free tier, and the
   reason this separation is architectural rather than tidy.
2. **Preferences need no retraining.** Changing `WALK_VALUE` is a client-side constant, not a
   corpus.
3. **Evaluation keeps measuring the right thing.** Brier score stays a statement about calibration.
   If preferences entered the model, a worse-calibrated model could score better by matching
   somebody's taste, and `evaluate.py` would stop meaning what it says.

Stage B should get **better at `p`**. This spec makes the ranker **configurable about what `p` is
worth**.

## 10. Tests

- Each preset produces the stated `WALK_VALUE`, and Balanced reproduces today's ordering exactly —
  the regression that matters most, because it is what every existing user gets.
- `DELAY_VALUE` is unmoved by every preset: the failure branch is identical under all three.
- The probe's preference sweep (§5) finds no availability inversion.
- The list reaches every lot within `NEARBY_RADIUS_M` and stays ordered by the ranker; the expander
  reveals the tail without re-sorting it, and the ranked head is unchanged with the expander closed.
- Rendering cost is bounded with the expander closed, whatever the local lot density.
- The preference survives a reload and never reaches the network.
- Honesty, unchanged: a `null` probability still renders "no data" under every preset; a
  not-updating lot still says so; the score is still never shown.

## 11. Out of scope

**Parking duration.** `EXPECTED_HOURS = 2` stays a fixed assumption for every driver. It is a real
limitation and worth recording plainly: because lots price differently — flat against hourly against
progressive — the duration of the visit genuinely changes *which* lot is cheapest, so "cheaper" here
means "cheaper for a two-hour stay". Asking the driver how long they are staying is a second
question with a real answer and it would feed arithmetic that already exists; it is deferred, not
dismissed.

Also out of scope: per-user models, motorcycle spaces, the other five cities' shards in the app, and
any change to `Blend`, `Climatology` or the forecaster.

## 12. Risks

- **A preference that quietly becomes a probability override.** Mitigated by §3's split and measured
  by §5's sweep. If the sweep ever finds an inversion, the answer is to narrow the preset range, not
  to widen the threshold.
- **A longer list reading as a worse one, or a slower one.** A 1.5 km bound reaches a median of 64
  lots and up to 157. The ordering is unchanged, so the top of the list is exactly as good as it is
  today, and the expander keeps the rendering cost of the tail optional. If the measured frame cost
  with the expander open is still bad in the densest districts, the answer is to paginate the tail —
  not to shrink the radius, which is the part the driver asked for.
- **"Cheaper" read as "cheapest".** Copy is comparative for this reason (§8).
