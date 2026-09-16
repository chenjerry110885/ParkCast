# The nationwide collector — many cities, one corpus

**Status:** proposed, 2026-09-16
**Research:** [`docs/research/2026-09-16-city-parking-feeds.md`](../../research/2026-09-16-city-parking-feeds.md) — every endpoint, field name and sentinel below was verified live on 2026-09-16
**Sibling:** [`2026-09-16-stage-a-any-time-arrival-design.md`](2026-09-16-stage-a-any-time-arrival-design.md) (independent; either can ship first)

## 1. Goal

Collect parking availability for as much of Taiwan as free data allows, so that when Stage B trains a model there is a corpus worth training on — and so a driver outside Taipei gets an answer at all.

This spec covers **collection and storage only**. Showing other cities in the app, and showing 機車 on a card, are the next spec: the corpus has to exist before the UI can be honest about it.

**Nine cities have free, no-key, real-time off-street feeds.** Six of those report exact car counts in JSON and are in scope here:

| City | Lots | Live car counts | Live 機車 counts |
|---|---|---|---|
| 臺北市 | 1,165 | yes | **yes** (471 lots) |
| 新北市 | 3,824 | yes (1,920) | no — capacity only |
| 高雄市 | 1,447 | yes | **yes** (120 lots) |
| 臺南市 | 268 | yes | **yes** (20 lots) |
| 桃園市 | 246 | yes | no |
| 新竹市 | 55 | yes | **yes** (17 lots) |

Roughly **7,000 lots, ~5,000 reporting live** — against 1,090 today.

**Deliberately excluded.** 臺中市: its `AvailableCarRGB` / `AvailableMotorRGB` are traffic-light colours, never counts; storing a three-level status in an integer column would quietly poison the corpus. 基隆市 and 嘉義市: real live data, but server-rendered HTML with no lot id, coordinates or capacity — scraping worth doing only once the JSON cities are in. On-street 路邊停車格 everywhere: a different data model.

## 2. Constraints

- **Free only.** No paid tier, no API key, no account. See the TDX arithmetic in the research doc.
- **Be a good guest.** One request per city per tick, a `parkcast-collector/1` User-Agent, and back-off on failure. Two of these endpoints are a city's own map backend rather than a published dataset; they get the same courtesy as an open-data file, and cadence no faster than the data changes.
- **A failing city must not disturb the others**, and must not disturb Taipei, which is the only corpus we have.
- The collector keeps running on the desktop. No cloud, no new dependency (`pyproj` is already present for the one city that needs a projection).
- Honesty rules are downstream but bind the storage: a lot that is not reporting must be distinguishable from a lot reporting zero.

## 3. Sources

`collector.py` currently hard-codes one URL. It gains a `Source` protocol:

```python
class Source(Protocol):
    city: str                       # "taipei", "newtaipei", ...
    def fetch(self) -> FeedSnapshot: ...
```

One adapter per city, each owning exactly three things its neighbours must not know about: **its transport** (Taipei and Taoyuan are a plain GET; New Taipei and Kaohsiung are a POST, New Taipei needing an explicit `Content-Length: 0` or the server answers 411), **its field names**, and **its not-reporting sentinel** — which differs per city: Taipei `-9`, New Taipei `-1`/`-2` *and* JSON `null`, Kaohsiung `-1`/`-2`. Every adapter normalises those to Python `None`, and `None` is the only representation of "not reporting" that reaches the store.

Adapters are pure functions of bytes to `FeedSnapshot` wherever possible, so each city's quirks are tested against a recorded fixture with no network.

### Timestamps

Taipei publishes one `UPDATETIME` for the whole feed. New Taipei stamps **every record** (`recdate` `1150916` ROC + `rectime` `094529`). Kaohsiung stamps none at all.

So `data_ts` becomes **per observation, not per tick**: the adapter supplies it per lot where the feed does, falls back to the feed-level timestamp where there is one, and to the fetch time where there is none — recording which of the three it was, because a fetch-time stamp is an assumption and the model must be able to exclude it later.

The `observations` table already keys on `(lot_id, data_ts)`, so this is a widening, not a migration.

## 4. Identity

Lot ids are namespaced `"{city}:{feed id}"` — `taipei:TPE0001`, `newtaipei:010001`, `kaohsiung:PL_KHB00035`. Two cities can and do use bare numeric ids.

**Taipei's existing ids migrate once**, in a single transaction with a verified row count before and after, so eleven days of history stay attached. A `sources` table records each city's first and last observation, so a corpus reader can tell "this lot had no spaces" from "this city was not being collected yet" — the distinction that makes a walk-forward backtest honest.

## 5. What this forces: per-city artifacts

Today `grid.bin` carries a single `base_data_ts` — "the reading", one timestamp for the whole publication. With six cities on their own clocks that number stops existing, and any single value we invented would mislabel every card's "9 分鐘前" in five cities out of six.

So publishing shards by city: `lots-{city}.json`, `grid-{city}.bin`, each with its own roster, its own `base_data_ts`, and its own `MIN_PUBLISH_LOT_FRACTION` floor. A city whose feed dies stops republishing **on its own**, without holding back the others or tripping the floor for everyone.

This also happens to be what the app needs — it loads the shard for the region in view rather than 7,000 lots at once — but the reason it is in this spec is that a single honest reading timestamp no longer exists.

`publish_artifacts` becomes per city, driven by the `sources` table. A separate `cities.json` index lists each shard with its bounding box, so the app can tell which shard covers where the driver is looking.

## 6. Storage

Per tick: ~5,000 rows against ~1,000 today. At a five-minute cadence that is 1.44M rows/day; the hot SQLite store already holds two hours and compacts to daily Parquet, whose per-lot arrays compress well. Estimate **150–400 MB/month**, a few GB a year, on `D:`.

The estimate is the weakest number in this spec, so the plan measures it: run one city for a day, read the actual Parquet size, and extrapolate before turning the rest on. If the real figure exceeds 1 GB/month, the response is a longer cadence for the smaller cities, not a smaller corpus.

`free_motor` already exists in the schema and in the cold Parquet — the four cities with live motorcycle counts fill a column that has been there since day one.

## 7. Quality and liveness

`liveness.not_updating` already withholds a forecast from a lot whose readings never move; it is per lot and needs no change. What is new is **per-source health**: a city that returns HTTP 200 with a stale or empty payload should be visible as such. Each tick records, per city: rows fetched, rows with a usable count, the newest timestamp seen, and the outcome. `report.py` gains a per-city line.

A source that fails is retried with the existing back-off and never blocks the tick; three consecutive failures are logged loudly enough for a human to notice without stopping the collector.

## 8. Cadence

Five minutes for all six, matching Taipei's today — each city's own data moves on a one-to-three-minute cycle, so five minutes never asks for the same bytes twice, and six requests per tick is one every fifty seconds.

## 9. Rollout

1. **Adapters against fixtures** — no network, no schema change. Each city's recorded payload parses to the right counts, with its own sentinel mapped to `None`.
2. **Namespacing and the Taipei migration** — verified row counts, reversible.
3. **Per-city artifacts** — publish Taipei alone through the new sharded path; the live site must not change by one byte.
4. **One city on** (New Taipei: biggest, per-record timestamps, no motorcycle to complicate it). Measure disk for a day.
5. **The rest on**, one per tick-cycle, watching per-source health.
6. **App** — the next spec.

Steps 1–3 change no published output. Step 3 is the one to be careful about: it rewrites the publishing path under a live site, so its test is that Taipei's shard is byte-identical to today's artifacts.

## 10. Tests

- Per adapter: a recorded fixture parses to known counts; the city's sentinel becomes `None`; a truncated or empty payload raises rather than writing partial data.
- Timestamps: per-record, feed-level and fetch-time paths each produce the right `data_ts` and record which kind it was.
- Namespacing: the Taipei migration preserves row count and history; a bare feed id from two cities cannot collide.
- Sharding: Taipei's shard is byte-identical to the pre-change artifact for the same input; a city with no fresh data does not republish; one city's empty publish does not affect another's.
- Health: a source returning 200-with-stale-data is reported unhealthy, not silently accepted.
- Storage: the measured Parquet size for one day of one city is recorded in the plan, not asserted in a test.

## 11. Out of scope

The app (city shards in the UI, 機車 on cards, viewport rendering); Taichung, Keelung and Chiayi; on-street parking; any change to the forecaster; TDX.
