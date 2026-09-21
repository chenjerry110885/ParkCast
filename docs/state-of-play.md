# State of play — 2026-09-17

Written for a session starting cold. `CLAUDE.md` has the standing facts; this has
**where things are right now, what was just learned, and what to do next**.

---

## Where the project is

Plans 1 through 3e are complete: collector, forecast grid, ranked list, a map-first installable
offline-capable app with place search, and — Plan 3e — no forecast for a car park whose feed has stopped
updating. **355 Python tests (3 skipped) · 288 web TypeScript across 29 files · 66 Worker TypeScript · 50
script tests** (real runs on the `feat/ui-redesign` branch, 2026-09-15; `node --test scripts/tests/*.test.mjs`
needs the explicit glob — a bare directory runs nothing on this Node; **Stage A's own, newer counts are
below**). **The app is live at <https://parkcast.tpe-dev.workers.dev>** (Cloudflare Workers Free, since
2026-09-15): the desktop collector uploads each forecast to one KV key, and the app, the basemap tiles and
the label fonts are static assets. See [`docs/deploy.md`](deploy.md).

The five newest things in this document: the collector's first unbroken days on the desktop turned up
**car parks whose readings never move**, which the app was publishing as certainties; a second and
third evaluation **reversed the first one's verdict** on long horizons; the app is now **map-first**
after a UI/UX redesign shipped the same day as deployment — see "UI redesign — 2026-09-15" below; the
**nationwide collector** has been live on the desktop since 2026-09-17, polling six cities and
publishing 2,852 lots — see "Nationwide collection" below; and **Stage A** lets the app answer any
arrival within seven days instead of only the next two hours, and turns the confidence label into a
statement about how much history backs a forecast rather than how far away it is — merged to `main`
on 2026-09-17, **not yet deployed** — see "Stage A" below.

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
29 tests in `tests/test_evaluate.py`, three of which exist to catch a leaked label, two to catch a
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

**Deferred, per the spec's own out-of-scope list (§12):** forecasts beyond the grid's window
(built by Stage A; see "Stage A" below); a forecast free-space count; per-lot statistical
confidence (true when this shipped — Stage A replaced the distance-only label with one graded on
evidence, itself per-lot; see below); dot clustering; house-number geocoding. Also deferred:
re-branding the app icon —
`theme-color` and the manifest icons stay `#1d5fd0` because the generated icons still carry that
accent, and recolouring one without the other would be a worse mismatch than the current colour.

**Closed in the review round.** `PlaceSearch`'s `loading` flag no longer sticks when the box blurs
mid-fetch — the effect's cleanup resets it, so the next focus retries the place index instead of
searching the in-memory roster alone for the rest of the session. The spec's 44 px tap floor (§2) is
met everywhere as well: the sheet's grip, the arrival chips, the search box's clear button and the
notice buttons are 44 px in the box, and the confidence pill keeps its small visual size with a
transparent pseudo-element carrying the target.

---

## Nationwide collection — built 2026-09-16, live on the desktop since 2026-09-17

Twelve tasks against [`docs/superpowers/specs/2026-09-16-nationwide-collector-design.md`](superpowers/specs/2026-09-16-nationwide-collector-design.md)
took the collector from one feed to six: 臺北市, 新北市, 高雄市, 臺南市, 桃園市, 新竹市, each behind its
own adapter under `src/parkcast/sources/` (`CLAUDE.md`'s "The nationwide collector" section; per-feed
detail in the new [`docs/sources.md`](sources.md)). It is code-complete and tested on the branch —
**546 Python tests, 3 skipped**, measured by running `./.venv/Scripts/python.exe -m pytest -q` in
this worktree (527 after the twelve tasks; 546 after the whole-branch review round below). The web, Worker and script suites are untouched by this branch and could not be run
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

**A whole-branch review then found six defects at the seams between tasks**, none of which any
single task's own review could see. All six are fixed on the branch:

| | What it cost |
|---|---|
| **The retry loop had no deadline** | Tuned for one source: with two feeds hanging, a slot ran to ~390 s, `next_poll_ts` skipped the following slot, and Taipei — which had succeeded on attempt 1 — polled 12 times in 24 slots, permanently. The loop now stops retrying when the next attempt's worst case would not fit in the slot (`config.SLOT_RESERVE_SEC`). |
| **`data_ts` had no plausibility bound** | Live: 16 of 268 Tainan records stamped over 48 h old, worst by 2.3 years, inserting and pruning in the same slot. One future stamp pins a city's `latest_data_ts` forever. Now bounded to `now − 48 h … now + 15 min` at `collect_once` — see [`sources.md`](sources.md). |
| **The other five cities never published** | `_lots` came only from Taipei's metadata blob; each tick's roster was used for capacities and discarded, so `cities.json` and every `grid-{city}.bin` were dead code outside tests. Rosters now ride `TickResult.lots` through `run_forever` to publishing, and a failed fetch keeps the city's last good roster. |
| **The source-health columns were swapped** | `first_ts` held a data clock and `last_ts` the collector's, so `report.py` aged the poll time (~0 on every success) and a week-old frozen payload printed `ok`. |
| **A failed migration silently switched off withholding** | The log called it "precision"; measured, `liveness.not_updating` returns `{}` for a Taipei lot frozen 48 h, so stuck sensors publish as certainties again for about a day. Comment and log message corrected. |
| **The staged rollout had no mechanism** | `PARKCAST_CITIES` now selects the enabled cities, validated and logged at boot; default is all six. |

Two further findings are **recorded and deliberately not fixed** — `evaluate.py`'s missing per-city
scoping and `liveness`'s Taipei-cadence constants. A third, TLS verification failing for three of six
feeds, **was fixed on 2026-09-17**: all six now verify from inside the container, each by the
narrowest per-source policy that works, with no feed fetched unverified. See "Known limits" in
[`docs/sources.md`](sources.md) and the rollout checklist below.

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

## Stage A: any-time arrival — built 2026-09-16 → 2026-09-17, merged to `main`, not yet deployed

`grid.bin` forecasts 120 minutes ahead; the picker let a driver ask about tomorrow evening anyway,
and `horizonColumn` quietly clamped that to the +120-minute column and presented it as the answer.
Stage A adds a second artifact, `week.bin` — a per-lot, per-half-hour-of-week climatology table,
rebuilt once a day — so the app can answer any arrival up to seven days out for real, and a new
`ArrivalPicker` (day/hour/minute `<select>`s) replaces the old two-hour-capped chip strip. Full
mechanics, including the seam arithmetic and the Thursday-anchored bucket 0, are in `CLAUDE.md`'s
"Stage A" section; this is the measured numbers.

**Size, measured 2026-09-17 at Taipei's real roster (1,090 lots, from
`web/.dev-artifacts/lots.json`), via `scripts/build-dev-week.py`** — which builds a table shaped
exactly like the published one without ever reading `data/`: **732,498 bytes raw (715.3 KiB)**,
exact arithmetic (`18` header bytes `+ 1,090 × 336 buckets × 2`), independent of any particular
climatology. **Gzipped at level 9: 4,206 bytes.** That number is real but optimistic: the script's
synthetic corpus has no day-of-week variation and identical support in every bucket, both of which
compress far better than real history will. A repetition-blind lower bound on the same bytes (the
probability byte's own Shannon entropy, crediting no repeated runs at all) is still only ~167 KB.
Either figure sits comfortably inside the spec's **≤ 600 KB gzipped** gate. If a live table ever
does approach it, the documented fallback is to narrow the *support* byte — never to raise the
gate, and never to narrow the *probability* byte, which the seam tolerance below depends on at
full precision. Confirmed live the same day: `/artifacts/week.bin` on the deployed site answers
`404` — this branch has not shipped.

**The seam.** Inside +120 min the grid answers; beyond it, `week.bin`'s cell for the arrival's own
bucket, blended with the live reading through the same `blend()` the server's `Blend.predict`
uses, answers instead. At exactly +120 min both are defined and `seam.test.ts` requires them to
agree within **1 percentage point** — arithmetic, not slack: the grid's own rounding and the
week cell's rounding (scaled by the blend weight at that horizon) together can reach at most
0.96875 pp of honest disagreement, leaving **0.03125 pp of headroom**. A real bug lands 10–42 pp
outside it.

**Confidence changed meaning.** The High/Medium/Low label used to be pure distance-from-now; it now
grades the evidence behind a forecast — a fresh live reading, or accumulated weeks of history at
that half-hour of the week, whichever is stronger. A lot with a month of Tuesday-21:20 history can
read "high" a day and a half out; a lot nobody has watched at 3 a.m. can read "low" five minutes
out. See `confidence.ts` and `CLAUDE.md`'s Stage A section for the exact bars.

**Test counts, all real runs, 2026-09-17, in this worktree:** `./.venv/Scripts/python.exe -m
pytest -q` → **613 passed, 3 skipped** · `npx vitest run` (`web/`) → **414 passed**, 32 files ·
`npm test` (`worker/`) → **114 passed**, 4 files · `node --test scripts/tests/*.test.mjs` →
**55 passed**. **The Python count is a worktree count, not main's, and that gap is load-bearing.**
Three tests skip wherever `data/` is absent — `tests/test_artifacts_integration.py:36` and
`tests/test_history_bounds.py:39,60`, both `"no collected data on this machine"` — because this
worktree has none. They run in the main checkout. `test_artifacts_integration.py` is the exact
test that caught the id-convention defect at merge on the nationwide-collector branch, and Stage A
also modifies `artifacts.py`, so the green worktree run was necessary and not sufficient. Copying
`data/` into the worktree was never an option — the live collector owns it, and a mid-write
snapshot would make a passing test meaningless.

**That gap is now closed.** After the merge, the suite was re-run in the main checkout, where the
corpus exists: **616 passed, 0 skipped** — the three `data/`-reading tests ran and passed, against
Stage A's code. `npm run deploy:check --prefix worker` passed there too (**bundle check: 711
files**, 0 vulnerabilities); it cannot pass in a worktree, which has never held the gitignored
basemap tiles or place index it verifies.

---

## Scooter and charging on the card — built 2026-09-18 on `fix/map-card-and-amenities`, **not yet deployed, and the deploy is ordered**

`lots.json` gained two more optional keys beside `f`: **`m`**, Taipei's `totalmotor` (scooter /
motorcycle capacity), and **`e`**, its `ChargingStation` (EV charging points). Both come from
`TCMSV_alldesc.json` through `metadata.parse_metadata` → `Lot.capacity_motor` / `Lot.charging` →
`artifacts.build_lots_json`, and both are **Taipei-only today**: the other five cities either report
a *live* motorcycle count under another name (a different fact — occupancy, not capacity) or no
motorcycle field at all, and none has anything resembling `ChargingStation`. Surveyed live
2026-09-18 over 1,773 lots: **395 non-zero `totalmotor`, 662 non-zero `ChargingStation`**. Six
neighbouring metadata fields are uniformly `'0'` across the whole roster and were deliberately not
added — see [`docs/sources.md`](sources.md), which has the full survey.

**Three states per field, not two, and the whole feature rests on the difference.** A count is a
count; **`0` is a measurement** ("we asked, there are none"); **an absent key is not** ("nobody
said"). `quality.clean_count` makes that split at the collector — negative or unparseable → `None`,
a real `0` survives — and unlike `totalcar`, neither field gets the `capacity_car`-style `0 → None`
collapse, because a `0` here carries no second meaning about the lot's own type.
`build_lots_json` writes each key only when it is not `None`, so absent on the wire means absent in
the feed. The web app keeps the same three states from `amenities.reported` through the card's tile
(a `0` renders as "None" in words; an absent field draws no tile at all) to the filter's **two**
hidden counts, which are never summed into one.

**The deploy is ordered: collector first, then the web app.** Checked against production on
2026-09-18, `GET https://parkcast.tpe-dev.workers.dev/artifacts/lots.json` returns 1,089 lots with
**zero `m` and zero `e`** — the app shipped first would read every car park as "nobody said". So:
rebuild and restart the collector, wait for one publish carrying the keys, then release the web app.
The UI no longer *depends* on that ordering — a filter chip is not offered at all while no car park
in the loaded roster reports its field (`amenities.answerable`), so the interim state is simply the
app as it is today, with no chips — but the ordering is still what gets the feature in front of
anyone.

**Looking at the interim state in dev:** `PARKCAST_DEV_NO_AMENITIES=1 npm run dev` in `web/` serves
the local roster with both keys stripped from all 1,089 rows. The dev roster carries both on every
row, so without this neither production nor the dev loop ever reaches the "nobody said" branch.

**The card's geometry is measured now, not declared.** `MAP_CARD_PX = 288` was a constant that had
to track the card's rendered height, and the two extra tiles broke it silently: 289 px at 375 px
wide, 385 px at 360 px where the fact tiles stacked into one column, against a band 428 px tall — so
the dot the card describes was eased to rest *inside* the card. `App.tsx`'s `mapCardDepthPx` asks
the rendered card instead, and `.map-card`'s `max-height` bounds it by the band it shares with its
dot. See "the map's card" in `web/src/styles/components.css`.

---

## Ranking preferences: cheaper, balanced, closer — built 2026-09-18 → 09-19 on `feat/ranking-preferences`, not yet merged or deployed

The owner's own framing — *"some people doesn't care about cost then distance is prioritized"* —
is the whole spec ([`docs/superpowers/specs/2026-09-18-ranking-preferences-design.md`](superpowers/specs/2026-09-18-ranking-preferences-design.md)).
The ranker already turned probability, walk and fare into one NT$ number; a preference is a
different exchange rate for that number, not a new formula.

**The constant that had to split first.** `rank.ts`'s single `TIME_VALUE` priced two different
things at one rate: the walk from a car park to the destination, and the delay of being turned
away (circling, then the drive to a fallback lot). A "cheaper" preset that simply lowered
`TIME_VALUE` would have shrunk the circling penalty along with the walk price — quietly weakening
the availability signal for exactly the driver least likely to notice. So `WALK_VALUE` (moved by a
preference) and `DELAY_VALUE` (derived, `max(5, WALK_VALUE)`) replaced it. `CLAUDE.md`'s "Ranking
preferences" section has the full argument for why that floor, specifically, is the only shape that
does not break one end or the other — worth reading before anyone reaches for a simpler rule.

| Preset | `WALK_VALUE` | `DELAY_VALUE` |
|---|---|---|
| Cheaper | 2 | 5 |
| **Balanced (default, shipped)** | **5** | **5** |
| Closer | 12 | 12 |

**Balanced is the pair the app already shipped with.** A driver who never opens the new control
ranks exactly as they did the day before this feature existed — that is the property that made it
safe to ship, and it is the first thing worth knowing about the feature.

### The safety measurement — read the provenance before the numbers

`scripts/probe-ranker.py` gained a preference sweep that measures the one invariant this feature is
not allowed to break: **no preset may ever put an availability inversion — a car park it believes is
likely full — at the top of the list.** The sweep runs over two samples: 130 car parks under 50%
ranked as their own destination (adversarial), and 700 real places from the offline place index
(realistic).

**The inversion *counts* it reports are a photograph of one roster snapshot, not a property of the
ranker, and must never be quoted without the snapshot they came from.** The design spec's §5
originally quoted counts from an early measurement harness; a 2026-09-19 correction to that section
records why they don't reproduce — the same probe, on code nobody touched, gave Balanced's
adversarial count as 11 on one snapshot and 57 on another taken three hours later, and holding the
code and roster fixed while varying only which forecast column is read swings the same roster's
count from 22 to 84. A number that moves 4× with nothing but the clock is not a constant to defend;
what is durable is the *direction* of each comparison and the `at #1` column.

**Measured here, 2026-09-19:** `./.venv/Scripts/python.exe scripts/probe-ranker.py --artifacts
web/.dev-artifacts`, against `web/.dev-artifacts` — **1,089 lots, roster `2564025264`, generated
2026-09-18 05:31 UTC, column 2 (+15 min)**. Neither the ranker code nor these artifacts changed
since the day before, so this run reproduces that one exactly — itself a small proof of the point
above: the code held still and the numbers held still with it; it is the *roster* that moves them.

**adversarial — 130 lots under 50% at their own position, top 10, reach over all 1,089:**

| preset | walk | delay | inversions | worst | at #1 | far@20 | far@5 | median km | p90 km |
|---|---|---|---|---|---|---|---|---|---|
| cheaper | 2 | 5 | 2 | #7 | **0** | 18 | 0 | 2.40 | 2.87 |
| balanced * | 5 | 5 | 57 | #3 | **0** | 385 | 7 | 1.68 | 2.77 |
| closer | 12 | 12 | 20 | #4 | **0** | 191 | 6 | 1.31 | 2.03 |

**realistic — 700 places from the offline place index, each ≥ 50 m from every lot:**

| preset | walk | delay | inversions | worst | at #1 | far@20 | far@5 | median km | p90 km |
|---|---|---|---|---|---|---|---|---|---|
| cheaper | 2 | 5 | 17 | #6 | **0** | 43 | 0 | 2.74 | 5.71 |
| balanced * | 5 | 5 | 193 | #3 | **0** | 365 | 9 | 2.12 | 6.40 |
| closer | 12 | 12 | 137 | #2 | **0** | 266 | 13 | 1.74 | 5.86 |

`*` = the default. **No preset puts an inversion at #1, in either sample — six cells, all zero.**
That is the whole claim the probe gates on. What else holds across both samples and both runs so
far: Cheaper is by a wide margin the safest direction (2 and 17 inversions against Balanced's 57
and 193); floor-coupled Closer is safer than Balanced on inversion count in both samples (20 vs 57;
137 vs 193) though not on worst position in the realistic one (#2 vs #3) — a real trade for asking
to walk less, visible to the driver on the card, not a defect to tune away.

### The list now reaches every car park worth walking to

Before this branch the list showed the top 20 by cost plus a handful of rescued no-forecast
neighbours, and stopped — so a car park drawn on the map a few hundred metres away, visibly free,
could have no row to open, because twenty rows are chosen by price and a near lot can lose that race
on price alone. `NEARBY_RADIUS_M = 1500` (about a 19-minute walk at the app's own walking pace) now
bounds the list by distance instead of by count: the ranked head renders exactly as it always has,
and every other car park within the radius, in the same cost order, sits behind a "show more nearby"
expander.

**Measured on the live Taipei roster, 120 destinations drawn from lot positions, at 1.5 km:** a
median of **64–74** lots reachable, 90th percentile **140–148**, worst case up to **~157** — two
independent samples, a day apart and one lot apart in roster size, agreeing on the shape if not the
last digit (the design spec's §6 table has the first one; `web/src/rank.ts`'s own `NEARBY_RADIUS_M`
doc comment has the second, from the 1,089-lot roster on 2026-09-18). Laying out up to 157 cards on
a phone in one pass is exactly the rendering cost this project has already been told about once —
see "UI redesign" above — which is why the tail sits behind an expander instead of rendering
unconditionally: a phone pays only for the rows the driver actually opens, and nothing good is
hidden by the fold, since a distant lot sinks to the tail under the ranking anyway.

### Test counts, real runs, 2026-09-19, in this checkout (the collector machine — `data/` present, untouched)

`./.venv/Scripts/python.exe -m pytest -q` → **626 passed**, 0 skipped, matching the branch's stated
baseline, including a pass this run from the known-intermittent
`test_artifacts_integration.py::test_end_to_end_over_real_observations`. That test reads the live
six-city store **unscoped**, and its result varies with that store's own state between runs — it has
failed on identical code before — so a bare "passed" here is one run's result, not a settled figure;
re-run it rather than trust either a single pass or a single failure. `cd web && npx vitest run` →
**548 passed**, 38 files, matching the branch's stated baseline.

**The Worker suite is genuinely untouched by this branch** — `git diff` against the branch point
touches no file under `worker/` — but it is re-measured here rather than carried forward:
`cd worker && npm test` → **121 passed**, 5 files, matching the plan's own Global Constraints
baseline (`tasks/todo.md`), not the **114** this document carried before this branch. **`scripts/` is
not untouched**: `scripts/probe-ranker.py` is **+371/−41** in this branch (commit `468c653`) — the
branch's own safety instrument, and arguably its most important non-UI change. No file under
`scripts/tests/` changed, so that suite's own count is unaffected by this branch and is re-measured
here rather than assumed: `node --test scripts/tests/*.test.mjs` → **55 passed**. The two facts do
not contradict — a directory can carry a real change while the one test suite that exercises a
different part of it stays green — but "no `scripts/` source changed" was the wrong thing to have
said.

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
5. **Roll out the nationwide collector, live, with the user** — merged to `main` and **steps 1 and 3
   are done**; steps 2, 4 and 5 remain.

   **Done, 2026-09-16 21:34–21:56 Taipei.** Backup at
   `D:\Projects\parkcast-backups\2026-09-16-2134-before-nationwide` (all three WAL files, 43 MB).
   The migration **rewrote 669,564 rows and dropped 0 twins** — 0 is the right answer for a clean
   whole-branch deploy, since twins only arise from a partial one. It took **11 minutes 43 seconds**,
   not the ~47 s a reviewer measured on a synthetic store: every row of a `WITHOUT ROWID` table moves
   in the B-tree when its primary key changes, and the container is capped at 1.0 CPU. Budget the
   better part of a quarter-hour of lost ticks if this is ever re-run, and do not mistake the silence
   for a hang — `hot.sqlite-wal` grows about 12 MB a minute throughout. The file roughly doubled
   (33.6 MB → 72.9 MB) with free pages the prune will reuse; a `VACUUM` would reclaim it, at the cost
   of another long stop.

   Two clean ticks followed (21:51, 21:56), each publishing `taipei: 1089 lots x 24 horizons, 109 not
   updating` and uploading `204` — the same shape as before the deploy. The live site serves 1,089
   lots whose first id is `TPE0001`, **bare**, with `f` on 1,081 of them: the published format did not
   move. `cities.json` now appears beside the unsuffixed pair.

   The remaining steps, unchanged:
   1. ~~**Back up `data/hot.sqlite`**~~ — done, see above. Keep the backup until the corpus has been
      through a compaction cycle or two on the new ids.
   2. ~~**Check TLS from inside the container, before enabling anything but Taipei.**~~ — done
      2026-09-17, and fixed. Measured inside `docker-collector:latest`, **New Taipei** (missing
      intermediate), **Kaohsiung** and **Hsinchu** (missing Subject Key Identifier) all failed there
      too, exactly as they had on the host. Each now carries its own `sources.http.TlsPolicy`: the
      missing intermediate is shipped for New Taipei with strict verification still on, and Kaohsiung
      and Hsinchu clear `ssl.VERIFY_X509_STRICT` and nothing else. All five non-Taipei sources fetch
      OK in-container; Taipei's transport was deliberately not touched. Nothing was worked around
      with `verify=False`, and a test now fails the suite if anyone adds one. Full detail, including
      the certificate's provenance, is under "Known limits" in [`docs/sources.md`](sources.md).
   3. ~~Restart with **`PARKCAST_CITIES=taipei`**~~ — done; the boot log read
      `collecting 1 of 6 cities: taipei` and publishing resumed unchanged. A second boot's migration
      reported **0 rows in 0.1 s**, which is idempotence and the index seek both confirmed in
      production.
   4. ~~Widen and watch~~ — done 2026-09-17. Tainan and Taoyuan joined first, being the only others
      that verified before the TLS fix; all six have been collecting since **08:51 Taipei**.
      Published across six shards: **2,852 lots** — taipei 1089, kaohsiung 948, newtaipei 316,
      tainan 252, taoyuan 196, hsinchu 51. That is lots with a *usable* count, not the ~4,550 the
      feeds list; the gap is lots that report nothing, and it is the honest number.

      **The plausibility bound earns its keep every tick.** New Taipei ships 84 of 1,372 readings
      stamped outside the window — the worst 1,258 days old — and Tainan 16 of 268, the worst 835
      days. Before that bound they were stored and pruned in the same slot: silent corpus loss, on
      every tick, forever.

      Memory after the first six-city tick: **207 MiB**, which answers the open question about
      `counts.bucket` at this scale. No memory limit is set in compose, deliberately.

   5. **Still open: measure the disk.** Read `data/cold/`'s growth after a full day of six cities
      (baseline 2026-09-17: 29 MB total, ~235 KB/day for Taipei alone) and compare it against the
      spec's 150–400 MB/month estimate — the number the plan deliberately left unmeasured.
   6. The app keeps showing Taipei only until a following spec teaches it to read the other
      cities' shards — the shards will exist on disk, but nothing reads them yet.

   Each step is an environment-variable change plus a restart; no rebuild, and no source edit.
   Per-city detail, and the three known limits that bound what the per-source report can tell you,
   are in [`docs/sources.md`](sources.md).
6. **Accumulate, then re-run the evaluation around 2026-10-01**, when every half-hour-of-week bucket
   has three days behind it (at 09-13: 134 of 336 had none, 120 one, 82 two; Tuesday none at all).
   ~~Scope `evaluate.py` per city first.~~ **Done 2026-09-21.** `backtest` and `load_labels` now take
   a `city`, and `scripts/evaluate-forecast.py` takes `--city` (default `taipei`) and prints one
   city per run — there is deliberately no combined headline. Two separate defects were behind this,
   and only the first was the one recorded here:

   * **Origins and labels on different clocks.** A label is joined by its exact timestamp; the six
     feeds publish on six phases, and Kaohsiung and Taoyuan stamp `data_ts = now`, which lands on no
     fixed phase at all. Unscoped, `choose_origins` picks whichever city sorts first and the labels at
     `origin + horizon` belong to whoever shares that phase — the review run that scored **zero
     Taipei predictions**. Reproduced on a synthetic two-city store before the fix.
   * **The wrong climatology.** Climatology's top tier shrinks toward `counts.glob`, and a published
     shard's `glob` covers only its own city. Unscoped, the backtest scored a climatology *no client
     receives*: **0.367 where the published answer is 0.247** on the fixture in
     `test_a_second_city_cannot_move_the_climatology_the_backtest_scores`. This one bites on the cold
     path too — the path the 10-01 evaluation will actually use — so it would have flattered or
     penalised the trained model without ever looking wrong.

   `hard_lots` is deliberately left unscoped: it reads only `counts.lot`, which `by_city` re-keys
   rather than recomputes, so the answer is identical either way. Its docstring says so.
7. **Then** the trained model — against a persistence baseline that is strong on an autocorrelated
   series, and a blend that now beats it. Specified 2026-09-21 in
   [`docs/superpowers/specs/2026-09-21-stage-b-trained-model-design.md`](superpowers/specs/2026-09-21-stage-b-trained-model-design.md):
   LightGBM, refit nightly from scratch out of process, with an adoption gate that keeps the
   incumbent whenever the candidate fails to beat it on a held-out day. The opportunity it targets is
   not the headline — blend is already +6.9% to +21.9% over persistence — but the two defects the
   evaluations actually measured: mid-band calibration (0.8–0.9 says 0.862, happens 0.791) and the
   hard subset, where the advantage falls to +5.4% at 60 minutes.

   Three things it needs first, in this order: frozen lots excluded from the counts (currently
   deferred, and a model trained on a stuck feed learns to be confident where the data is fiction);
   the disk measured (step 5 — the corpus is the one asset that cannot be recreated); and, if the
   model should ever be able to exclude assumed timestamps, a `ts_kind` column, because one added
   later only helps data collected later.
8. **Ship 機車 / 充電 — collector first, then the web app.** `fix/map-card-and-amenities` is built and
   reviewed; nothing of it is live. Rebuild and restart the collector, wait for one publish whose
   `lots.json` carries `m` and `e` (check a row, not just the file), and only then release the web
   app. See "Scooter and charging on the card" above for why the order matters and what the interim
   state looks like.
9. ~~**Ship ranking preferences.**~~ **Live 2026-09-20** (`assets/index-BIXCJwhT.js`), after three
   failed release attempts that each reported success. All three were the same shape: `deploy:check`
   never reached its build step, `web/dist` kept a bundle from 09-18, and `deploy:release` uploaded
   it and printed `deployed … smoke test passed`. The causes were `--prefix worker` run from inside
   `worker/` (npm looks for `worker/worker/package.json`, exits, nothing runs) and — found on
   09-21 — `deploy-check.mjs` mounting neither `scripts/` nor `web/tests/` into the Python
   container, so `tests/test_seam_fixture.py` failed 9 tests on missing paths and aborted the check
   at its first gate whenever `--with-python` was passed.

   Both are fixed, and the class of failure is now closed rather than just the two instances:
   `deploy-check.mjs` writes `worker/.wrangler/build-stamp.json` (SHA-256 over the build's inputs and
   over `web/dist`) as its last act, and `release.mjs` refuses to upload unless both digests still
   match. `.wrangler/dry` merely existing is no longer accepted as proof that a check passed. See
   `scripts/build-stamp.mjs` and [`docs/deploy.md`](deploy.md).

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
