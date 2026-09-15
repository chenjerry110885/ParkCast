# ParkCast / 停車先知

Probabilistic parking availability forecasting for Taipei. Predicts **P(有位)** at the
user's *arrival time* instead of displaying stale current counts.

- **Start here:** [`docs/state-of-play.md`](docs/state-of-play.md) — where the project is right now,
  the forecast evaluations, which machine collects, and what to do next
- **Design spec:** [`docs/superpowers/specs/2026-09-04-parkcast-design.md`](docs/superpowers/specs/2026-09-04-parkcast-design.md) — read this before implementing anything
- **Repo:** https://github.com/chenjerry110885/ParkCast (public)
- **Commit identity:** `Jerry Chen <chenjerry1108@gmail.com>` (set as **local** config; global stays as the work address)

---

## Git conventions — IMPORTANT

- **Conventional Commits**: `type(scope): subject` — `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`
- **Concise.** Subject line under ~72 chars. Body only when the *why* is non-obvious.
- **NEVER add `Co-Authored-By:` trailers.** No AI attribution of any kind in commit messages.
- Branch before committing if on `main` for anything non-trivial.
- Commit or push only when asked.

---

## Load-bearing project facts

Measured 2026-09-04 unless marked — do not re-derive, and do not assume these have drifted without re-measuring.

| Fact | Value |
|---|---|
| Availability feed | `https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json` (472 KB, no auth) |
| Metadata feed | `https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json` (2.85 MB, no auth) |
| Update cadence | **exactly 5 min** |
| Publish lag | **+2:45 to +3:15, consistent** |
| Poll schedule | data_ts minutes are `≡3 (mod 5)`; publish is `≡1 (mod 5)` → **poll at minutes ≡1 (mod 5), second 30** (`:06:30, :11:30, …`) |
| Churn per tick | **~40–47%** of lots change **in the daytime** (42–47% in the 2026-09-04 morning sample; 39.6–42.0% by 3-hour block on 2026-09-12), **9–12% overnight** — see "What the data looks like" |
| Usable lots | **1,068** (valid count + known capacity), 12/12 districts |
| No-data sentinel | **`-9` → NULL, never 0** |
| Coordinates | `tw97x/y` = TWD97 TM2 (EPSG:3826); `EntranceCoord` = WGS84 lat/lon |

### Forecasting facts (measured 2026-09-05 over 62 real ticks / 72,858 observations)

| Fact | Value |
|---|---|
| `grid.bin` size | **26,181 bytes** at 1,090 lots × 24 horizons (**21-byte** header: `<4sBIIHBBI`, incl. `roster_id`) — re-measured 2026-09-14 |
| `lots.json` size | **187,922 bytes raw / 30,877 gzipped** at 1,090 published lots, 133 of them carrying `"u"` (compact keys, parsed price, no fare text) — measured 2026-09-14 on a snapshot publish with the not-updating rule; gzip drifts with the timestamps, raw with how many lots are withheld |
| P(free≥1) base rate | **0.844 at 19:00**, rising to **0.919 at 23:00** Taipei (2026-09-05); by hour and day of week in "What the data looks like" |
| Lots published | **1,090** of 1,769 lots in the 2026-09-14 metadata snapshot (1,075 on 2026-09-07; the roster grows) — every one with history and car spaces |

### A lot with no car spaces is not published (measured 2026-09-07)

The metadata roster grows *during* a day — 1,755 lots in the 2026-09-07 snapshot, 1,756 in the live
feed by 08:12 — and the daily snapshot is deliberately never rewritten, so a count taken from a
snapshot and one taken from the feed legitimately differ by a lot or two. Figures below are from
the snapshot.

`totalcar` is positive for **1,699** of the 1,755 lots and exactly **0** for **56**. There is no
`-9` in this field today — a measurement, not a guarantee. **`0` and `-9` are different facts**:
`0` means "not a car park" (a motorcycle or coach park), `-9`/missing means "not reported". 14 of
the zero-car lots had history and were being published; eight of them advertised a **98–100%**
chance of a car space at a park with no car bays (TPE1697 has 14 motorcycle bays and reports 25–31
free cars). `Lot.serves_cars` drops them **at publish time only**.

**The collection path is deliberately untouched.** A zero-car lot is still parsed, still collected
and still stored with `capacity_car = None`. Letting capacity `0` reach `validate` would clamp
`free_car` to 0 from that moment on and manufacture a discontinuity inside the corpus Plan 4 trains
on. Their junk history therefore still feeds the global climatology prior: they are **7,803
observations (1.22% of the corpus) at a 0.536 base rate**, holding the citywide prior at **0.8966**
where it would otherwise be **0.9010** — a **0.44 pp** depression. Deferred, not fixed: excluding
them from history would invalidate the per-Parquet counter cache.

**The target is saturated.** ~85-92% of lots have a space at any time, so a citywide Brier score is
dominated by easy cases and **climatology is a strong baseline**. Plan 4 must report skill on the
hard subset (lots at or near capacity) in addition to the citywide number, or the evaluation will
flatter itself.

**Price is unstructured, and measured (2026-09-06 over 1,756 lots).** `payex` is free Chinese text;
none are empty, 1,119 are distinct.

| | share | note |
|---|---|---|
| hourly rate present | **87%** | `NN元/時` |
| — time-tiered | 6% | `100元/時(09-21)、60元/時(21-09)` |
| — weekday-varying | 6% | `週一至週五…` |
| per-entry only (計次) | 3% | a different pricing model, not an hourly rate |
| neither → **unknown** | **10%** | |

**83 of the 104 time-tiered lots would be OVERSTATED by taking the first regex match**, so naive
parsing is not good enough. The ranker shows price as a visible column, so a wrong price is worse
than no price: **unknown must be a first-class value.** The UI shows it as unknown and the ranker
drops the price term for that lot — never substitutes zero, never substitutes an average, never
guesses.

### A lot whose feed is not updating gets no forecast (measured 2026-09-14)

Over 82.4 h of unbroken collection (Thu 09-10 11:00 → Sun 09-13 21:25), **92 car parks did not
change their reading once.** The 40 stuck at 0 free were published as a **0%** chance of a space;
the rest, stuck at a fixed number or at capacity, as **100%** — 陽明山花鐘停車場 reported all 34 of
its spaces free for a whole weekend. **40 of the 66 lots the app called ≤10% were lots stuck at 0
for 72 h.** Using every published lot as a destination, the app's #1 recommendation was one of them
for **3–4%** of destinations, and one was in the top three for **12–14%**. That is the complaint
this project exists to answer — it said there was a space, and there wasn't — produced by the app.

**The rule** (`src/parkcast/liveness.py`, Plan 3e). A lot is *not updating* when its non-null
readings have been identical for **≥24 h** with readings on at least half of that run's 5-minute
slots, or when it has sent **no reading for ≥24 h**. It stays on the roster with every grid cell
`UNKNOWN` and `"u"` — its last update — in `lots.json`, and the app says **"Not updating · No
change in N h"** / **"資料未更新 · 已 N 小時未變動"**. The rule is recomputed from the hot store at
every publish, so a lot rejoins the forecast on the tick its reading moves. `u` is the *latest* the
update could have been as far as the collector saw (the hot window caps what is visible at 48 h), so
the hours shown are a lower bound on what was observed. It assumes nothing changed while the
collector itself was down: a run half observed and half collector gap still passes the coverage
guard, and after an outage of a day or more a lot whose first reading back is missing is withheld
from its last reading until it reports. Both clear on the next reading; ending runs at collector
gaps is a deferred follow-up.

- **Why 24 h.** The share of lots whose longest run is unchanged falls smoothly — 79.7% have one of
  ≥3 h, 27.6% of ≥12 h, **12.8% of ≥24 h**, 8.6% of ≥72 h — so there is no natural gap to pick.
  Overnight runs are ordinary. 24 h always spans a daytime period; the 12–24 h band mixes the
  genuine (a 3-space lot full all Friday, a hospital car park empty over a weekend) with obvious
  freezes (文華停車場, 449 spaces, exactly 221 free for 23 h).
- **Why the coverage guard.** Without it, a lot that read 5 before a long collector outage and 5
  after it would look frozen straight across the gap.
- **Why "not updating", not "lost connection".** For most of these lots the feed still sends a
  number; what we observe is that it stopped changing, not why.
- **Publishing only, like `serves_cars`.** Collection, storage and the corpus are untouched.

Measured with the shipped code on a snapshot at 2026-09-14 01:13: **133 of 1,090 published lots
withheld (12.2%)** — 49 stuck at a mid value, 46 at 0, 23 at capacity, and 15 with no reading for
24 h, which had been getting a climatology-only percentage. Every other grid row is byte-identical to
the plain Blend grid. The rule costs **0.22 s** per publish — one backwards walk of the primary key;
a mixed-direction `ORDER BY` would add a sort, and a test pins the query plan — and a steady-state
publish took 0.73 s. **Deployed to the collector 2026-09-14 09:06; its first live publish withheld 112** — the count moves as feeds freeze and recover.

**`report.find_frozen_lots` is not this, and cannot be used as a detector.** It counts ≥72 identical
consecutive observations (6 h) and flagged **494 / 468 / 495** lots on the full days 09-11 / 09-12 /
09-13 — about 45% of the roster — because a quiet night is a 6-hour run. The "frozen" count in the
daily log means "had a quiet night", not "is broken".

**Deferred, with the number.** The withheld lots are 181,429 of 1,536,144 cold observations
(11.81%) at their own rate of 0.597, holding the citywide climatology prior at **0.8852** where it
would otherwise be **0.9238** — a 3.9-point depression, about nine times the zero-car lots' 0.44.
Excluding them from the counts invalidates the per-Parquet counter cache, the same trade as before.

### The forecast has been evaluated three times, and the long-horizon verdict reversed

`python scripts/evaluate-forecast.py`. Time-split, walk-forward, leak-free by the train/test
contract in `forecast.py`. Since Plan 3e it scores only forecasts the app publishes: a lot shown as
not updating at an origin is withheld from every forecaster there (`--include-not-updating` scores
them anyway, to compare). Full numbers and caveats in [`docs/state-of-play.md`](docs/state-of-play.md).

Blend's Brier skill over persistence:

| run | test period | 5 min | 15 | 30 | 60 | 120 |
|---|---|---|---|---|---|---|
| 2026-09-10 | 37 origins to Thu 09-10 09:03; 2.2 days of training | +5.6% | +7.6% | −1.2% | −11.9% | −10.2% |
| 2026-09-13 | 48 origins, Sat 03:28 → Sun 02:58 | +7.4% | +14.5% | +15.8% | +15.6% | +20.6% |
| **2026-09-14, as shipped** | 48 origins, Sat 04:33 → Sun 04:03; 26,335 labels withheld | **+6.9%** | **+14.4%** | **+16.6%** | **+16.3%** | **+21.9%** |
| 2026-09-14, 256 hard lots | same | +6.7% | +12.1% | +10.0% | +5.4% | +8.2% |

**The 09-10 finding — blend worse than persistence beyond 30 minutes — did not reproduce.** The test
periods differ in days and hours (the later two are a full weekend day), so this is a second sample
pointing the other way, not a before-and-after of the method, and none of these is a confidence
interval.

**Why it moved is not established.** In the 09-13 run every daytime prediction had *zero* training
observations behind its 30-minute-of-week bucket — the only earlier Saturday had been collected
overnight only — and every supported prediction fell at night, so support and time of day cannot be
separated in it. What *was* measured: blend still beat persistence by **+15.8% to +17.6% in daytime
with zero bucket support**. That is consistent with the gain coming from each lot's own rate, which
three unbroken days filled in, but no ablation compared the runs, so it is an inference, not a
measurement. It does show that zero bucket support does not by itself make blend lose, so **the
support-aware blend proposed on 09-10 is deprioritised, not done** — re-examine it with the ~10-01
re-run. Support still shows within a run (09-14): bucket n = 0 → blend Brier 0.1013 over 62,236
predictions; 1–5 → 0.0509 over 49,106; 6–19 → 0.0157 over 120,194; nothing has 20+ yet.

**Calibration is sound where the mass is and overconfident in the middle** (09-14): the 0.9–1.0 band
holds 198,024 of 231,536 predictions and says 0.986 against 0.976 observed; 0.8–0.9 says 0.862 and
happens 0.791; 0.6–0.7 says 0.657 and happens 0.520; 0.0–0.1 says 0.070 and happens 0.105.

**Withholding frozen lots moves the evaluation in the honest direction.** Scored anyway, they put
17,170 predictions in the 0.0–0.1 band instead of 5,910 — two thirds of the "almost certainly full"
answers were lots whose reading had not moved — and handed persistence free points on the hard set:
its base rate is 0.566 with them and 0.702 without, and blend's hard-set skill +7.5% with them,
+8.3% without.

**Do not cap the horizon slider to improve the metric.** Deleting a feature to flatter a number is
the opposite of how this project has handled every other inconvenient measurement. **Re-run around
2026-10-01**, when every bucket has three days behind it (see the support schedule below), before
drawing conclusions about the method or training a model.

### Ranker calibration — ratified and open parts

**Price outweighing walking distance is intended (ratified 2026-09-07).** Between two car parks
that both have a space, a driver takes the cheaper one. Measured across four real destinations,
the top ten results differ by at most 9 points of probability but by a factor of three in price,
so price and walking are the live variables. Do not "fix" this.

**`cost` is the expected cost of the whole trip in NT$, and means it literally** (changed
2026-09-09, and again 2026-09-14):

    cost = p x (walk + fare)
         + (1 - p) x (circling + drive to the fallback lot + cost of the fallback lot)

You do not pay this car park's fare for a space it did not have, and a failed attempt is charged
for the trip it forces rather than for circling alone. `RELIABLE_P` (0.9) defines which lots can
serve as that alternative; the fallback is one lot per ranking, derived from the roster rather than
tuned, so failing in a dense district costs less than failing in a sparse one. The drive is
`DRIVE_MIN_PER_KM` (2.4) x `TIME_VALUE` = **NT$12 per straight-line km** from the lot that failed to
the fallback lot. At `p = 1` the failure branch vanishes and the score is simply walk plus fare.

**What it replaced, and why.** The old score was `walk + fare + (1 - p) x circling`: it charged the
fare unconditionally and never charged the onward trip, so the entire probability range was worth
one circling penalty — NT$60, which is also 12 minutes of walking and **960 m on foot**. Being a
kilometre closer cancelled being certainly full.

**The drive (2026-09-14).** The 09-09 model charged the fallback's cost but not the drive to it, as
if every failure happened at the destination. As `p -> 0` a lot's own position then stopped
mattering: every hopeless car park in the city scored about circling plus the fallback, cheaper than
a certain space a kilometre out, and they filled the tail of the list — for a Shilin destination a
lot at 2%, 5.9 km away, at #13. The probe gated only first place, which stayed right, so nobody
measured the tail for five days.

2.4 min per straight-line km is 25 km/h as the crow flies, about 30 km/h on streets a fifth longer:
the quick end of Taipei driving, so near the least the drive can cost. It is a judgment, not a
measurement, and is not to be tuned against the probe. Rejected after measuring: a walking-distance
tier (it put 3 likely-full lots at #1) and a probability tier (a cliff that contradicts the
defensible-bet rule below and makes the inversion count zero by construction).

`scripts/probe-ranker.py` measures this against the live artifacts and scores **every model on one
grid**, because the roster and the forecast move through the day and a before/after taken an hour
apart credits the calibration with whatever the clock did. Measured on the 2026-09-14 09:43 grid at
+15 min, every lot's position as a destination (1,090); *far* is under 50% and over 1.5 km,
*hopeless* under 10% and over 3 km, and the counts are destinations:

| | inversions (73) | worst position | far in top 20 | far in top 5 | hopeless in top 3 | farthest top-20 row, median / p90 |
|---|---|---|---|---|---|---|
| before 09-09 | 29 | **#1** | 17 | 0 | 0 | 1.67 / 2.17 km |
| 09-09 | 34 | #4 | **797** | 63 | 13 | 5.49 / 10.80 km |
| shipped, NT$12/km | 22 | #5 | 366 | 9 | 1 | 1.66 / 3.03 km |

NT$15 and NT$20/km (reported beside it as what-ifs) give 299 and 213 far, 0 hopeless — not a
knife-edge. First place changed for 1 destination, where an 85% and a 97% lot NT$1 apart swapped.
Most of the residual is Yangmingshan, where even the nearest alternatives are kilometres apart. (On
2026-09-09's own grid the first two models measured 25 inversions reaching #1 and 19 reaching #3.)

The count is not the point and should not be tuned to zero — a lot at 12% that is half the distance
for the same price is a defensible bet, and squeezing those out would mean over-weighting
probability to flatter a metric. **Position is the point.** The probe exits non-zero only when a
likely-full lot reaches *first place*, i.e. when the app's own top recommendation is a car park it
believes is full. Re-run it after any change to the ranker constants.

### The app is bilingual: English and 繁體中文

Required, and it shapes the artifact format rather than being a later polish pass. The upstream feed
is **100% Chinese for every user-facing field** — there is no English anywhere in it. So the
translatable boundary is fixed by the data:

| | distinct | translatable |
|---|---|---|
| UI chrome | — | yes, we author it |
| Districts (`area`) | **12** | yes, a small closed set |
| Lot types (`type2`) | **8** | yes |
| Lot names | **1,750** | **no — and they should not be** |

Lot names stay in Chinese under an English UI on purpose: they match the physical signage a driver
reads on arrival. Translating them would make the app harder to use, not easier. Traditional
characters throughout (zh-Hant / zh-TW), never Simplified.

### What the data looks like (measured 2026-09-11 → 09-13, the first unbroken days)

P(at least one free car space), car-serving lots:

| Taipei | Fri 09-11 | Sat 09-12 | Sun 09-13 |
|---|---|---|---|
| 03:00 | 0.930 | 0.925 | 0.926 |
| 08:00 | 0.928 | 0.907 | 0.915 |
| 10:00 | 0.833 | 0.809 | 0.872 |
| 13:00 | 0.811 | **0.775** | 0.819 |
| 17:00 | 0.905 | 0.837 | 0.861 |
| 19:00 | 0.843 | 0.827 | 0.879 |
| 21:00 | 0.923 | 0.916 | 0.923 |

Night sits at 0.92–0.94; the trough is early afternoon, deepest on Saturday; Friday has an evening
dip at 19:00. The hard window is 10:00–19:00.

- **How hard the city is** (Fri + Sat, 1,044 lots with ≥400 readings): 31.1% of lots are free less
  than 90% of the time, 6.7% less than half the time, 4.0% less than 10% — and 62.4% were completely
  full at least once in two days.
- **Churn by time of day** (Sat 09-12, share of lots whose reading changed tick to tick): 00–03
  11.8%, 03–06 9.1%, 06–09 27.4%, 09–12 39.6%, 12–15 41.9%, 15–18 42.0%, 18–21 39.1%, 21–24 29.0%.
  Persistence is close to perfect overnight for a reason.
- **Clamping** (48 h hot window): 22,418 readings clamped to capacity across 89 lots, 12 of them on
  every tick (TPE0463 declares 6 spaces) — the metadata's capacity is below reality. Harmless to the
  target: a reading clamped to a positive capacity still has a space. 17 lots carry no capacity; 84
  report `-9` on every tick and are not published, having no history.
- **Storage.** A full day of Parquet is **229–245 KB**, about 85 MB a year. The raw daily metadata
  snapshots are **2.17 MB a day**, about 790 MB a year — roughly 90% of the cold store's bytes.
- **The feed itself** (989 polls, 09-10 → 09-13): 25 (2.5%) found no new reading on the first try
  and all but one filled on the in-slot retry; the city never published the 09-11 18:53 reading;
  five consecutive late publishes around 01:10–01:30 on 09-13.

### Collection runs locally, and the corpus has time-correlated gaps

The collector runs in Docker on a local machine, not a cloud host. Decision taken 2026-09-05 under a
hard "no cost, no new attack surface" constraint: GCP's always-free tier requires a billing account
with a card and its budget alerts explicitly *do not* cap spending; Oracle's always-free tier
documents idle reclamation that this workload trips on every criterion.

**Consequence that must be disclosed, not hidden.** On the laptop, collection stopped whenever the
machine slept. Measured 2026-09-09 with `scripts/corpus-coverage.py`, over the first six days:

| day | slots of 288 | |
|---|---|---|
| 2026-09-04 | 66 | 23% (started mid-day) |
| 2026-09-05 | 158 | 55% |
| 2026-09-06 | 287 | **100%** |
| 2026-09-07 | 128 | 44% |
| 2026-09-08 | **0** | nothing at all |
| **overall** | **640 / 1,728** | **37%** |

The gaps are **time-correlated, not random**, and the shape is the problem rather than the volume:
**12:00–14:30 was collected on one day in six** — the lunch-and-errands window, when parking is
most contested and the app is most wanted. Plan 4 must report per-bucket support alongside every
skill number; a citywide average will otherwise lean on the hours that happened to be collected.

`restart: unless-stopped` only fires when the container *exits*. A sleeping host does not exit it —
the process resumes mid-`sleep()` on wake, which is what happened on 2026-09-09 after a 44-hour
suspend. **Do not claim the restart policy covers this; it does not.** What did work is the
rollover ordering: `run_forever` archives completed days *before* pruning, so the 150,312 rows for
2026-09-07 sitting past the 48-hour window were compacted to Parquet at 08:06:43 on resume rather
than deleted.

**Moved 2026-09-10, and measured.** The collector now runs on a desktop that stays powered on
(`D:\Projects\ParkCast`); the laptop's container is stopped and its `data/` kept as a dated
fallback. Runbook and what the move measured: [`docs/collector-move.md`](docs/collector-move.md).

| day | slots of 288 | |
|---|---|---|
| 2026-09-10 | 170 | 14 on the laptop that morning, then unbroken from 11:03 |
| 2026-09-11 | 287 | the missing slot, 18:53, the city never published |
| 2026-09-12 | **288** | |
| 2026-09-13 | 262 | **26 slots lost to a Docker Desktop Pause click** |
| **overall, 09-04 → 09-13** | **1,687 / 2,880** | **58.6%** |

The host never slept or rebooted and the container never restarted; the poll landed a median
**210 s** after each reading (p99 256 s). **The one gap was a person, not the machine**: a Pause click
on the stack in Docker Desktop at 21:26:41 and a Start click at 23:44:46 (`composePauseClicked` /
`composeStartClicked` in its UI log). A paused container never exits, so the restart policy cannot see
it, and the collector logs nothing about the gap. The stack shows in the dashboard as **`docker`** —
the name of the directory the compose file lives in. See "A pause is not a stop" in
[`docker/README.md`](docker/README.md).

- **The existing thin buckets stay thin forever.** No amount of later collection fills a hole in
  the past. 12:00–14:30 is now collected on 5 of 10 days, not 1 of 7.
- **A powered-on machine is not a monitored one.** The move removed sleep as a cause of gaps; it did
  not remove people, crashes, network outages, or a feed that stops publishing. Coverage remains
  something to measure, not to assume.
- **Support schedule.** At 09-13, of the 336 half-hour-of-week buckets climatology uses, 134 had no
  collected day behind them, 120 had one and 82 had two — Tuesday had none at all. With no further
  gaps every bucket has at least one day by **Thu 09-17**, two by **Thu 09-24** and three by
  **Thu 10-01**.

**Non-negotiable:** the collector runs from day one. Every day it is not running is a
training day that cannot be recovered.

### Deployment (2026-09-14)

Design approved and largely built (`docs/superpowers/specs/2026-09-14-deployment-design.md`, Tasks 1–11,
staged on `feat/cloudflare-deploy`, not yet deployed — see `docs/deploy.md`). Facts below are
load-bearing for anyone touching the deploy path, the collector's upload code, or the web build.

- **Free, non-negotiably.** No payment method on the Cloudflare account, ever; the app deploys to
  Cloudflare Workers + Workers KV on the Free plan, which Cloudflare documents as unable to bill past a
  limit. **Workers KV, not R2**, holds the forecast: enabling R2 requires a payment method even to use
  its free tier, which would make "free" rest on usage staying low rather than being structurally true.
- **Two-phase deploy, and why the check phase has no key.** `npm run deploy:check --prefix worker` runs
  every test, typecheck, lint, the production build and a bundle-content scan with no Cloudflare
  credential in the environment — it runs third-party tooling (test runners, linters, `npm audit`), and
  none of that code should ever see the deploy key. Only `npm run deploy:release --prefix worker`, run
  afterward in a fresh PowerShell with the key entered by `Read-Host -AsSecureString`, ever has the key;
  it runs only the pinned `wrangler` and Node built-ins.
- **Secrets never logged, committed, or in the image.** The collector's upload secret lives at
  `/run/secrets/parkcast_upload_secret`, a compose file secret — never an environment variable, never
  baked into the image. `src/parkcast/upload.py` logs an exception's type name only, never its message
  or a traceback, since either could embed the secret; `docker/secrets/`, `.dev.vars*`, `.wrangler/` and
  `.env*` (except `.env.example`) are git-ignored, and `scripts/hooks/pre-commit` (enabled with
  `git config core.hooksPath scripts/hooks`) refuses any staged line shaped like the secret or
  containing its bytes, because GitHub push protection cannot recognise a random per-project secret.
- **`web/.dev-artifacts/`, and why nothing goes under `web/public/`.** `scripts/sync-artifacts.mjs` and
  `scripts/refresh-demo-artifacts.py` now write dev copies of the forecast to the git-ignored
  `web/.dev-artifacts/`, not `web/public/artifacts/` — anything under `public/` is copied into every
  build and would have shipped as part of the deployed bundle.
- **Base `/`, not `/ParkCast/`.** `web/vite.config.ts` serves the production build from the root of the
  `workers.dev` address; `PARKCAST_BASE` remains an override for anything else. **Set it from
  PowerShell, not Git Bash** — Git Bash rewrites a path-like environment value (`PARKCAST_BASE=/` came
  back as `/Program Files/Git/`, measured 2026-09-14).
- **The upload guard's bounds** (`src/parkcast/upload.py`, `UploadGuard`): 300 attempts/day (288 slots
  exist); a 401 is retried at most once an hour; the Worker's daily-limit response pauses the collector
  until at most the next 00:00 UTC (08:00 Taipei), probed at most once an hour; any other failure backs off
  1, 2, 4, 8… ticks, capped at 12 (one hour), resetting on the next success. Nothing in the guard or the
  upload thread can raise into `run_forever` or block collection.
- **The hardened container has no memory limit, on purpose.** `docker/docker-compose.yml` sets
  `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, a `cpus` throttle and `pids_limit: 256` (4×
  the measured peak of 6 processes, never below the 256 floor) — but deliberately no hard memory limit:
  an OOM kill of the one irreplaceable collector process would cost ticks that can never be re-fetched,
  and Docker Desktop's VM already bounds memory. Rehearsed 2026-09-14 against a snapshot copy under
  `docker/docker-compose.dryrun.yml`: exit 0 as uid 10001 on a read-only root, `memory.peak` 265,166,848
  bytes, `pids.peak` 6.
- **The prune fix.** `run_forever` used to call `store.prune(conn, now − HOT_RETENTION_SEC)`
  unconditionally after archiving, so a day whose compaction kept failing could be deleted before it was
  ever written to Parquet. The cutoff is now `min(now − HOT_RETENTION_SEC, start of the earliest
  unarchived day)` (`src/parkcast/scheduler.py`; `store.prune` itself is unchanged), so a day that keeps failing to
  compact is never pruned.
- **Collector pauses are the user's own choice, not incidents.** The 2026-09-13 Docker Desktop pause was
  deliberate (see "A pause is not a stop" in `docker/README.md`); the deploy design and its smoke test
  treat a stale or missing forecast as a warning, never a failure, for exactly this reason.

---

# Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, stop and re-plan immediately — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

# Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

# Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

---

## Project-specific standards

- **Never interpolate missing observations.** Gaps stay explicit NULLs.
- **Never collapse `data_ts` and `observed_at`.** Doing so bakes the publish lag into every label.
- **Never split train/test at random.** Time-based splits only — lag features leak otherwise.
- **The model ships only if it beats *both* baselines** (persistence and climatology) on
  held-out data. A clean negative result is an acceptable, reportable outcome.
- Deterministic and testable over clever. The evaluation section of the spec is protected
  from scope cuts.

## Stack

- **Python 3.13** — collector, compaction, features, training (polars, LightGBM, pyarrow)
- **TypeScript + React + Vite + MapLibre GL + vitest** — PWA
- **SQLite** (hot, 48h) → **Parquet** (cold, daily) → **static artifacts** on CDN
- No database server. No REST API. Ranking and time-scrubbing run client-side.
