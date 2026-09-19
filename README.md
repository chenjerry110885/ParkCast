# ParkCast / 停車先知

**Will there be a parking space when I get there?**

Taipei publishes live parking availability for over a thousand car parks, and several apps display
it. Drivers still complain: *顯示有位，到了就沒了* — "it said there was a space, and there wasn't."

The complaint is correct, and the reason is measurable.

---

## The problem, in three numbers

I measured the official feed before writing any code:

| | |
|---|---|
| Publish cadence | exactly **5 minutes** |
| Publish lag | **+2:45 to +3:15**, consistently |
| Lots that change between ticks | **40–47%** in the daytime (9–12% overnight) |

So the number an app shows you is already **3–8 minutes old**, and in the daytime nearly half the
city changed while you were reading it. A display of "current availability" is a display of the past.

And "現在有幾位?" — how many spaces are there *now* — is the wrong question anyway. A driver eighteen
minutes away needs to know about their **arrival time**, and needs to choose between options. That is
a decision under uncertainty, not a status lookup.

## What ParkCast does differently

> **Forecasts a probability, not a number. Then ranks options under that uncertainty.**

Not "台北101 will have 12 spaces at 18:40" — a promise the data cannot support. Instead:

```
松壽廣場地下停車場   信義區
  100% chance of a space · walk 4 min · 278 m · NT$10–60 per hour

府前廣場地下停車場   信義區
   21% chance of a space · walk 3 min · 191 m · NT$10–30 per hour
```

That second row is the whole point. 府前廣場 is the **closest** car park and among the cheapest — and
it is ranked second, because it is only **21% likely to have a space**. Every existing app shows you
the nearest one.

A consequence worth stating plainly: because the feed is already stale on arrival, **even answering
"有位嗎?" correctly right now requires a model.** The nowcast is a staleness correction; the
arrival-time forecast is the same machinery extended.

## Status

Collecting since 2026-09-04 — on a laptop that slept until 2026-09-10, on an always-on desktop since.
Corpus figures below are at the time of writing (2026-09-14); test counts are refreshed to
2026-09-19, on `feat/ranking-preferences`:

| | |
|---|---|
| Readings collected | **1,986,840**, across 1,702 five-minute ticks |
| Collection coverage | **58.6%** of elapsed five-minute slots through 09-13 (`python scripts/corpus-coverage.py`) — 34.4% when the collector moved off the laptop |
| Lots forecast every 5 min | **1,090** × 24 horizons (+5 to +120 min) |
| Lots withheld as *not updating* | **112** at the first live publish (2026-09-14 09:11); 133 on a snapshot at 01:13 — the count moves as feeds freeze and recover (see the limitations) |
| Lots with a parsed price | **97.8%** |
| Published payload | **34.5 KB gzipped**, both files |
| Tests | **626** Python (0 skipped) · **548** web · **121** Worker · **55** scripts |

Plans 1 through 3e are complete: the collector, the forecast grid, the ranked list, a map-first
installable offline-capable app with place search, and — 3e — no forecast at all for a car park
whose feed has stopped updating. The **nationwide collector** — six cities' feeds behind one
`Source` protocol, namespaced lot ids, per-city artifacts (`docs/sources.md`) — is code-complete and
tested on `feat/nationwide-collector`, staged for a live rollout one city at a time; the app itself
still shows Taipei only until that rollout finishes and a following spec teaches it to read the other
cities' shards. **Stage A** adds a per-lot, per-half-hour-of-week climatology table (`week.bin`) so
the app can answer any arrival within seven days instead of only the next two hours, and turns the
confidence label into a statement about how much history backs a forecast rather than how far away
it is — code-complete and tested on `feat/stage-a`, not yet deployed. **Ranking preferences** lets a
driver lean the ranker toward cheaper, balanced or closer — a preset moves what a minute of walking
costs, never the odds of a space — code-complete and probe-verified on `feat/ranking-preferences`,
not yet merged or deployed. **The forecast has been evaluated three times**; see the limitations
below for what that found. A *trained* model is still to come, and deliberately so: the corpus needs
weeks more before beating the baselines would mean anything.

## The app

ParkCast is map-first: a full-screen MapLibre map with every car park drawn as a dot on the red →
amber → teal probability ramp — never green, so the map stays readable under red-green colour
blindness. On a phone the ranked list lives in a frosted bottom sheet that peeks, half-opens or
fills the screen on a drag (or the grip button, for keyboard and screen-reader users); at 768 px and
wider it becomes a 420 px side panel, with locate and language buttons floating over the map instead
of docked in a top bar. Arrival is a clock time — "18:35", not "in 15 min" — chosen from day, hour
and minute pickers for any moment up to seven days out, not only the next two hours; each card shows
a probability ring, a confidence label (High / Medium / Low, graded on the evidence behind it — a
fresh live reading, or accumulated weeks of history at that half-hour of the week, whichever is
stronger — never on how far away the arrival is), walking time, price, and — when the reading
carried one — the observed free count at its age. A driver can lean the ranking itself toward
**cheaper, balanced or closer** with a segmented control beside the arrival picker; balanced is the
default and the exact ranking the app has always produced, so leaving the control alone changes
nothing. A preset moves what a minute of walking costs against what a minute of being turned away
costs — never the odds of a space itself, and never a number the card shows. The list also reaches
further than it used to: every car park within a 19-minute walk gets a row, in the same ranked
order, with everything past the first twenty behind a "show more nearby" expander rather than
rendering unconditionally. Search finds car parks, MRT stations, landmarks, and streets and lanes
down to the lane, from an offline place index built out of the basemap tiles: no geocoder, no key,
nothing that leaves the phone. Every animation is gated by `prefers-reduced-motion`.

---

## How it works

```
Taipei open data ──▶ collector ──▶ SQLite (hot, 48h) ──▶ Parquet (cold, daily)
   every 5 min                            │
                                          ▼
                              forecast ──▶ grid.bin  (26 KB)  every 5 min
                                       └─▶ lots.json (188 KB) every 5 min, cacheable while the roster holds
                                          │
                                          ▼  CDN
                                   browser: ranking, distance,
                                   time-scrubbing, language
```

**There is no API server, and no database server.** The whole read path is two static files. The
browser downloads them once and does the ranking locally, so serving costs nothing, cannot fall over
under load, and the marginal cost of another user is a CDN hit.

Three decisions make that possible:

- **Precompute the grid.** 1,090 lots × 24 horizons is only 26,160 probabilities. Recomputing all of
  them every five minutes turns serving into a static lookup — no ML runtime at request time, and
  the model can get better without the app getting slower.
- **Hot/cold storage split.** SQLite keeps a rolling 48 hours for serving; each completed day is
  rolled into a compressed Parquet file of 229–245 KB, about 85 MB a year. (The raw daily metadata
  snapshots kept beside them are 2.17 MB a day, and are most of the store.)
- **Counts, not observations.** Climatology needs `(hits, total)` per time-of-week bucket, and a
  completed day's counts never change — so the corpus folds into a cached counter once per file. Per
  tick work is flat regardless of corpus age.

### Forecasters

Three share one interface, so a trained model can be scored against them on identical inputs:

- **Persistence** — naive: is there a space now? Deliberately uncalibrated. It is the bar to clear.
- **Climatology** — this lot's historical rate at this time of week, Beta-shrunk toward the lot's own
  rate and then the city's, so a bucket with six observations does not answer a probability question
  with a certainty.
- **Blend** — persistence decaying into climatology with a 30-minute half-life. The current reading
  is strong evidence about the next five minutes and almost none about two hours from now.

None of them answers for a car park whose feed has stopped updating: the grid says "no forecast" for
it, and the app says why.

### Ranking

A probability is not yet an answer. The ranker turns one into a decision by scoring each car park
as the **expected cost of the whole trip**, in NT$:

```
cost  =  p x (walk + fare)  +  (1 - p) x (circling + drive to the best reliable alternative + its cost)
```

You do not pay a car park's fare for a space it did not have, and arriving to find it full costs
more than the time spent circling — you still have to drive somewhere that has one, and pay for it.
The alternative is derived from the roster being ranked rather than tuned, so failing in a dense
district costs less than failing in a sparse one, and the drive is charged at NT$12 per
straight-line kilometre from the car park that turned you away, at the app's default (balanced)
preference — a driver who asks the ranker to lean toward *closer* prices that same kilometre at
NT$28.8, deliberately, so that raising the price of distance never cheapens the price of being
turned away. See "The app" above.

Getting this wrong is instructive, so it is worth recording that it *was* wrong. The original score
charged the fare unconditionally and priced a failure at a flat twelve minutes, which made the
entire probability range worth NT$60 — the same as 960 m of walking. Being a kilometre closer
therefore cancelled being certainly full, and a car park the model gave a **1% chance** could
outrank one at **100%**. `scripts/probe-ranker.py` scores both models on one grid and reports where
the worst such lot lands: **first place before, third after**. It exits non-zero if a likely-full
lot is ever the top recommendation.

The count of such orderings only fell from 25 to 19, and deliberately was not tuned to zero — a lot
at 12% that is half the distance for the same price is a bet a driver can reasonably take. It is
the *position* that had to change.

It was wrong a second time, more quietly. Until 2026-09-14 the failure branch left out the drive
from the car park that turned you away to the alternative, as if every failure happened at the
destination. The top of every list stayed right, which is all the probe checked; the tail did not.
With nothing tying a hopeless car park's cost to where it is, lots the model gave a 2% chance six
kilometres away filled the bottom of the list for **797 of 1,090** destinations. The probe now also
reports how far each list reaches. Charging the drive cut those destinations to 366, brought the
farthest row of a typical list from 5.5 km to 1.7 km, and changed one top recommendation in 1,090.

---

## Honest limitations

These are the parts most worth reading.

**Some car parks' feeds stop updating, and the app used to believe them.** Over 82 hours of unbroken
collection, 92 car parks did not change their reading once. The ones stuck at 0 free were shown as a
**0%** chance of a space; the ones stuck at a fixed number or at capacity as **100%** —
陽明山花鐘停車場 reported all 34 of its spaces free for an entire weekend. For 3–4% of destinations
the top recommendation was one of these lots. That is exactly the complaint this project exists to
answer, made by this project.

A car park whose reading has not changed for 24 hours — or that has sent no reading for 24 hours —
now gets **no forecast**: it stays on the map, grey, and appears in the list when it is near the
destination, saying **"Not updating · No change in 30 h"**. It is not dropped, because a missing car
park is invisible and one that says its data is stale is something a driver can act on. It does not
say "lost connection", because for most of these lots the feed still sends a number; all anyone can
see is that it stopped moving. On a snapshot at 2026-09-14 01:13 that was **133 of 1,090** car parks.
The threshold is a judgment: the share of car parks with an unchanged run falls smoothly from 80% at
3 hours to 9% at 72, so there is no clean line, and a 3-space lot that is genuinely full all day can
be caught by it.

**The corpus has time-correlated gaps, and the first week's stay.** The collector runs on a local
machine, not a cloud host — a deliberate choice under a hard no-cost, no-new-attack-surface
constraint. Until 2026-09-10 that was a laptop, and when it slept, collection stopped:

```
2026-09-04     66/288   23%  .....................................###########
2026-09-05    158/288   55%  #+####+###########+.....................########
2026-09-06    287/288  100%  ######+#########################################
2026-09-07    128/288   44%  ######+######..+###+###+........................
2026-09-08      0/288    0%  ................................................
2026-09-09     41/288   14%  ................+######.........................
2026-09-10    170/288   59%  ................##+...##########################   <- desktop from 11:03
2026-09-11    287/288  100%  #####################################+##########
2026-09-12    288/288  100%  ################################################
2026-09-13    262/288   91%  ##########################################+....+   <- a Pause click in Docker Desktop
```

**58.6% of five-minute slots through 09-13**, up from 34.4% when it moved. The gaps that matter are
not random: on the laptop **12:00–14:30 was collected on one day in six** — the lunch-and-errands
window, when a driver most wants this app and parking is most contested. It is now five days in ten.
That is a sampling problem, not a volume problem, and later collection does not fill a hole in the
past, so any evaluation reports per-bucket support next to its skill number.

The desktop also showed that an always-on machine is not a monitored one: its only real gap was a
person pausing the container, which Docker's restart policy cannot see and the collector does not
log.

**The target is saturated.** At a typical hour 85–92% of lots have a space — 92–94% at night, dipping
to 77.5% at Saturday lunchtime. A citywide Brier score is therefore dominated by easy cases, and
climatology is a genuinely strong baseline. Any model claim has to beat *climatology*, not just
persistence, and report skill on the hard subset — lots at or near capacity — or the evaluation
flatters itself.

**Prices are parsed from Chinese prose, and 2.2% cannot be.** The feed gives one free-text string per
lot covering hourly rates, per-entry fees, monthly rentals and several vehicle classes at once.
Where the rate genuinely varies by weekday, hour or event, the text does not expose the conditions
structurally — so ParkCast shows a **range** rather than resolving a tier and confidently showing a
weekday price on a Sunday. Lots it cannot price show **"price unknown"** and no number at all: a
wrong price is worse than no price.

**No model yet, and the baselines have been measured three times — with a result that reversed.**
`scripts/evaluate-forecast.py` runs a leak-free, time-split, walk-forward backtest, scoring only the
forecasts the app actually publishes. The first run (2026-09-10) found the shipped blend beating
persistence out to about 15 minutes and *losing* beyond 30. With three unbroken days of data behind
it, the latest (2026-09-14) has it ahead at every horizon: **+14.4% Brier skill over persistence at
the app's default 15 minutes, +21.9% at 120**, and +8.2% at 120 minutes on the lots that actually fill
up.

That is a second sample, not a proof: the two test periods differ in days and hours, and neither is a
confidence interval. The likeliest reason — consistent with the data, not yet proven — is each car
park's own rate, which three unbroken days filled in; the time-of-week buckets still have at most two
days behind them. The numbers get re-run, not defended, when every bucket has three days behind it
around 2026-10-01.

---

## Running it

**Collector** (Python 3.13, Docker):

```bash
docker compose -f docker/docker-compose.yml up -d --build --force-recreate
```

It polls on the feed's publish phase — minute ≡1 (mod 5), second 30 — so it reads new data about
twenty seconds after it appears rather than up to five minutes later. See
[`docker/README.md`](docker/README.md) before operating it: a paused container is not covered by the
restart policy, and `data/` must never be read from the host while it runs.

**Web app** (Node 22):

```bash
node scripts/sync-artifacts.mjs   # copy artifacts for local dev
npm run dev --prefix web
```

**Tests:**

```bash
python -m pytest                       # 626 (or in a docker-collector container; see docker/README.md)
npm test --prefix web                  # 548
npm test --prefix worker               # 121
node --test scripts/tests/*.test.mjs   # 55
```

---

## Deployment

**Live at <https://parkcast.tpe-dev.workers.dev>** since 2026-09-15, on Cloudflare Workers' **free**
plan with no payment method on the account. The app, the basemap tiles, the label fonts and the place
search index are static assets; the forecast lives in one Workers KV key, which the collector on the
desktop updates after every five-minute reading. Changes are tested on the desktop against the live
forecast before every release, the two-phase deploy never puts the release credential in the same
shell as a test runner, and the collector runs in a hardened, non-root, read-only container. The
map-first redesign shipped in the same way — `deploy:check`, then `deploy:release` with the service
worker's `VERSION` bumped to `v2` so every visitor's cache and shell refresh together. See
[`docs/deploy.md`](docs/deploy.md) for the setup, the everyday workflow, and the runbook.

---

## Basemap

The map tiles are **self-hosted**, not pulled from a keyed provider. Most hobby projects reach for
MapTiler or Mapbox here, but those need an API key and a billing account, and this project has no
server to hide a key behind. Instead, a ~23 MB [Protomaps](https://protomaps.com/) `.pmtiles`
extract covering Taipei is unpacked into 633 static tile files, which the browser fetches directly
(the static host ignores the range requests an archive would need). Street and place names use
self-hosted label fonts, committed under `web/public/basemap/fonts/`.

The extract and its tiles are not committed (regenerable, so they do not belong in git) -- one
command rebuilds both, and also rebuilds the place search index below:

```bash
node scripts/build-basemap.mjs
```

The same tiles also answer place search: `scripts/build-place-index.mjs` reads every named feature
out of them and writes `web/public/places/taipei.json` -- **29,291 rows, 461 KB gzipped** from the
20260914 planet build -- so a query like `忠孝東路四段216巷` resolves with no geocoder, no key, and no
request that leaves the phone. It is git-ignored like the tiles, required by the deploy gate, and
cached cache-first by the service worker once fetched. See [`docs/basemap.md`](docs/basemap.md) for
what the rebuild needs, why it won't download anything for you, how to verify the extractor binary
before running it, and the place index's own section.

---

## Install and offline

ParkCast installs as a PWA and keeps working with no signal — which matters, because the place you
most want it is a basement car park. A cached forecast is not passed off as a live one: every
artifact carries the timestamp of the reading behind it, so the app shows its real age and withdraws
the probability entirely once it is too old to answer the question.

**Offline works from the second visit, not the first.** A service worker does not control the page
that registers it, so the first load has nothing cached behind it. Saying "works offline" without
that clause would be the same kind of overclaim the rest of this app exists to avoid.

The service worker deliberately leaves the 44 MB of basemap tiles alone -- far more than an offline
cache should hold -- so offline you get the full ranked list and whatever tiles the browser's own
cache still has, which is the right half to keep.

The icons are generated, not drawn — `zlib` and `struct`, no image library:

```bash
python scripts/build-icons.py
```

See [`docs/pwa.md`](docs/pwa.md) for the caching rules and their measured caveats.

---

## Data source

Taipei City parking availability and metadata, published by 臺北市政府交通局停車管理工程處 as open
data. No authentication, no API key. ParkCast reads it and adds nothing back.

## Licence

Not yet chosen. Until one is added, default copyright applies — the code is readable but not
licensed for reuse.
