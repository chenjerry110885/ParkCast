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
| Lots that change between ticks | **42–47%** |

So the number an app shows you is already **3–8 minutes old**, and nearly half the city changed
while you were reading it. A display of "current availability" is a display of the past.

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

Collecting since 2026-09-04, **though not continuously — see the limitations below.** Figures at
the time of writing:

| | |
|---|---|
| Observations collected | **749,102**, across 640 five-minute ticks |
| Collection coverage | **37%** of elapsed time (`python scripts/corpus-coverage.py`) |
| Lots forecast every 5 min | **1,077** × 24 horizons (+5 to +120 min) |
| Lots with a parsed price | **97.8%** |
| Published payload | **33 KB gzipped**, both files |
| Tests | **258** Python · **186** TypeScript |

Plans 1 through 3d are complete: the collector, the forecast grid, the ranked list, the map and
time-scrubber, search, and an installable offline-capable app. The trained model and its evaluation
(Plan 4) are still to come, and need weeks of collected data before a comparison means anything.

---

## How it works

```
Taipei open data ──▶ collector ──▶ SQLite (hot, 48h) ──▶ Parquet (cold, daily)
   every 5 min                            │
                                          ▼
                              forecast ──▶ grid.bin  (26 KB)  every 5 min
                                       └─▶ lots.json (183 KB) on roster change
                                          │
                                          ▼  CDN
                                   browser: ranking, distance,
                                   time-scrubbing, language
```

**There is no API server, and no database server.** The whole read path is two static files. The
browser downloads them once and does the ranking locally, so serving costs nothing, cannot fall over
under load, and the marginal cost of another user is a CDN hit.

Three decisions make that possible:

- **Precompute the grid.** 1,075 lots × 24 horizons is only 25,800 probabilities. Recomputing all of
  them every five minutes turns serving into a static lookup — no ML runtime at request time, and
  the model can get better without the app getting slower.
- **Hot/cold storage split.** SQLite keeps a rolling 48 hours for serving; each completed day is
  rolled into a compressed Parquet file. About 230 MB per year.
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

### Ranking

A probability is not yet an answer. The ranker turns one into a decision by scoring each car park
as the **expected cost of the whole trip**, in NT$:

```
cost  =  p x (walk + fare)  +  (1 - p) x (circling + cost of the best reliable alternative)
```

You do not pay a car park's fare for a space it did not have, and arriving to find it full costs
more than the time spent circling — you still have to get somewhere that has one, and pay for it.
That second half is derived from the roster being ranked rather than tuned, so failing in a dense
district costs less than failing in a sparse one.

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

---

## Honest limitations

These are the parts most worth reading.

**The corpus has time-correlated gaps, and they are worse than "some missing data".** The
collector runs on a laptop, not a cloud host — a deliberate choice under a hard no-cost,
no-new-attack-surface constraint. When the machine sleeps, collection stops. Measured over the
first six days:

```
2026-09-04     66/288   23%  .....................................###########
2026-09-05    158/288   55%  #+####+###########+.....................########
2026-09-06    287/288  100%  ######+#########################################
2026-09-07    128/288   44%  ######+######..+###+###+........................
2026-09-08      0/288    0%  ................................................
```

**37% of elapsed five-minute slots.** One whole day missing. And the gaps are emphatically not
random: **12:00–14:30 was collected on one day in six** — the lunch-and-errands window, which is
exactly when a driver most wants this app and when parking is most contested.

That is a sampling problem, not a volume problem, and no amount of further collection fixes the
part already lost. Any evaluation has to report per-bucket support next to its skill number, and a
citywide average that quietly leans on the hours that *were* collected would be a much prettier
number than the data supports. `python scripts/corpus-coverage.py` regenerates the table above.

**The target is saturated.** 85–92% of lots have a space at any given hour. A citywide Brier score is
therefore dominated by easy cases, and climatology is a genuinely strong baseline. Any model claim
has to beat *climatology*, not just persistence, and report skill on the hard subset — lots at or
near capacity — or the evaluation flatters itself.

**Prices are parsed from Chinese prose, and 2.5% cannot be.** The feed gives one free-text string per
lot covering hourly rates, per-entry fees, monthly rentals and several vehicle classes at once.
Where the rate genuinely varies by weekday, hour or event, the text does not expose the conditions
structurally — so ParkCast shows a **range** rather than resolving a tier and confidently showing a
weekday price on a Sunday. Lots it cannot price show **"price unknown"** and no number at all: a
wrong price is worse than no price.

**No model yet, and the baselines have now been measured.** `scripts/evaluate-forecast.py` runs a
leak-free, time-split, walk-forward backtest. First result (2026-09-10): the shipped blend beats
both baselines out to about 15 minutes — **+7.6% Brier skill over persistence at the app's default
horizon** — and is *worse* than persistence beyond 30 minutes.

The cause is measurable rather than mysterious: not one prediction had six or more training
observations behind its climatology bucket, because buckets are 30-minutes-of-*week* and the
training window was 2.2 days. **Climatology cannot work on less than a week of data.** The number
to re-run, not to defend — and it is published here before it is flattering, which was the point of
protecting the evaluation from scope cuts.

---

## Running it

**Collector** (Python 3.13, Docker):

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

It polls on the feed's publish phase — minute ≡1 (mod 5), second 30 — so it reads new data about
twenty seconds after it appears rather than up to five minutes later.

**Web app** (Node 22):

```bash
node scripts/sync-artifacts.mjs   # copy artifacts for local dev
npm run dev --prefix web
```

**Tests:**

```bash
python -m pytest          # 258
npm test --prefix web     # 186
```

---

## Basemap

The map tiles are **self-hosted**, not pulled from a keyed provider. Most hobby projects reach for
MapTiler or Mapbox here, but those need an API key and a billing account, and this project has no
server to hide a key behind. Instead, a ~23 MB [Protomaps](https://protomaps.com/) `.pmtiles`
archive covering Taipei is served as a static file and read by the browser via range request.

It is not committed (regenerable, so it does not belong in git) -- one command rebuilds it:

```bash
node scripts/build-basemap.mjs
```

See [`docs/basemap.md`](docs/basemap.md) for what it needs, why it won't download anything for you,
and how to verify the extractor binary before running it.

---

## Install and offline

ParkCast installs as a PWA and keeps working with no signal — which matters, because the place you
most want it is a basement car park. A cached forecast is not passed off as a live one: every
artifact carries the timestamp of the reading behind it, so the app shows its real age and withdraws
the probability entirely once it is too old to answer the question.

**Offline works from the second visit, not the first.** A service worker does not control the page
that registers it, so the first load has nothing cached behind it. Saying "works offline" without
that clause would be the same kind of overclaim the rest of this app exists to avoid.

The service worker deliberately leaves the 23 MB basemap alone: it is read by HTTP range request,
and caching partial responses is a well-known way to serve corrupt tiles. Offline you get the full
ranked list and no map tiles, which is the right half to keep.

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
