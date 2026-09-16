# State of play — 2026-09-15

Written for a session starting cold. `CLAUDE.md` has the standing facts; this has
**where things are right now, what was just learned, and what to do next**.

---

## Where the project is

Plans 1 through 3e are complete: collector, forecast grid, ranked list, a map-first installable
offline-capable app with place search, and — Plan 3e — no forecast for a car park whose feed has stopped
updating. **355 Python tests (3 skipped) · 288 web TypeScript across 29 files · 66 Worker TypeScript · 50
script tests** (real runs on the `feat/ui-redesign` branch, 2026-09-15; `node --test scripts/tests/*.test.mjs`
needs the explicit glob — a bare directory runs nothing on this Node). **The app is live at
<https://parkcast.tpe-dev.workers.dev>** (Cloudflare Workers Free, since 2026-09-15): the desktop collector
uploads each forecast to one KV key, and the app, the basemap tiles and the label fonts are static assets.
See [`docs/deploy.md`](deploy.md).

The four newest things in this document: the collector's first unbroken days on the desktop turned up
**car parks whose readings never move**, which the app was publishing as certainties; a second and
third evaluation **reversed the first one's verdict** on long horizons; the app is now **map-first**
after a UI/UX redesign shipped the same day as deployment — see "UI redesign — 2026-09-15" below; and
a **nationwide collector** for five more cities is code-complete and tested on a branch, not yet live
— see "Nationwide collection" below.

## Which machine is which

| | |
|---|---|
| **Desktop** | **The collector. Authoritative `data/`.** Clone at `D:\Projects\ParkCast` — not in OneDrive, deliberately. Runs 24/7 since 2026-09-10. |
| Laptop | Collector stopped and removed. Its `data/` is a **stale fallback**, frozen at 2026-09-10 09:08 Taipei, 64,268 hot rows. |

**Never run two collectors.** Two machines polling the same feed produce two corpora that disagree
about the same day, and there is no merge tool. This is the one unrecoverable mistake in the
project. See [`collector-move.md`](collector-move.md), which now ends with what the move measured.

A dated zip of the laptop corpus plus a SHA-256 manifest is at `~/Documents/parkcast-move/` on the
laptop. `python scripts/verify-corpus.py` checks a copy against the manifest — a **corrupted SQLite
file passes `PRAGMA integrity_check` and returns the right row count**, so the hash is not paranoia.

**Plan 3e has been live on the collector since 2026-09-14 09:06.** It was rebuilt from `a41539a` and
recreated just after a tick: no tick was missed (the next reading landed exactly 300 s after the last
one, whose 1,165 rows were intact), and the first publish read `published 1090 lots x 24 horizons,
112 not updating`. A container keeps the image it was started with, so after any future change deploy
with `docker compose -f docker/docker-compose.yml up -d --build --force-recreate` and check the
publish log line for the new behaviour.

## Working on a machine that is not the collector

The two artifacts the app reads expire after ~115 minutes by design, so a dev machine without a
collector shows the "forecast too old" state. Fix it with:

    python scripts/refresh-demo-artifacts.py

One live feed reading, scored against the local corpus, written to `web/.dev-artifacts/`. It
operates on a throwaway copy of `hot.sqlite` and **cannot fork the corpus** — verified after the
first run by re-checking all 16 files against the manifest.

---

## The desktop's first days

| day | slots of 288 | |
|---|---|---|
| 2026-09-10 | 170 | 14 on the laptop that morning, then unbroken from 11:03 |
| 2026-09-11 | 287 | the missing reading, 18:53, was never published by the city |
| 2026-09-12 | **288** | |
| 2026-09-13 | 262 | 26 slots lost to a **Docker Desktop Pause click**, 21:26–23:44 |

Coverage through 09-13 is **1,687 of 2,880 slots, 58.6%**, up from 34.4% at the move; 12:00–14:30
went from one collected day in six to five in ten. No restart, no host sleep, poll lag median 210 s.

**The only real gap was a person.** A paused container never exits, so `restart: unless-stopped`
cannot see it, and the collector logs nothing — its log jumps from the 21:26 tick to the 23:44 one.
Found in Docker Desktop's UI log (`composePauseClicked`), after ruling out a host sleep by comparing
the Docker VM's `/proc/uptime` against wall-clock time. The stack shows in the dashboard as `docker`.

---

## Frozen feeds — found 2026-09-13, fixed in Plan 3e

Over 82.4 unbroken hours, **92 car parks did not change their reading once.** The app published the
40 stuck at 0 free as a **0%** chance of a space and the rest as **100%**; for 3–4% of destinations
its top recommendation was one of them. 陽明山花鐘停車場 reported all 34 spaces free all weekend.

**Plan 3e** (`src/parkcast/liveness.py`): a car park whose readings have been identical for **24 h**
(with readings on at least half of that run's slots), or that has sent **no reading for 24 h**, is
published with **no forecast** — every grid cell `UNKNOWN` — and `lots.json` carries `"u"`, its last
update. The app shows it grey on the map and, when it is near the destination, in the list after
every lot with a forecast, as **"Not updating · No change in N h"** / **"資料未更新 · 已 N 小時未變動"**.
Recomputed at every publish; a car park rejoins on the tick its reading moves. The backtest replays
the same rule at each origin and scores only what the app would have published.

Measured on a snapshot at 2026-09-14 01:13: **133 of 1,090** published lots withheld — 49 stuck at a
mid value, 46 at 0, 23 at capacity, 15 silent — every other grid row byte-identical to before, the
rule costing 0.22 s a publish.

Two things it deliberately did not do, both measured and written up in `CLAUDE.md`:

- **It did not reuse `report.find_frozen_lots`.** That flags ~45% of lots on a full day, because a
  quiet night is a 6-hour run. Its daily "frozen" count is noise.
- **It did not remove frozen lots from climatology.** They hold the citywide prior at 0.8852 instead
  of 0.9238; fixing that means rebuilding the per-Parquet counter cache. Deferred.

---

## The ranked list's tail — fixed 2026-09-14

For a Shilin destination the list put a car park at **2%, 5.9 km away** at #13. The 09-09 cost
model charged a failed attempt the circling penalty and the fallback's cost, but not the drive from
the failed lot to the fallback, so a hopeless lot's score stopped depending on where it was. On the
09:43 grid, **797 of 1,090** destinations had a lot under 50% more than 1.5 km away in their top 20.
The probe gated only first place, which stayed right throughout.

`rank.ts` now charges that drive: `DRIVE_MIN_PER_KM` = 2.4, NT$12 per straight-line km. Those
destinations fell to 366; a lot under 10% more than 3 km away in a top three, 13 → 1; the farthest
top-20 row, 5.49 → 1.66 km median; first place changed for 1 destination. `scripts/probe-ranker.py`
now reports list reach for every model on one grid — see "Ranker calibration" in `CLAUDE.md`. The
app is not deployed and the ranking runs in the browser, so no user saw either version and the
collector was not touched.

---

## The evaluations — read this before touching the model

`python scripts/evaluate-forecast.py` (withholding frozen lots by default; `--include-not-updating`
scores them too). Time-split, walk-forward, leak-free by the train/test contract in `forecast.py`;
24 tests in `tests/test_evaluate.py`, three of which exist to catch a leaked label, two to catch a
withholding decision that could see the future, and one to check that the backtest withholds exactly
what publishing would.

Blend's Brier skill over persistence:

| run | test period | 5 min | 15 | 30 | 60 | 120 |
|---|---|---|---|---|---|---|
| 2026-09-10 | 37 origins to Thu 09-10 09:03, 2.2 days of training, corpus 34% covered | +5.6% | +7.6% | −1.2% | −11.9% | −10.2% |
| 2026-09-13 | 48 origins, Sat 03:28 → Sun 02:58 | +7.4% | +14.5% | +15.8% | +15.6% | +20.6% |
| **2026-09-14** | 48 origins, Sat 04:33 → Sun 04:03, frozen lots withheld | **+6.9%** | **+14.4%** | **+16.6%** | **+16.3%** | **+21.9%** |
| 2026-09-14, 256 hard lots | same | +6.7% | +12.1% | +10.0% | +5.4% | +8.2% |

The 09-14 run: 231,536 predictions per forecaster, 26,335 labels withheld, base rate 0.899;
citywide Brier persistence 0.0557, climatology 0.0680, blend 0.0462.

### The reversal, and what it is not

**The 09-10 finding — blend worse than persistence beyond 30 minutes — did not reproduce.** The test
periods differ in days and hours, so this is a second sample pointing the other way, not a
before-and-after of the method; none of these numbers is a confidence interval.

**Why it moved is not established.** In the 09-13 run every daytime prediction had zero observations
behind its bucket (the only earlier Saturday, 09-05, was collected overnight only), and every
supported one fell at night — so support and time of day are confounded there. What was measured: in
daytime, with zero support, blend still beat persistence by **+15.8% to +17.6%** — consistent with
the gain coming from each lot's own rate, which three unbroken days filled in, though no ablation
compared the runs, so that is an inference. Support matters within a run (09-14: bucket n = 0 → Brier
0.1013; 1–5 → 0.0509; 6–19 → 0.0157).

### Calibration

Sound where the mass is: the 0.9–1.0 band holds 198,024 of 231,536 predictions and says 0.986 against
0.976 observed. **Overconfident in the middle**: 0.6–0.7 says 0.657 and happens 0.520, 0.8–0.9 says
0.862 and happens 0.791. Withholding frozen lots emptied most of the 0.0–0.1 band — 17,170
predictions there when they are scored, 5,910 when they are not — and what is left says 0.070 and
happens 0.105.

---

## UI redesign — 2026-09-15

The working but plain page became **map-first**: a full-screen MapLibre map under a frosted bottom
sheet on phone (`peek` / `half` / `full` snap points, drag or the grip button) or a 420 px side panel
plus floating locate/language buttons on desktop (≥ 768 px) — one `Shell.tsx`, one media query
(`layout/useMediaQuery.ts`), the sheet and panel sharing the same content component. Three product
changes rode along: **place search** (an offline index built from the basemap tiles — car parks, MRT
stations, landmarks, streets and lanes, neighbourhoods — no geocoder, no key, nothing leaves the
phone); **arrival as a clock time** ("18:35", not "in 15 min") within the forecast's existing window,
with the horizon read from the grid now written as `arrival − reading` — the same "+ age" correction
the app always needed, expressed as a subtraction instead of an addition; and **two new card facts**,
the observed free count at the reading (`lots.json`'s new `f` field — live on the collector since
2026-09-15 13:16 Taipei, 1,080 of 1,090 rows carrying it) and a confidence label (High ≤ 30 min from
the reading, Medium ≤ 75, Low beyond, derived from the blend's own 30-minute persistence half-life —
a statement about the model's structure, not a per-lot statistic). Design spec:
[`docs/superpowers/specs/2026-09-15-ui-redesign-design.md`](superpowers/specs/2026-09-15-ui-redesign-design.md).

**Measured on the branch:** 355 Python tests (3 skipped) · 288 web across 29 files · 66 Worker · 50
scripts; typecheck, lint and build all green. The place index
(`scripts/build-place-index.mjs` → `web/public/places/taipei.json`) is **29,291 rows, 461 KB
gzipped** from the 20260914 planet build, against a gate of ≥ 15,000 rows / ≤ 600 KB gz — see "Place
index" in [`docs/basemap.md`](basemap.md). The probability ramp moved to red → amber → teal (never
green, so it stays readable under red-green colour blindness); the service worker's `VERSION` bumped
`v1` → `v2` so every visitor's shell and cache refresh together (`docs/pwa.md`). Removed:
`index.css`, `DestinationSearch.tsx`, `LotRow.tsx`, `Scrubber.tsx`, `search.ts`.

**Not built from §9 / §5.** Five of the spec's animations and two of its behaviours are not in the
shipped build. Each line is what is missing and why:

- **§9 #5, smooth dot recolour** — a `circle-color-transition` so a change of arrival time fades a dot
  between colours. MapLibre does not interpolate data-driven paint properties, so the dots recolour
  instantly regardless. The card's probability ring carries that animation instead: the arc tweens and
  the number counts up.
- **§9 #7, one-shot expand of the selection halo** — the selection halo is static. Only the best pick's
  halo animates (it breathes); a paint tween on selection is a follow-up.
- **§9 #8, pin drop** — the destination pin is a circle layer, not a DOM marker, so there is nothing to
  drop; only the two ripples around it animate.
- **§9 #10, sliding chip highlight and odometer digits** — the arrival chips highlight by a class
  change, and the readout swaps its digits. There is no odometer.
- **§9 #11, confidence pill expand-on-focus** — the pill toggles its explanation line open and shut;
  nothing expands.
- **§5.2, a station's qualifier is not "捷運"** — the group heading and the station icon already say
  what kind of place it is, and the archive's `station` kind covers TRA and HSR stations as well as
  the MRT, which "捷運" would mislabel.
- **§5.3, sweep-to-select on the arrival strip is desktop-only** — `touch-action: pan-x` hands a
  horizontal touch drag to the scroller, so the strip can be scrolled at all; on the phone a tap
  selects.

**§5.6 is built** (added in the review round on the same day): hovering a card haloes that lot's dot on
the map, through a dedicated `lots-hover-halo` layer whose filter is swapped to the hovered id — a
`setFilter` on one layer, never a rebuilt source, because a pointer crossing the list changes it many
times a second.

**Deferred, per the spec's own out-of-scope list (§12):** forecasts beyond the grid's window; a
forecast free-space count; per-lot statistical confidence (today's label is model-structure, not
per-lot); dot clustering; house-number geocoding. Also deferred: re-branding the app icon —
`theme-color` and the manifest icons stay `#1d5fd0` because the generated icons still carry that
accent, and recolouring one without the other would be a worse mismatch than the current colour.

**Closed in the review round.** `PlaceSearch`'s `loading` flag no longer sticks when the box blurs
mid-fetch — the effect's cleanup resets it, so the next focus retries the place index instead of
searching the in-memory roster alone for the rest of the session. The spec's 44 px tap floor (§2) is
met everywhere as well: the sheet's grip, the arrival chips, the search box's clear button and the
notice buttons are 44 px in the box, and the confidence pill keeps its small visual size with a
transparent pseudo-element carrying the target.

---

## Nationwide collection — built 2026-09-16 on `feat/nationwide-collector`, not yet live

Twelve tasks against [`docs/superpowers/specs/2026-09-16-nationwide-collector-design.md`](superpowers/specs/2026-09-16-nationwide-collector-design.md)
took the collector from one feed to six: 臺北市, 新北市, 高雄市, 臺南市, 桃園市, 新竹市, each behind its
own adapter under `src/parkcast/sources/` (`CLAUDE.md`'s "The nationwide collector" section; per-feed
detail in the new [`docs/sources.md`](sources.md)). It is code-complete and tested on the branch —
**527 Python tests, 3 skipped**, measured by running `./.venv/Scripts/python.exe -m pytest -q` in
this worktree. The web, Worker and script suites are untouched by this branch and could not be run
here (a fresh worktree has no `node_modules` in `web/` or `worker/`), so their figures above —
**288 web · 66 Worker · 50 scripts** — are carried forward from the last real run, unchanged, not
re-measured.

**Nothing about this is live.** The deployed site still serves Taipei alone; the branch adds the
collector and storage side only, per the spec's own scope, and turning cities on is a separate,
staged operation the user runs against the live collector — see "What to do next" below. **Disk
growth is deliberately not asserted here.** The spec's 150–400 MB/month estimate for the new load is
explicitly the weakest number in it and is measured, not guessed, during the rollout: run New Taipei
alone for a day, read the real `data/cold/` Parquet size, and extrapolate before turning the rest on.

**Two things nearly reached production wrong, and both are the same shape of mistake.** A fixture
that builds both sides of a comparison from the same id can only prove the two sides agree with each
other, not that either is right:

- `metadata.parse_metadata` kept emitting **bare** lot ids for several tasks after
  `Observation.lot_id` became namespaced. Every publish test passed the whole time, because each one
  seeded its lots and its observations from the same bare literal (`_seed(lot="A")` + `_make_lot("A")`) — internally
  consistent, and exactly what production is not. Reached on this branch: publishing would have
  stopped entirely (`lot.id in history.counts.lot` matches nothing once one side is bare and the
  other namespaced), freezing the live site at its last artifact.
- The cold Parquet corpus was namespaced only going forward — every day compacted before this branch
  still holds Taipei's original bare `TPE0001` ids, and always will, because Parquet is never
  rewritten. The fix (`ids.as_stored`, qualifying a bare id on read) needed a **bare** cold fixture to
  even be tested — the tests already in the suite for this exact case wrote *namespaced* cold Parquet
  fixtures, which the real corpus does not and will never contain, so they could not have caught the
  bug they were meant to cover. Reached un-caught: Taipei's per-lot and per-bucket climatology would
  have silently lost the entire pre-namespacing corpus and fallen back toward the citywide rate —
  plausible-looking numbers, quietly wrong, for the one city with real history.

Both were caught in review, not by the suite, and both are now written into `CLAUDE.md`'s
project-specific standards as a general rule for the next test of this shape.

**The hot-store id migration has never run in production.** `store.migrate_to_namespaced_ids` runs
once at startup (`__main__.main`, before anything else touches the store) and rewrites every
pre-namespacing row in the 48-hour hot window to `taipei:<id>` in one transaction. It is idempotent
and deliberately deduplicates a legacy/namespaced pair of the same `(lot_id, data_ts)` by deleting the
legacy copy — it is the same reading, so nothing is lost except that copy's `observed_at`, which was
the more truthful first-sighting time, making `lag` very slightly overstated for those rows. A
failure is logged and collection carries on rather than the process dying. **Before the first boot of
this code in production, back up `data/hot.sqlite`** — see the runbook note in "What to do next".

**The daily report cannot measure per-lot coverage for New Taipei, Tainan or Hsinchu.** Those three
stamp `data_ts` per record rather than per tick, and the hot store's primary key is
`(lot_id, data_ts)`, so a sensor whose reading has not changed writes no new row at all — a healthy
slow sensor and a lot a tick genuinely missed look identical in the stored data. `report.py` says so
explicitly (`tick_based=False`, no `ticks_seen`/`lots_with_gaps` figure) rather than printing a number
that would look like the tick-based cities' but measure something else. Lifting this would need one of
those feeds to distinguish "still reporting the same number" from "not answering," which none of them
do today.

---

## What to do next

1. ~~Deploy Plan 3e to the collector~~ — **done 2026-09-14 09:06**; see "Which machine is which".
2. ~~Fix the prune bug~~ — **done 2026-09-14.** `run_forever` pruned by a fixed cutoff regardless of
   which days had actually archived, so a day whose compaction kept failing could be deleted before it
   ever reached Parquet. The cutoff is now `min(now − HOT_RETENTION_SEC, start of the earliest
   unarchived day)` (`src/parkcast/scheduler.py`; `store.prune` itself is unchanged) — see CLAUDE.md's
   "Deployment (2026-09-14)".
3. ~~Deploy the app to Cloudflare Workers~~ — **live 2026-09-15** at
   <https://parkcast.tpe-dev.workers.dev> (design:
   [`docs/superpowers/specs/2026-09-14-deployment-design.md`](superpowers/specs/2026-09-14-deployment-design.md)).
   Free tier only — Workers + KV, no R2, no custom domain, no payment method on the account. Two things
   only the live release showed are under "Gotchas" below. **Every future release needs a fresh
   short-lived API token from the account owner** — the setup token was to be revoked or left to expire
   ([`docs/deploy.md`](deploy.md) §5).
4. ~~Ship the map-first UI redesign~~ — **done 2026-09-15**; see "UI redesign — 2026-09-15" above
   (design: [`docs/superpowers/specs/2026-09-15-ui-redesign-design.md`](superpowers/specs/2026-09-15-ui-redesign-design.md)).
   The one follow-up it left open — `PlaceSearch`'s `loading` flag sticking when the box blurs
   mid-fetch — was closed in the review round the same day; see above.
5. **Roll out the nationwide collector, live, with the user** — code-complete on
   `feat/nationwide-collector` (see "Nationwide collection" above), but turning it on is a live
   operation against a running collector and a published site, not something to do unattended:
   1. **Back up `data/hot.sqlite`** before the first boot of this code — the id migration has never
      run in production.
   2. `python -m pytest` green, then restart the collector with **Taipei alone** still enabled.
      Confirm the live site is unchanged and `grid.bin` still republishes byte-for-byte.
   3. Enable **New Taipei only**. Let it run a day, then read `data/cold/`'s actual growth and
      compare it against the spec's 150–400 MB/month estimate — the number this plan deliberately
      left unmeasured.
   4. Enable the remaining four, one per tick-cycle, watching the per-source report.
   5. The app keeps showing Taipei only until a following spec teaches it to read the other
      cities' shards — the shards will exist on disk, but nothing reads them yet.
6. **Accumulate, then re-run the evaluation around 2026-10-01**, when every half-hour-of-week bucket
   has three days behind it (at 09-13: 134 of 336 had none, 120 one, 82 two; Tuesday none at all).
7. **Then** consider a trained model — against a persistence baseline that is strong on an
   autocorrelated series, and a blend that now beats it.

Also deferred: removing frozen lots from the climatology counts; retiring or recalibrating
`find_frozen_lots`; compressing the daily metadata snapshots (2.17 MB a day, ~90% of the cold store).
**The support-aware blend proposed on 09-10 is deprioritised** — the loss it targeted did not show up
again.

**Do not cap the horizon slider to make the metric look better.** Deleting a real feature to flatter
a number is the opposite of how this project has handled every other inconvenient measurement.

## Open decisions belonging to the user

- **Licence.** The repo is public with none, so the code is readable but not reusable.

## Gotchas that cost real time

- **A paused container logs nothing and is not restarted.** When coverage shows a gap, check
  `docker inspect -f '{{.State.Paused}}' docker-collector-1` and Docker Desktop's
  `%LOCALAPPDATA%\Docker\log\host\electron-*.log` for `composePauseClicked`. To rule out a host
  sleep, compare the Docker VM's `/proc/uptime` with wall-clock time since Docker Desktop started.
- **Never read `data/` from the host while the collector runs**, and run analyses on a `backup()`
  snapshot in a throwaway container — see "Analysing the corpus while it runs" in
  [`docker/README.md`](../docker/README.md). Under Git Bash, `MSYS_NO_PATHCONV=1` or container paths
  get rewritten.
- **Host Python on the desktop is 3.14 without pytest.** Run the suite in a throwaway
  `docker-collector:latest` container with `src/`, `tests/` and `pyproject.toml` mounted read-only,
  started with `--user 0:0` — the image now runs as uid 10001, which cannot `pip install pytest` or
  create `/work`. Only ever for throwaway containers, never the `collector` service.
- **Docker Desktop's dashboard can show an error dialog while the engine is fine** — on 2026-09-10,
  started after a boot, it sat on a theme-snapshot 404 while `wslengine` was already answering
  `_ping`. Probe the engine (`docker version`), not the window.
- **The Browser pane can report itself visible and still not paint.** `document.hidden` was `false`,
  `visibilityState` `"visible"`, and `requestAnimationFrame` never fired — WebGL stayed blank while
  every DOM assertion passed. Probe with a real `rAF`, not the flag. See `tasks/lessons.md` L006.
- **`python` and `.venv/Scripts/python.exe` are not the same interpreter** on the laptop; only the
  venv has pytest. Check before concluding a dependency is missing.
- **Cold Parquet is slot-snapped** — it stores 288 slots a day and discards the true `data_ts`.
  Reconstruct with `slot_start + 180` (the feed's fixed phase); verified exact against the hot store.
- `restart: unless-stopped` covers exits only — not a sleeping host, and not a pause.
- **Cloudflare refuses Python's default user agent.** The first live upload failed `403` in 0.1 s: the
  edge answers `Python-urllib/3.x` with `error code: 1010` before the Worker runs, so the Worker's own
  code never explains it. Reproduce with an unauthenticated `PUT`: the default agent gets `403`, any
  named agent `401`. The collector now sends `User-Agent: parkcast-collector/1`.
- **Cloudflare's static hosting ignores `Range`.** `curl -H "Range: bytes=0-126"` on a static asset
  returns `200` and the full body, with no `Accept-Ranges`, on every retry. The live map drew no roads
  until the basemap moved from one `.pmtiles` archive to plain tile files (`docs/basemap.md`). The dev
  server answers `206`, so nothing local catches this — check a live range request after changing how
  anything large is served.
- **A minimised Claude app window pauses the live map.** With the window hidden the page reports
  `visibilityState: "hidden"`, MapLibre neither draws nor fetches tiles, and screenshots come back
  blank or grey — which looks exactly like a broken basemap. Bring the window forward before judging.
