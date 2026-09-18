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
| `DELAY_VALUE` | a minute lost circling, and driving to the fallback | **no**, fixed at 5 |

`DELAY_VALUE` keeps today's value, so the failure branch is byte-for-byte what it is now and the
2026-09-09 and 2026-09-14 calibrations stand unchanged.

## 4. The three presets

| Preset | `WALK_VALUE` | What it means in practice |
|---|---|---|
| Cheaper | 2 | A 10-minute walk costs NT$20 against a typical NT$60–120 fare: fare dominates |
| **Balanced** (default) | **5** | 10 minutes ≈ NT$50, comparable to the fare — today's behaviour, unchanged |
| Closer | 12 | 10 minutes ≈ NT$120, more than a typical fare: distance dominates |

Balanced is the current constant, so **an existing user who never opens the control sees exactly what
they see today**. That is the property that makes this safe to ship.

## 5. The invariant: availability still leads

**A preference re-weights walking against money. It must never reorder past probability.**

Splitting the constants mostly achieves this by construction — the failure branch keeps its full
weight under every preset. Checking the arithmetic at the extreme: a 20%-likely cheap lot 20 minutes
away scores about NT$142 under *Cheaper*, against about NT$32 for a 90%-likely lot 5 minutes away.
The probable lot wins comfortably, and it is the failure branch that does the work.

That reasoning is not evidence, so it does not ship as a comment.

`scripts/probe-ranker.py` already measures orderings across the live roster, and it already
**parses the constants out of the TypeScript rather than copying them**, precisely so a probe cannot
report stale numbers as current. It gains a preference sweep: for every destination it samples, under
all three presets, assert no ordering places a materially-less-likely lot above a materially-more-
likely one. The threshold, the sample and the measured counts belong in the plan, not here.

Renaming `TIME_VALUE` will break `load_constants()`. That is the design working: the probe fails
loudly rather than silently scoring the old world.

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

Lots beyond 1.5 km remain reachable by tapping their dot on the map, which shows the same card.

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
