# ParkCast / 停車先知 — Design Spec

**Date:** 2026-09-04
**Status:** Approved for planning
**Author:** Jerry Chen (design session with Claude)

---

## 1. Problem

Taipei publishes real-time parking availability for over a thousand lots, and several apps display it. Drivers still complain: *顯示有位，到了就沒了.*

The complaint is correct, and the reason is measurable. The official feed publishes every 5 minutes with a ~3-minute lag, so the number an app shows is already 3–8 minutes old. Nearly half the city's lots change value between ticks. A display of "current availability" is therefore a display of the past.

More fundamentally, 現在有幾位? is the wrong question. A driver 18 minutes away needs to know about their *arrival time*, and needs to choose between options. That is a decision under uncertainty, not a status lookup.

## 2. Thesis

> **Forecast a probability, not a number. Then rank options under that uncertainty.**

Not "台北101 will have 12 spaces at 18:40" — a promise the data cannot support. Instead: 有位機率 34%; 信義廣場 88%, 多走 6 分鐘, 每小時便宜 $20.

A consequence worth stating plainly: because the feed is already stale on arrival, **even answering 有位嗎? correctly right now requires a model.** The nowcast is a staleness correction; the ETA forecast is the same machinery extended. Forecasting is not a feature layered on good data — it is what makes the data usable at all.

## 3. Evidence (measured 2026-09-04, not assumed)

Both Taipei endpoints were probed directly and a 30-sample cadence study was run.

| Property | Measured value |
|---|---|
| Availability endpoint | `tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json` (472 KB, ~0.8 s, no auth) |
| Metadata endpoint | `.../TCMSV_alldesc.json` (2.85 MB, no auth) |
| Lots in metadata | 1,752 |
| Lots with live feed | 1,173 |
| **Usable (valid count + known capacity)** | **1,068** |
| Districts covered | 12 / 12 |
| Mean / median occupancy | 58.8% / 63.0% |
| Lots at zero free spaces | 89 |
| Capacity p10 / p50 / p90 | 8 / 53 / 314 |
| Lots reporting motorcycle data | 466 |
| **Update cadence** | **exactly 5 min** (09:03 → 09:08 → 09:13) |
| **Publish lag** | **3m04s – 3m13s, highly consistent** |
| **Churn per tick** | **452–505 lots (42–47%)** |
| Fetch reliability | 30/30 successful, sub-second |

Cache-busting returned identical payloads, confirming the cadence is the real publish rhythm rather than CDN caching.

**Design consequences.** The consistent lag means the collector should poll on a phase offset (`:03:20, :08:20, :13:20…`), receiving data ~20 s after publication rather than up to 5 minutes later — roughly halving effective staleness at no extra cost. The 42–47% churn drives the storage design in §6.

## 4. Scope

**In (v1):** Taipei City; cars; 1,068 lots; **24 forecast horizons at 5-minute steps, +5 min through +120 min**; destination-based ranked recommendations; citywide map with time-scrubber; public evaluation report.

**Out (v1):** other cities (adapter boundary only), motorcycles, navigation, payments, user accounts, push notifications.

## 5. Architecture

```
  Taipei open data (5-min cadence, 3-min lag)
              │
              ▼
    ┌─────────────────┐
    │   Collector     │  phase-offset poll, validate, delta-write
    └────────┬────────┘
             │
    ┌────────▼────────────────────────────┐
    │  HOT   SQLite, rolling 48h          │  serving + nowcast features
    │  COLD  Parquet, one file per day    │  training corpus
    └────────┬────────────────────────────┘
             │
    ┌────────▼────────┐
    │  Forecast job   │  every 5 min: recompute full grid
    └────────┬────────┘
             │
    ┌────────▼────────────────────────────┐
    │  ARTIFACTS (static)                 │
    │   grid.bin   ~25 KB  1,068 × 24     │  rewritten every 5 min
    │   lots.json  ~300 KB metadata       │  rewritten weekly
    └────────┬────────────────────────────┘
             │  CDN
    ┌────────▼────────────────────────────┐
    │  PWA: ranked list + map + scrubber  │  ranking done client-side
    └─────────────────────────────────────┘
```

### 5.1 Key decision — precompute the grid, never infer at request time

1,068 lots × 24 horizons = 25,632 probabilities, recomputed every 5 minutes. Serving collapses to a static lookup. Three consequences:

- The read path needs no ML runtime and no application server.
- The map's time-scrubber fetches one ~25 KB payload and scrubs client-side with zero network latency.
- Response time is decoupled from model complexity — the model can get better without the app getting slower.

### 5.2 Key decision — no database server, and no API server

The hot store is single-writer, ~300k rows, and read only by the forecast job on the same host. SQLite is correct; a network database buys nothing and costs an ops dependency.

Likewise, the client needs only `grid.bin` + `lots.json`. Ranking, distance and scrubbing are computed locally. **There is no REST API.** The read path is a CDN: free, fast in Taiwan, survives traffic spikes, and the marginal cost per additional user is a CDN hit.

The entire system is files: SQLite → Parquet → static artifacts.

## 6. Data model

**Hot store** (SQLite, rolling 48 h), upsert keyed on `(lot_id, data_ts)` so duplicate fetches are idempotent:

```sql
CREATE TABLE observations (
  lot_id      TEXT    NOT NULL,
  data_ts     INTEGER NOT NULL,  -- epoch sec, from feed UPDATETIME
  observed_at INTEGER NOT NULL,  -- epoch sec, when WE fetched it
  free_car    INTEGER,           -- NULL when feed reports -9
  free_motor  INTEGER,
  quality     INTEGER NOT NULL DEFAULT 0,  -- bitfield, see section 10
  PRIMARY KEY (lot_id, data_ts)
);
```

`data_ts` and `observed_at` are stored **separately, always**. Collapsing them bakes the 3-minute publish lag invisibly into every label.

**Cold store** (Parquet, one file per day): one row per `(lot_id, date)` holding a 288-slot array of observations plus a parallel quality array. ~230 MB/year, and already the shape training wants.

**Metadata** is snapshotted with a validity range, because capacity and lot membership change over time.

## 7. Forecasting

**Target:** `P(free_car >= 1 | lot, arrival_time)` — a probability, never a count.

Labels are directly observed from 5-minute snapshots. No proxy targets, no labeling heuristics.

**Features**

- Current occupancy ratio; lags at 5 / 15 / 30 / 60 min; first differences
- Cyclical minute-of-day; day-of-week
- **Taiwan government calendar including 補班日** — make-up workdays behave like weekdays and will wreck a naive day-of-week feature
- Capacity, lot type (路邊 / 立體 / 地下), district
- Neighborhood occupancy: mean of lots within 500 m, capturing local demand shocks
- Rainfall (CWA open data)
- Forecast horizon `h`, so one model serves all 24 horizons
- **Observation staleness**, so the model widens uncertainty when the feed is late instead of pretending it is not

**Model:** LightGBM binary classifier, then isotonic calibration fitted on a held-out slice.

Deep learning is explicitly rejected. Three weeks of tabular data with strong hand-crafted temporal features is the regime where GBMs win, and inference must recompute 25k predictions every 5 minutes on free-tier compute.

## 8. Evaluation

This section is the centrepiece and is protected from scope cuts.

**Two baselines.**

1. **Persistence** — current value holds.
2. **Climatology** — this lot's historical rate at this time-of-week.

Climatology is the hard one and the one most similar projects quietly omit. Beating both is the bar.

**Splitting.** Strictly by time: train on early days, test on the most recent held-out days. A random split leaks the future into the past through lag features and produces a meaningless number.

**Reported metrics.**

- Brier score
- Brier Skill Score against *each* baseline
- Per-horizon skill curve (skill must decay with horizon; if it does not, something is leaking)
- **Reliability diagram** — the headline artifact. "When it said 70%, it happened 71% of the time" is checkable at a glance.
- Decision-level metric: if a user follows the top recommendation, how often do they find a space?

**Shipping rule.** The model replaces the baseline only if it beats both on held-out data. If it does not, that negative result is reported honestly and the baseline ships. A clean negative result is a mature outcome, not a failure.

## 9. Ranking under uncertainty

```
E[cost] = walk_minutes                        × time_value
        + price_per_hour × expected_hours
        + (1 − P) × circling_penalty_minutes  × time_value
```

The third term converts a probability into a decision.

The UI shows **P, walking time and price as three separate visible columns**. They are never collapsed into a single opaque score — users do not trust magic rankings, and should not.

## 10. Failure modes and data integrity

Project-killers, handled from day one:

1. **`-9` sentinel becomes NULL, never 0.** As a value it means "9 beyond full" and silently poisons training across ~90 lots.
2. **Frozen sensors.** A lot reporting an identical value for hours is more likely broken than static. Undetected, these become confident wrong predictions on exactly the lots users care about. Detector plus quality flag.
3. **Gaps stay gaps.** Missed ticks become explicit NULLs, never interpolated. Interpolated data that looks real is worse than missing data that looks missing.
4. **Distribution shift.** Typhoon days and long holidays are different regimes; flag rather than let three anomalous days distort a three-week training set.

Routine handling: clamp `free_car > totalcar`; lots entering and leaving the feed; capacity changes over time; UTC internally with CST at the edges (Taiwan has no DST); collector clock skew.

**Daily data-quality report:** rows collected, gaps, anomalies, per-lot coverage. This is the difference between running a scraper and operating a pipeline.

## 11. Deployment

- **Static site and artifacts:** Cloudflare Pages (latency in Taiwan, bandwidth, free SSL on custom domain, cache-header control for the 5-minute `grid.bin`). Netlify is an acceptable substitute; GitHub Pages is weakest here.
- **Collector:** the only always-on component. Packaged as Docker Compose so it runs identically on a laptop, a free cloud VM, or a $5 VPS. Host is a config change, not a rewrite. Free-tier terms are verified at deployment time rather than designed around.
- **CI:** GitHub Actions for tests and frontend deploys — its intended use. Explicitly *not* used as a 24/7 polling cron, which is against the spirit of GitHub's terms.

**Stack:** Python 3.13 (collector, compaction, features, training — polars, LightGBM, pyarrow). TypeScript + React + Vite + MapLibre GL + vitest (PWA).

## 12. Plan and cut lines

**Day 1 (~4 h) — the only urgent work.** Spikes, then the collector goes live and stays live: fetch into SQLite, `data_ts`/`observed_at` separated, idempotent upsert, sentinel to NULL, phase-offset polling, quality logging. Everything else can slip a week; this cannot, because every day it is not running is a training day that cannot be recovered.

**Week 1 (~14 h) — pipeline and honest baselines.** Daily Parquet compaction; data-quality report; persistence and climatology implemented as the first forecast backend; grid generation and artifact publishing; frontend skeleton. Tests for sentinels, duplicate ticks, and gaps.

**Week 2 (~14 h) — the product, complete.** Destination input (map pin, GPS, bundled POI index); expected-cost ranker; ranked list; time-scrubber; PWA; mobile layout; zh/en. Deploy.

> **Cut line 1.** The site is live and genuinely useful here, on baselines alone — the staleness correction already beats what existing apps display. If work stops at this point, the project is complete and defensible.

**Week 3 (~14 h) — the model.** Feature engineering; backtest harness with time-based splits; LightGBM; isotonic calibration; comparison against both baselines. Ships only if it wins.

**Week 4 (~12 h) — credibility.** Public evaluation page on the site itself (reliability diagram, per-horizon skill curves, baseline comparison); frozen-sensor detection; collector health monitoring; README methodology; demo GIF.

> **Cut line 2.** The evaluation page is defended hardest. It is the difference between "a parking app" and "a forecasting system, with proof."

## 13. Roadmap (explicitly not v1)

機車 (the 466 lots reporting it) · other cities via the adapter boundary (新北 / 台中 / 高雄) · route-aware suggestions, i.e. lots along the way · push alerts · historical pattern browsing · **user feedback loop** — asking *did you actually find a space?* would yield ground truth the open data cannot provide, and is the most interesting v2 direction.

## 14. Open questions to resolve before or during implementation

1. Feed reliability overnight and at weekends (24 h observation; free, since the collector will already be running).
2. CWA weather data format and availability.
3. A source for the Taiwan government calendar that includes 補班日.
4. Current free-VM terms for the collector host.
5. Whether churn stays near 45% overnight (the storage estimate depends on it).

## 15. Success criteria

- Collector uptime at or above 99% across three weeks.
- Model beats **climatology** on Brier Skill Score at horizons of 60 min or less — or an honestly reported negative result.
- Calibration within ±5% of the diagonal across the 20–80% probability band.
- Site loads in under 1.5 s on Taipei 4G.
- Scrub and rank interactions under 50 ms (client-side, no network).
