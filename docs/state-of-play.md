# State of play — 2026-09-10

Written for a session starting cold. `CLAUDE.md` has the standing facts; this has
**where things are right now, what was just learned, and what to do next**.

---

## Where the project is

Plans 1 through 3d are complete: collector, forecast grid, ranked list, map, time-scrubber,
search, and an installable offline-capable PWA. **275 Python tests, 186 TypeScript.** The app
works end to end and has never been deployed.

The forecast has now been **evaluated for the first time** (below). That is the newest and most
important thing in this document.

## Which machine is which

| | |
|---|---|
| **Desktop** | **The collector. Authoritative `data/`.** Moved here 2026-09-10, runs 24/7. |
| Laptop | Collector stopped and removed. Its `data/` is a **stale fallback**, frozen at 2026-09-10 09:08 Taipei, 64,268 hot rows. |

**Never run two collectors.** Two machines polling the same feed produce two corpora that disagree
about the same day, and there is no merge tool. This is the one unrecoverable mistake in the
project. See [`collector-move.md`](collector-move.md).

A dated zip of the laptop corpus plus a SHA-256 manifest is at `~/Documents/parkcast-move/` on the
laptop. `python scripts/verify-corpus.py` checks a copy against the manifest — worth knowing that a
**corrupted SQLite file passes `PRAGMA integrity_check` and returns the right row count**, so the
hash is not paranoia.

## Working on a machine that is not the collector

The two artifacts the app reads expire after ~115 minutes by design, so a dev machine without a
collector shows the "forecast too old" state. Fix it with:

    python scripts/refresh-demo-artifacts.py

One live feed reading, scored against the local corpus, written to `web/public/artifacts/`. It
operates on a throwaway copy of `hot.sqlite` and **cannot fork the corpus** — verified after the
first run by re-checking all 16 files against the manifest.

---

## The evaluation, 2026-09-10 — read this before touching the model

`python scripts/evaluate-forecast.py`. Time-split, walk-forward, leak-free by the train/test
contract in `forecast.py`; 17 tests in `tests/test_evaluate.py`, three of which exist specifically
to catch a leaked label.

**Setup.** Corpus 2026-09-04 18:33 → 2026-09-10 09:08 Taipei (694 collected ticks). Train:
everything before 2026-09-06 21:53. Test: 37 origins through 09-10 09:03. 169,542 predictions per
forecaster. Base rate 0.898 — a flat forecast of 0.898 scores 0.0917.

### The headline is a crossover, and the aggregate hides it

Citywide the shipped **Blend loses to persistence** (0.0249 vs 0.0239, −4.1% skill). By horizon:

| horizon | persistence | blend | blend vs persistence |
|---|---|---|---|
| 5 min | 0.0101 | 0.0095 | **+5.6%** |
| 15 min | 0.0187 | 0.0173 | **+7.6%** |
| 30 min | 0.0243 | 0.0246 | −1.2% |
| 60 min | 0.0328 | 0.0367 | −11.9% |
| 120 min | 0.0410 | 0.0452 | −10.2% |

Same shape on the **234 hard lots** (free <90% of the time in training, test base rate 0.640):
+5.0%, +2.9%, then −8.5%, −18.0%, −15.7%.

**The forecast beats both baselines to ~15–20 minutes and is worse than "is it free now?" beyond
30.** The app opens on 15 minutes, inside the winning band; the slider reaches 120, which is not.

### Why — structural, not a bad method

Not one prediction had six or more training observations behind its climatology bucket:

| bucket n | predictions | blend Brier |
|---|---|---|
| 0 (no bucket) | 111,284 | 0.0296 |
| 1–5 | 58,258 | 0.0159 |
| 6–19 | **0** | — |
| 20+ | **0** | — |

Buckets are 30-minutes-**of-week** and recur weekly. A 2.2-day training window visits each bucket
at most once — a ceiling of 6 observations at perfect coverage, and coverage was 34%. **Climatology
cannot work on less than a week of training data.** Blend decays toward climatology as the horizon
grows, so the long horizons are being pulled toward a component that knows nothing.

### Calibration is sound where the mass is

The 0.9–1.0 band holds 145,365 of 169,542 predictions and says 0.988 against 0.986 observed. Thin
mid bands wobble: 0.4–0.5 is overconfident by 12 points (n=1,269), 0.5–0.6 underconfident by 13
(n=632).

### Caveat that must travel with these numbers

37 origins over 2.2 days of training, with 2026-09-08 empty. 169,542 predictions come from 37
moments in time. The direction is consistent across citywide and hard subsets and across two
horizons, which is suggestive — **it is not a confidence interval.**

---

## What to do next

Agreed sequence, amended by the evaluation:

1. **Deploy.** GitHub Pages is confirmed viable: it answers range requests with
   `206 Partial Content` and `Access-Control-Allow-Origin: *`, so the self-hosted 24 MB PMTiles
   basemap works with no API key and no third-party origin. The open design question is how
   artifacts reach the CDN — the desktop pushing on a timer, which means an automated credential on
   a home machine, and a cadence choice (5 min vs 15–30 min; the app degrades honestly either way
   because it shows the real age).
2. **Accumulate.** Let the desktop collect 3–4 weeks. Re-run the evaluation; climatology becomes
   answerable once buckets have been visited several times.
3. **Then** consider training a model. Not before: it would learn from the same 2.2 days and be
   measured against a persistence baseline that is genuinely strong on an autocorrelated series.
4. **Enhancements** — the user has a list to provide.

**One fix is worth doing at any point:** make Blend *support-aware*, so a bucket with no
observations behind it is not blended toward. That targets exactly the 30–120 minute regime the
evidence says is being harmed, and is principled rather than a tuning hack.

**Do not cap the horizon slider to make the metric look better.** Deleting a real feature to
flatter a number is the opposite of how this project has handled every other inconvenient
measurement.

## Open decisions belonging to the user

- **Licence.** The repo is public with none, so the code is readable but not reusable.
- **Deployment cadence and the credential** (see 1 above).
- Whether to do the support-aware blend before or after deploying.

## Gotchas that cost real time

- **The Browser pane can report itself visible and still not paint.** `document.hidden` was `false`,
  `visibilityState` `"visible"`, and `requestAnimationFrame` never fired — WebGL stayed blank while
  every DOM assertion passed. Probe with a real `rAF`, not the flag. See `tasks/lessons.md` L006.
- **`python` and `.venv/Scripts/python.exe` are not the same interpreter** on the laptop; only the
  venv has pytest. Check before concluding a dependency is missing.
- **Cold Parquet is slot-snapped** — it stores 288 slots a day and discards the true `data_ts`.
  Reconstruct with `slot_start + 180` (the feed's fixed phase); verified exact against the hot store.
- `restart: unless-stopped` does **not** cover a sleeping host, only exits.
