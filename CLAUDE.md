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

### Deployment (live since 2026-09-15)

**Live at <https://parkcast.tpe-dev.workers.dev>** (`docs/superpowers/specs/2026-09-14-deployment-design.md`,
`docs/deploy.md`). Production and preview KV namespace ids are committed in `worker/wrangler.jsonc`;
the host is pinned in `wrangler.jsonc` (`PRODUCTION_HOST`), `src/parkcast/config.py` (`UPLOAD_HOST`) and
`docker/docker-compose.yml` (`PARKCAST_UPLOAD_URL`). Every release needs a fresh short-lived API token
entered by the account owner — never by an agent. Facts below are load-bearing for anyone touching the
deploy path, the collector's upload code, or the web build.

- **Cloudflare's edge refuses urllib's default user agent.** `Python-urllib/3.x` gets `403` with a body of
  `error code: 1010` before the Worker sees the request (the first live upload, 2026-09-15).
  `send_pair` sends `User-Agent: parkcast-collector/1` (`config.UPLOAD_USER_AGENT`); keep it.
- **Workers static assets ignore `Range`.** A range request for a static file gets `200` and the whole
  body, so a `.pmtiles` archive cannot be read live (the pmtiles client aborts). The basemap therefore
  ships as 633 static tile files unpacked by `scripts/unpack-tiles.mjs`; the archive stays local in
  `web/basemap-src/` and the deploy gate refuses any `.pmtiles` file (`docs/basemap.md`).

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

### Web app structure (2026-09-15)

The map-first redesign (`docs/superpowers/specs/2026-09-15-ui-redesign-design.md`) replaced the plain
page's layout and most of its components. Two arrangements, one shell: phone (viewport width < 768 px)
gets a full-screen map under a frosted **bottom sheet** with three snap points (`peek` / `half` /
`full`, reached by drag or the grip button); desktop (≥ 768 px) gets the same content in a fixed
**420 px side panel**, with locate and language buttons floating over the map instead of docked in a
top bar. `Shell.tsx` picks between the two from one media query hook and nothing else in the app
decides layout.

| Path | Role |
|---|---|
| `web/src/layout/{Shell,BottomSheet,SidePanel}.tsx`, `layout/sheet.ts`, `layout/useMediaQuery.ts` | the two arrangements, and the pure snap-point arithmetic behind the sheet |
| `web/src/map/{MapView.tsx,useMapLibre.ts,basemapStyle.ts,lotSource.ts,colour.ts}` | the map itself: MapLibre lifecycle, the self-hosted basemap style, the lots GeoJSON source with its selected, best-pick and hovered-card halo layers (the hover one is a `setFilter` on the hovered id, under the other two), and the red→amber→teal ramp (`colour.ts`) |
| `web/src/{arrival,confidence,places,motion}.ts`, `web/src/useGeolocation.ts` | the redesign's pure logic modules, each independently tested (beside the older `rank.ts`, `geo.ts`, `format.ts`, `i18n.ts`, `artifacts.ts`) |
| `web/src/components/{TopBar,PlaceSearch,ArrivalPicker,LotCard,LotList,ProbabilityRing,ConfidencePill,FreshnessBadge,Skeleton,Notice,LocateButton,LangToggle}.tsx` | UI |
| `web/src/styles/{tokens,base,motion,components}.css` | replaces `index.css`, imported from `main.tsx` in that order |
| `web/src/icons.tsx` | inline SVG icon components, no icon pack, no emoji |

Removed, not carried forward: `web/src/index.css`, `components/DestinationSearch.tsx`,
`components/LotRow.tsx`, `components/Scrubber.tsx`, `web/src/search.ts` — `PlaceSearch.tsx` replaces
the first and last of those, `LotCard.tsx` the second, `ArrivalStrip.tsx` the third.

**The three honesty rules the card still has to hold, restated for `LotCard.tsx`:**

- **No data is never 0%.** A `null` probability renders as "no data" — a grey track, no arc, no
  number — never a value on the ramp; a not-updating lot says so explicitly ("not updating · no change
  in N h"), never a stale percentage standing in for it.
- **The observed count is labelled with its age, and is never presented as a forecast.** `lots.json`'s
  `f` field is the free count *at the reading*, shown as `f / c` alongside how old that reading is; it
  is its own fact tile beside the probability ring, not folded into the ring, and the tile is omitted
  entirely when `f` is `null` rather than showing a manufactured zero.
- **P, walk and price stay three separate, visible facts.** The ranker's expected-cost score
  (`rank.ts`) decides the list's order, but the number itself is never shown — the card always shows
  the probability, the walking time and the price as three tiles a driver can weigh for themselves,
  exactly as before the redesign.

### The nationwide collector (built 2026-09-16, on `feat/nationwide-collector`, not yet live)

The collector is no longer one feed. `src/parkcast/sources/__init__.py` defines a `Source` protocol
(`city: str`, `fetch(*, now: int) -> SourceTick`) and one adapter module per city under
`src/parkcast/sources/` — `taipei.py`, `newtaipei.py`, `kaohsiung.py`, `tainan.py`, `taoyuan.py`,
`hsinchu.py` — registered in `SOURCES: dict[str, Source]`. Each owns its own transport, field names
and not-reporting sentinel; none of that leaks into a shared module. Full per-city reference,
including every sentinel and quirk below: [`docs/sources.md`](docs/sources.md).

**Every adapter parses by rule, not by enumerated sentinel.** `quality.clean_count` maps any negative
int and any non-numeric value to `None`; each city's own sentinel (Taipei's `-9`, New Taipei's
`null`/`-1`/`-2`, Kaohsiung's `-1`/`-2`) rides that one rule rather than being special-cased. It paid
off twice on this branch with zero adapter changes: Kaohsiung's `motorcycleVacancy` also uses `-3`
(undocumented anywhere), and Taoyuan puts the literal status text `開放中` ("open") in `surplusSpace`
on roughly a fifth of its 246 lots instead of a count — `int("開放中")` raises exactly like a missing
key, so `clean_count` absorbed it for free. **Taoyuan's usable yield is about 80%, not 100%**, as a
result. Enumerating each city's known sentinels instead would have missed both and published a
fabricated count.

**Two cities' coordinate fields contradict their own names.** Tainan's `lnglat` holds latitude first
despite the name; Taoyuan's `wgsY` holds the longitude. Tainan, Taoyuan and Hsinchu (whose own field
names are correct, but are not trusted just for that) resolve the ordering at runtime: each parses
both candidate values and asks `sources.geo.in_taiwan` which ordering, if either, lands inside the
bounding box, dropping the lot only if neither does — nothing hard-codes an ordering from a field's
name in those three adapters. New Taipei and Kaohsiung validate one expected ordering directly, with
no swap attempt; their `Lat`/`Lng` and `lat`/`lng` fields are unambiguous and were live-verified
correct, but a seventh city should not be assumed to get the same dual-check without checking its own
adapter. (Taipei's own metadata path has needed
similar discipline since before this branch — see `geo.py`'s `_from_entrance`, *"Despite the names,
Xcod is LATITUDE and Ycod is LONGITUDE"* — but hard-codes the known swap rather than testing for it.)
A silent swap would not raise; it would put a whole city's lots in the sea and rank them by nonsense
distances, which is worse than a dropped lot.

**Identity.** Lot ids are namespaced `"{city}:{feed id}"` (`ids.qualify`/`ids.bare`/`ids.city_of`,
`SEPARATOR = ":"`) everywhere inside the store, the forecaster and `liveness` — New Taipei and Tainan
both use bare numeric feed ids, so an unqualified id cannot name a lot uniquely. Published artifacts
strip the namespace back off with `ids.bare` (`artifacts.build_lots_json`'s `id` field, and
`roster_id`): a shard is always exactly one city, so the namespace would be dead weight on every row,
and — more importantly — the app's stored "recent lots" key on the bare id it already knows, so a
namespaced id there would orphan every saved lot.

**Per-city artifacts.** `artifacts.grid_name`/`lots_name` shard by city: `grid-{city}.bin` /
`lots-{city}.json`, except Taipei, which **keeps the original unsuffixed `grid.bin`/`lots.json`**
(`artifacts.UNSUFFIXED_CITY`) because the deployed app and every cached copy already fetch those exact
URLs. `cities.json` (`artifacts.build_cities_json`) is the index: which shards exist, each with its
lot count, `base_data_ts` and bounding box, so the app can discover a city without a release.
`scheduler.publish_city` publishes each city independently — one city's empty or collapsed publish
leaves its own shard and its own `cities.json` entry untouched, and cannot touch any other city's.

**`data_ts` is per observation, not per tick**, and carries which of three kinds produced it
(`feed.TS_FEED` / `TS_RECORD` / `TS_FETCH`, on `Observation.ts_kind`): Taipei stamps the whole feed
once (`TS_FEED`); New Taipei, Tainan and Hsinchu stamp every record (`TS_RECORD`, falling back to
`TS_FETCH` when a record's own timestamp is missing or unparseable); Kaohsiung and Taoyuan carry no
timestamp anywhere and always take the fetch time (`TS_FETCH`). A fetch-time stamp is an assumption,
not a reading, and a backtest must be able to exclude it — `ts_kind` is what lets it.

**The startup migration.** `store.migrate_to_namespaced_ids`, called from `__main__.main` immediately
after `connect` and before anything else reads the store, prefixes every pre-namespacing row
(identified by `city = ''`, the column's own `ALTER TABLE` default — a recorded fact, not a guess from
the id's shape) with `taipei:` in one transaction. It is idempotent (every run after the first
rewrites 0 rows) and deduplicates legacy/namespaced twins of the same `(lot_id, data_ts)` — deleting
the legacy copy and keeping the namespaced reading, because `(lot_id, data_ts)` is the primary key and
cannot hold both. The cost: the legacy copy's `observed_at`, which was the truthful first-sighting
time under `insert_snapshot`'s "first sighting wins" rule, is lost, so `lag` is very slightly
overstated for those rows. **It has never run in production. `data/hot.sqlite` should be backed up
before the first boot of this code** — see "What to do next" in `docs/state-of-play.md`. A failure
logs and lets collection continue rather than killing the process (a collector that cannot boot costs
every tick until someone runs SQL by hand). **But the cost of that failure is more than precision,
and the log now says so:** every per-city read is scoped either by the `city` column or by the
namespaced key range (`ids.prefix_range`), and a legacy row satisfies neither, so it is invisible to
both — which means `liveness.not_updating` sees only post-boot readings and **no lot can be judged
not-updating for the first 24 h**. Stuck sensors publish as certainties again for about a day, which
is exactly the failure Plan 3e shipped to fix.

**Which cities are collected is an environment variable, not the registry.** `PARKCAST_CITIES` (see
`sources.select` / `sources.from_environment`) names the enabled cities; unset means all six, an
unknown name stops the boot naming the valid ones, and the selection is logged at boot. This is what
makes the spec's staged rollout possible without editing source and rebuilding the image three times.
`docker/docker-compose.yml` ships it set to `taipei`.

**`data_ts` is bounded on the way in.** `quality.data_ts_plausible`, applied once in
`collector.collect_once` via `collector.bound_data_ts`, refuses any stamp outside `now − 48 h` to
`now + 15 min`; the observation is dropped, counted on `TickResult.rejected_ts`, and logged. Measured
live: 16 of 268 Tainan records were over 48 h old, the worst by 2.3 years, and those rows insert and
then prune inside the same slot. Rejected rather than rebased onto the fetch time — rebasing asserts
a reading was taken now, which then publishes as the lot's observed count and lands in the wrong
climatology bucket. It lives at the collection seam rather than in `store.insert_snapshot` because
the value that does the damage is `FeedSnapshot.latest_data_ts`, not the row.

**The in-slot retry loop has a deadline.** `config.SLOT_RESERVE_SEC`: a retry is only attempted if
its worst case (`delay + len(pending) × HTTP_TIMEOUT_SEC`) still fits inside the slot. The budget was
tuned for one source; with six, a slot that overruns makes `next_poll_ts` return the slot *after*
next, so every healthy city silently loses that reading too.

**Each tick's roster reaches publishing.** `TickResult.lots` carries `SourceTick.lots` through
`run_forever`, which keeps the last good roster per city and hands them to `publish(conn, rosters)`.
Without it, `__main__._lots` held only Taipei's metadata roster and the other five cities never
published at all.

**The daily report cannot measure per-lot coverage for New Taipei, Tainan or Hsinchu.**
`report.TICK_STAMPED_CITIES` is `{taipei, kaohsiung, taoyuan}` — cities where one collector fetch
produces one `data_ts` for the whole tick, so `COUNT(DISTINCT data_ts)` is a meaningful tick count and
a lot short of it is a lot a tick actually missed. The other three stamp `data_ts` per record, and
`insert_snapshot`'s primary key is `(lot_id, data_ts)`, so a sensor whose reading has not changed
writes no new row at all — a healthy slow sensor and a lot a tick genuinely missed are
indistinguishable in the stored data. `report.CityCoverage` reports `tick_based=False` and leaves
`ticks_seen`/`ticks_expected`/`lots_with_gaps` as `None` for those three rather than printing a number
that would look like the others but measure something else; `polls_seen` (the collector's own fetch
count) stands in as evidence the collector kept asking, without claiming to be a per-lot check.
Lifting this would need each of those three feeds to distinguish "still X" from "not answering,"
which none of them do today.

### Stage A: any-time arrival (built 2026-09-16 → 2026-09-17 on `feat/stage-a`, not yet deployed)

`grid.bin` only ever forecast 120 minutes ahead. A driver asking about tomorrow evening got the
+120-minute column presented as if it answered that question, because `horizonColumn` clamps to
the grid's last column rather than refusing an out-of-range horizon — silently correct as an
accessor, silently wrong as an answer. Stage A closes that gap with a second artifact,
`week.bin`, and a picker that can reach it.

**The artifact.** A per-lot, per-half-hour-of-week climatology table: one row per lot, `336`
buckets a row (`config.WEEK_BUCKETS = 7 * 24 * 60 // CLIMATOLOGY_BUCKET_MIN`), two bytes a
bucket — a probability (`0..100`, or `255` for "no observation here") and its support, the raw
observation count behind that cell, capped at `255`. `WEEK_HEADER_FORMAT = "<4sBIHHBI"`: magic
`PCW1`, schema version, `built_ts`, `n_lots`, `n_buckets`, `bucket_min`, `roster_id` — the same
CRC32-over-ordered-ids check `grid.bin` already uses, so a table indexed against the wrong roster
is refused rather than silently misattributing one car park's history to another. Built once a
day from the corpus's own shrinkage chain (`week.build_week_cells`, through the same
`forecast.Climatology` the live forecast uses, never a re-derivation of it), not every five
minutes — a half-hour bucket is the resolution the climatology is *computed* at, so anything
finer would be interpolation dressed as knowledge.

**Measured: 732,498 bytes (715.3 KiB) raw at Taipei's real roster — 1,090 lots**, exactly
`18 + 1,090 × 336 × 2`, so this is arithmetic on the published lot count and not something that
can drift from a sample. Measured 2026-09-17 with `scripts/build-dev-week.py`, which builds a
real table shaped exactly like the published one — against `web/.dev-artifacts/lots.json`'s
actual roster, through the real encoder — without ever reading `data/`; its climatology numbers
are synthetic (deterministic per-lot, per-hour rates, not the live corpus), so treat the raw size
as exact and the specific *probabilities* as illustrative only. **Gzipped (level 9): 4,206
bytes.** That number is real but not a promise about the live table: this synthetic corpus has no
day-of-week variation and gives every bucket the same support count, both of which compress far
better than real, noisier history will. A repetition-blind bound on the same bytes — Shannon
entropy of the probability byte alone, ignoring every repeated run — is still only ~167 KB. Either
way, both figures sit far inside the spec's **≤ 600 KB gzipped** gate, with wide margin either
side of the uncertainty. **If a live table ever does approach the gate, the fallback is to narrow
the *support* byte** — e.g. to a 2-bit bucket, four tiers instead of 256 — **never to widen the
gate, and never to narrow the *probability* byte**: the seam tolerance below has only 0.03125 pp
of headroom, and it is spent entirely on the probability byte's own rounding — a coarser
probability breaks the seam test for real, where a coarser support byte costs only how finely
`confidence.ts` can grade evidence. Confirmed 2026-09-17: `/artifacts/week.bin` on the live site
still answers `404` — this branch has not shipped, and the deployed app still answers only from
`grid.bin`/`lots.json`.

**Confidence now means evidence, not distance.** Before Stage A the High/Medium/Low label was
purely a function of how far the arrival was from now — a car park with a month of consistent
Tuesday-21:20 history read "low" for an arrival three hours out, for no reason but the clock.
`confidence.ts`'s `confidenceFor` grades on two kinds of evidence instead, either sufficient on
its own: a **fresh live reading** — no more than 15 min old itself (`READING_FRESH_MAX_MIN`), for
an arrival no more than 30 min from that reading (`HIGH_MAX_MIN`, mirroring the blend's own
`BLEND_HALF_LIFE_MIN`, where persistence still carries at least half the weight) — or
**accumulated support** — the raw observation count behind this half-hour-of-week bucket, `support / 6`
(`WEEKLY_OBSERVATIONS`) floored to roughly how many weeks of this exact slot stand behind it:
`≥ 24` observations (~4 weeks) reads high, `≥ 6` (~1 week) reads medium. A lot with a month of
history at this hour now reads "high" a day and a half out; a lot nobody has watched at 3 a.m.
reads "low" five minutes out. `reason` names which kind of evidence earned the grade — the
reading wins ties at the high bar (it is the more specific claim), the weeks win ties at the
medium bar (it is the more durable one, and citing it keeps the popover's wording from flapping
as the clock runs) — see the header of `confidence.ts` for the full derivation of why the split
sits exactly on the blend's own half-life.

**The seam: `grid.bin` answers inside +120 min, `week.bin` answers beyond it, and they must agree
where they meet to within 1 percentage point.** `probabilityForLot` (`web/src/App.tsx`) is the
switch: `horizonMin <= gridSpanMin` reads the grid; past it, `week.bin`'s cell for the arrival's
own bucket is blended with the live reading through the *same* `blend(f, climatology,
minutesFromReading)` the server's `Blend.predict` computes the grid with, so the two sides are
never independent restatements of the model. At exactly +120 min both are defined, and
`seam.test.ts` pins the gap between them to `TOLERANCE_PP = 1`, which is arithmetic, not slack:
the grid rounds its finished blend once (≤ 0.5 pp), the week cell rounds its climatology *first*
and the client then scales that rounding error by `1 - weight = 0.9375` at this horizon
(≤ 0.46875 pp) — nothing honest can exceed 0.96875 pp, leaving **0.03125 pp of headroom** under
the 1 pp gate. A real bug (a wrong `weight`, bucket, row, or a swapped cell byte) lands 10–42 pp
outside it, nowhere near the boundary, so do not widen this tolerance to make a failure go away —
the fix is in the code. Every byte the test compares is written by Python
(`scripts/build-seam-fixture.py`, pinned byte-identical by `tests/test_seam_fixture.py`), never
constructed in TypeScript, because a fixture built on one side of the language boundary could only
ever prove the client agrees with itself.

**Bucket 0 is Thursday 00:00 Taipei, not Monday — and this cost real time on this branch.**
`forecast.week_bucket` anchors on the bare Unix epoch and does no calendar arithmetic:
`local_min = (ts + 8h) // 60`, `bucket = (local_min // 30) % 336`. 1970-01-01 was a **Thursday**,
so bucket 0 falls there, not on a Monday. An early draft of this plan asserted a Monday-anchored
table; a client written to satisfy it would have disagreed with Python by 192 buckets — four full
days — while still passing a test written to match the same wrong assumption, because a
hand-typed expectation table can only ever restate one author's arithmetic back at itself.
`web/src/week.ts`'s `weekBucket` must match `week_bucket` exactly (including floor division, not
truncation, so negative timestamps bucket correctly), and `scripts/build-seam-fixture.py` now
generates every fixture row by calling the real Python function rather than restating its
arithmetic — the same discipline `build-dev-week.py` applies to the artifact's bytes.

**`ArrivalPicker` replaced `ArrivalStrip`.** The chip strip answered two real complaints —
"limiting the prediction to two hours is weird," and a scroll that dragged like a slider on
desktop when a driver expected two ordinary dropdowns — with three native `<select>`s for day,
hour and minute (`MAX_LEAD_SEC = 7 * 24 * 3600`), keyboard- and screen-reader-complete for free
and impossible to drag into a value change. `web/src/components/ArrivalStrip.tsx` no longer
exists.

**Test counts, all real runs, 2026-09-17, in this worktree:** `./.venv/Scripts/python.exe -m
pytest -q` → **613 passed, 3 skipped**; `npx vitest run` in `web/` → **414 passed** (32 files);
`npm test` in `worker/` → **114 passed** (4 files); `node --test scripts/tests/*.test.mjs` →
**55 passed**. **The Python figure is a worktree figure, not main's.** Three tests skip wherever
`data/` is absent — `tests/test_artifacts_integration.py:36` and `tests/test_history_bounds.py:39,60`,
both `"no collected data on this machine"` — because this worktree has no corpus. In the main
checkout, which does, they run. `test_artifacts_integration.py` is the exact test that caught the
id-convention defect at merge on the nationwide-collector branch, and Stage A also modifies
`artifacts.py`, so a green worktree run here is necessary and not sufficient: **the suite must run
again in the main checkout, where `data/` exists, before this branch is considered verified** —
and not by copying `data/` into the worktree, since the live collector owns it and a mid-write
snapshot would make a passing test meaningless.

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
- **A test fixture that builds both sides of a comparison can only prove they agree with each
  other.** Two near-misses on the nationwide-collector branch, both caught only by review, not by
  the suite that claimed to cover them: `metadata.parse_metadata` kept emitting bare lot ids after
  `Observation.lot_id` became namespaced, and every publish test passed anyway because it built both
  `lots` and `observations` from the same bare id; separately, the tests for the cold-Parquet id fix
  wrote *namespaced* cold fixtures, which the real pre-namespacing corpus does not contain. Build the
  two sides of an id (or format, or convention) boundary from genuinely different sources, or from
  the real production shape — never from one shared literal.

## Stack

- **Python 3.13** — collector, compaction, features, training (polars, LightGBM, pyarrow)
- **TypeScript + React + Vite + MapLibre GL + vitest** — PWA
- **SQLite** (hot, 48h) → **Parquet** (cold, daily) → **static artifacts** on CDN
- No database server. No REST API. Ranking and time-scrubbing run client-side.
