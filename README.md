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

Running continuously since 2026-09-04. Live figures at the time of writing:

| | |
|---|---|
| Observations collected | **521,368** across 445 five-minute ticks |
| Lots forecast every 5 min | **1,088** × 24 horizons (+5 to +120 min) |
| Lots with a parsed price | **97.5%** |
| Published payload | **33 KB gzipped**, both files |
| Tests | **250** Python · **53** TypeScript |

Plans 1, 2, 2b, 3a and 3b are complete. The map, time-scrubber and PWA install (3c) and the trained
model with its evaluation (4) are still to come.

---

## How it works

```
Taipei open data ──▶ collector ──▶ SQLite (hot, 48h) ──▶ Parquet (cold, daily)
   every 5 min                            │
                                          ▼
                              forecast ──▶ grid.bin  (26 KB)  every 5 min
                                       └─▶ lots.json (186 KB) on roster change
                                          │
                                          ▼  CDN
                                   browser: ranking, distance,
                                   time-scrubbing, language
```

**There is no API server, and no database server.** The whole read path is two static files. The
browser downloads them once and does the ranking locally, so serving costs nothing, cannot fall over
under load, and the marginal cost of another user is a CDN hit.

Three decisions make that possible:

- **Precompute the grid.** 1,088 lots × 24 horizons is only 26,112 probabilities. Recomputing all of
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

---

## Honest limitations

These are the parts most worth reading.

**The corpus has time-correlated gaps.** The collector runs on a laptop, not a cloud host — a
deliberate choice under a hard no-cost, no-new-attack-surface constraint. When the machine sleeps,
collection stops. 2026-09-05 lost ~10.7 hours that way. Those gaps are **not random**: hours the
machine is habitually asleep will have thin or empty climatology buckets, so the evaluation must
report per-bucket support alongside any skill number.

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

**No model yet.** Everything above ships on baselines. The trained model replaces them only if it
beats *both* on time-split held-out data — and if it does not, that negative result gets published
as-is.

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
python -m pytest          # 250
npm test --prefix web     # 53
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

## Data source

Taipei City parking availability and metadata, published by 臺北市政府交通局停車管理工程處 as open
data. No authentication, no API key. ParkCast reads it and adds nothing back.

## Licence

Not yet chosen. Until one is added, default copyright applies — the code is readable but not
licensed for reuse.
