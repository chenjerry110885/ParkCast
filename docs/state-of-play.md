# State of play — 2026-09-14

Written for a session starting cold. `CLAUDE.md` has the standing facts; this has
**where things are right now, what was just learned, and what to do next**.

---

## Where the project is

Plans 1 through 3e are complete: collector, forecast grid, ranked list, map, time-scrubber, search,
an installable offline-capable PWA, and — Plan 3e — no forecast for a car park whose feed has stopped
updating. **306 Python tests, 191 TypeScript.** The app works end to end and has never been deployed.

The two newest things in this document: the collector's first unbroken days on the desktop turned up
**car parks whose readings never move**, which the app was publishing as certainties; and a second
and third evaluation **reversed the first one's verdict** on long horizons.

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

**Plan 3e is only live once the collector is rebuilt.** The running container keeps the image it was
started with. After `docker compose -f docker/docker-compose.yml up -d --build --force-recreate`, the
publish log line should read `published N lots x 24 horizons, M not updating`; without the suffix,
the old code is still running.

## Working on a machine that is not the collector

The two artifacts the app reads expire after ~115 minutes by design, so a dev machine without a
collector shows the "forecast too old" state. Fix it with:

    python scripts/refresh-demo-artifacts.py

One live feed reading, scored against the local corpus, written to `web/public/artifacts/`. It
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

## What to do next

1. **Deploy Plan 3e to the collector** (rebuild and recreate just after a tick; confirm the new log
   line). Until then the published artifacts still show frozen lots as 0% and 100%.
2. **Guard the collector against people.** Proposed, not done: rename the compose project from
   `docker` to `parkcast` (one container recreate); and a small watchdog *outside* the container that
   warns when the newest reading is more than 15 minutes old, since the collector cannot notice its
   own pause.
3. **Deploy the app.** GitHub Pages is confirmed viable: it answers range requests with
   `206 Partial Content` and `Access-Control-Allow-Origin: *`, so the self-hosted 24 MB PMTiles
   basemap works with no API key and no third-party origin. Open: how artifacts reach the CDN — the
   desktop pushing on a timer means an automated credential on a home machine — and at what cadence.
4. **Accumulate, then re-run the evaluation around 2026-10-01**, when every half-hour-of-week bucket
   has three days behind it (at 09-13: 134 of 336 had none, 120 one, 82 two; Tuesday none at all).
5. **Then** consider a trained model — against a persistence baseline that is strong on an
   autocorrelated series, and a blend that now beats it.

Also deferred: removing frozen lots from the climatology counts; retiring or recalibrating
`find_frozen_lots`; compressing the daily metadata snapshots (2.17 MB a day, ~90% of the cold store).
**The support-aware blend proposed on 09-10 is deprioritised** — the loss it targeted did not show up
again.

**Do not cap the horizon slider to make the metric look better.** Deleting a real feature to flatter
a number is the opposite of how this project has handled every other inconvenient measurement.

## Open decisions belonging to the user

- **Licence.** The repo is public with none, so the code is readable but not reusable.
- **Deployment cadence and the credential** (see 3 above).
- **The compose rename and the watchdog** (see 2 above).

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
  `docker-collector:latest` container with `src/`, `tests/` and `pyproject.toml` mounted read-only.
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
