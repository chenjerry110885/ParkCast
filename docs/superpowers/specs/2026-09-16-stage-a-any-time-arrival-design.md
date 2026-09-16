# Stage A — arrival at any time, confidence from evidence

**Status:** proposed, 2026-09-16
**Follows:** [`2026-09-15-ui-redesign-design.md`](2026-09-15-ui-redesign-design.md)
**Precedes:** the nationwide collector (its own spec), and Stage B, the trained model

## 1. Goal

Two complaints, one root cause.

> "Limiting the prediction to two hours is weird, and the further the time is the lower
> the confidence is is also weird."

Both are artifacts of the *delivery*, not the model. `grid.bin` carries 24 columns — `+5`
through `+120` minutes — so the app cannot be asked about 21:20 tomorrow. And `confidence.ts`
derives its label from the horizon alone, so the app says "low" for any distant time even when
it has four weeks of consistent history for exactly that half-hour of the week.

The forecaster underneath already answers "what is this lot like on a Tuesday at 21:20": that
is what `Climatology` is. What it cannot currently do is *say how much it knows*. This spec
ships the climatology to the client and replaces horizon-as-confidence with evidence.

**Not** a new model. `Blend` is unchanged; Stage B replaces it, on the corpus this unblocks.

## 2. Constraints

Inherited, binding, unchanged:

- **No data is never 0%.** A lot with no forecast renders "no data", never a number. A lot
  whose feed has stopped updating says so.
- **The observed count is never a forecast.** `f` is the free count at the reading, labelled
  with its age.
- **The ranker's score is never shown.**
- Nothing leaves the device: no geocoder, no API key, no new origin (`connect-src 'self'`).
- No new runtime dependency. Cloudflare Workers Free: no paid feature, and no new KV write on
  the five-minute path.
- Both layouts first-class (phone bottom sheet, desktop side panel); every tap target ≥ 44 px;
  reduced motion honoured.

## 3. The artifact: `week.bin`

A per-lot, per-half-hour-of-week table of the climatology the server already computes.

| | |
|---|---|
| Header | magic `PCW1`, schema version, `nLots`, `nBuckets` = 336, `bucketMin` = 30, `rosterId`, `builtTs` |
| Body | row-major `nLots × 336 × 2` bytes |
| Byte 1 | probability, percent `0..100`; `255` = unknown |
| Byte 2 | support: observations behind that bucket, capped at `255` |
| Size | 1,090 lots → 715 KiB raw; **gate: ≤ 600 KB gzipped** |

`rosterId` is the existing roster hash: a `week.bin` whose roster disagrees with `lots.json` is
rejected rather than indexed against the wrong lots, exactly as `grid.bin` is today.

Support is the bucket's own observation count, *before* shrinkage — the honest measure of how
much this cell rests on. A 30-minute bucket at a five-minute cadence sees six observations per
week, so `weeks ≈ support / 6`; the client does that division, the artifact stays raw.

### Why not extend `grid.bin`

A full week at five-minute resolution is 2,016 columns per lot — 2.2 MB for Taipei, and it
would have to ride the five-minute upload. The half-hour bucket is the resolution the
climatology is *computed* at (`CLIMATOLOGY_BUCKET_MIN = 30`), so a finer grid would be
interpolation dressed as knowledge.

### Cadence: daily, not five-minutely

Climatology moves over weeks. `week.bin` is rebuilt and uploaded **once a day**, on its own KV
key, leaving `send_pair`'s hot path untouched. This keeps the five-minute upload the size it is
today and costs one extra KV write a day against the Free tier's daily budget.

## 4. Where it comes from (Python)

- `artifacts.encode_week(lot_ids, climatology, counts) -> bytes` — mirrors `encode_grid`:
  pure, takes what it needs, returns the blob.
- The probability per cell is `Climatology.predict(lot_id, ts_of_bucket, horizon_min=0)` — the
  same shrunk tier chain the live forecast uses, so the two can never drift apart.
- `scheduler` publishes it when the day rolls over in Taipei, or when no `week.bin` exists yet.
- `upload.send_week(url, secret, week)` — a third artifact, its own request, its own back-off,
  reusing the existing opener, user agent and skew check.

## 5. How the client uses it

`week.ts`, a pure module beside `arrival.ts`:

```
weekBucket(ts)                      // ((ts + 8h) / 60 / 30) mod 336, matching forecast.week_bucket
probabilityAt(week, lotIndex, ts)   // {p, support} or null when unknown
blend(observedFree, climatologyP, minutesFromReading)
```

The blend is the server's, restated:

```
weight = 0.5 ** (minutesFromReading / 30)        // config.BLEND_HALF_LIFE_MIN
p      = weight * (observedFree >= 1 ? 1 : 0) + (1 - weight) * climatologyP
```

**Inside the grid's window (≤ 120 min), `grid.bin` stays the source of the number.** It is what
the backtests in `docs/state-of-play.md` actually measured. `week.bin` supplies the number only
beyond it. Because both sides compute the same blend from the same inputs — `f` is already in
`lots.json` — the two must agree at the seam; §10 makes that a test, not a hope.

`week.bin` is **fetched lazily**, on the first arrival chosen outside the grid window, the way
the place index is fetched on the first search focus. Most sessions ask about the next half
hour and never download it.

## 6. Confidence, rewritten

`confidence.ts` currently maps minutes-from-reading to high/medium/low. It gains support as a
second input and answers "how much does this rest on", evaluated in order:

| | Condition | Shown |
|---|---|---|
| — | no forecast, or the lot is not updating | nothing (unchanged) |
| **High** | arrival within 30 min of a reading ≤ 15 min old — the reading itself carries the answer | "reading from N min ago" |
| **High** | `support ≥ 24` (≈ 4 weeks of this half-hour) | "4 weeks of this time slot" |
| **Medium** | `support ≥ 6` (≈ 1 week), or arrival within 75 min of a reading ≤ 30 min old | "1 week of this time slot" |
| **Low** | otherwise | "little history for this time" |

The detail line names its own evidence, so "low" stops meaning "far away" and starts meaning
"we have not watched this lot at this hour often enough". A Tuesday 21:20 with four weeks
behind it reads **high**, and forty minutes from now at a lot first seen yesterday reads
**medium** — which is the correction the user asked for.

`weeks` is `floor(support / 6)`; the thresholds are named constants, not literals in branches.

## 7. The time picker

The chip strip (`ArrivalStrip`) is replaced by `ArrivalPicker`:

- **Quick chips**: now, +15, +30, +1 h — one tap for the common case, clicked, never dragged.
- **Three selects**: day (today, tomorrow, then weekday names), hour (00–23), minute (00–55 in
  five-minute steps). Native `<select>`: it is the control every phone already renders as a
  wheel, it is keyboard- and screen-reader-complete for free, and it holds the 44 px floor.
- **Range**: now to **+7 days**. Beyond a week the table simply repeats itself, and offering a
  date that far out would imply knowledge of an event the model has never seen.
- The readout keeps its shape — the clock time, large, with the relative distance beside it
  ("21:20 · tomorrow").

Selecting a time never scrolls or re-ranks by itself: the list re-ranks and the map recolours,
as they do today.

## 8. i18n

New keys in both languages, none invented in a component: `pickerDay`, `pickerHour`,
`pickerMinute`, `dayToday`, `dayTomorrow`, weekday names, `quickNow`, `quickPlus15`,
`quickPlus30`, `quickPlus1h`, `confidenceWeeksTemplate`, `confidenceReadingTemplate`,
`confidenceThin`. Retired: `arrivalGroupLabel`, `noForecastBeyond` (the strip's honest tail —
there is no "beyond" any more).

## 9. Delivery

| | |
|---|---|
| Worker | `/artifacts/week.bin` → KV key `week`; `validate.ts` checks magic, version, `rosterId`, and that the body length equals `nLots × 336 × 2` |
| Cache | `max-age=3600` — it changes daily, and a stale hour of climatology is not a stale forecast |
| Service worker | `VERSION` → `v3`. `routeFor` gains one **named exception before** its `artifacts/` branch: `week.bin` is **cache-first**, everything else under `artifacts/` stays network-first. A forecast from the network must always beat a cached one; a weekly aggregate must not be re-downloaded every session to learn it has not changed. A stale copy errs conservatively — support only grows, so an old table understates confidence, never overstates it |
| Deploy gate | `check-deploy-bundle.mjs` unchanged (`week.bin` is KV, not a static asset) |
| Smoke | `smoke-live.mjs` HEADs `/artifacts/week.bin` and warns — never fails — if it is absent or older than 48 h, matching how it already treats a stale forecast |

## 10. Tests

- **Python**: `encode_week` round-trips; unknown cells encode `255`; support caps at 255;
  `rosterId` matches `lots.json`; the scheduler publishes once a day and not per tick.
- **Seam** (the load-bearing one): for a fixture lot, the client blend at `+120 min` equals
  `grid.bin`'s own last column **within 1 percentage point**. If these ever diverge, a driver
  watching the number would see it jump as they crossed the boundary.
- **`week.ts`**: `weekBucket` agrees with `forecast.week_bucket` on a table of timestamps
  including both sides of a Taipei midnight and a Sunday/Monday boundary.
- **`confidence.ts`**: each row of §6's table, plus the null cases.
- **`ArrivalPicker`**: selects change the arrival; quick chips change it; a drag across the
  chips does not; the 7-day bound holds; keyboard reaches every control.
- **Lazy fetch**: `week.bin` is not fetched on load, is fetched once when an out-of-window time
  is chosen, and a failed fetch leaves the in-window app fully working.
- **Honesty, unchanged**: a null probability still renders "no data" at every arrival time; a
  not-updating lot still says so.

## 11. Out of scope

Motorcycle spaces; the nationwide collector; the trained model; on-street parking; any change
to `Blend`, `Climatology` or the ranker. Each is its own spec.

## 12. Rollout and risks

- **Additive.** An app that has not fetched `week.bin` behaves exactly as today; a collector
  that has not published one serves a site that works inside the grid window.
- **Risk: the seam.** Mitigated by §10's 1-point test, which fails the build rather than the
  driver.
- **Risk: size.** 600 KB gzipped is the gate; if Taipei's table exceeds it, the fallback is to
  drop the support byte to a 2-bit bucket, not to raise the gate.
- **Risk: confidence reads as more certain than it is.** The 0.6–0.9 bands are already known to
  be overconfident (`docs/state-of-play.md`, "Calibration"). Stage A changes the *label*, not
  the number; the recalibration is Stage B's, and this spec must not be read as fixing it.
