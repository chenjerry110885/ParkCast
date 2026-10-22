# ParkCast — holiday-aware prediction, the typical week, and the model ablation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The time-aware pricing plan is archived at `docs/superpowers/plans/2026-10-01-time-aware-pricing-archive.md`.

**Goal:** Stop filing public holidays as ordinary weekdays — in the forecast and in the fare — show each car park's typical week on its card, and measure whether `blend_p`, a holiday flag or row weights let LightGBM beat `Blend`.

**Architecture:** One committed copy of the official government calendar feeds both sides. Climatology gains an 8th day slot for holidays (`week.bin` 336 → 384 buckets, version 2) whose cells shrink toward a measured prior day instead of toward the lot rate. The Worker and the app accept versions 1 and 2, so the release order is web/Worker first and the collector second. The model work is an offline ablation that writes nothing.

**Tech Stack:** Python 3.13 (stdlib, LightGBM 4.7, numpy), TypeScript/React, Cloudflare Worker. No new dependency.

**Spec:** none written. The owner opted out of the design questions on 2026-10-22 ("just do our original plan"); the decisions are recorded under Global Constraints and are the executor's to honour, not to revisit.

## Global Constraints

- **Never read or write anything under `data/`** from the host. Corpus analysis runs in `docker-collector:latest` with `data/cold` mounted `:ro`, `--network none --read-only --cap-drop ALL`.
- **No `Co-Authored-By:` trailers and no AI attribution of any kind in commit messages** (CLAUDE.md:18).
- Calendar source: 行政院人事行政總處《中華民國政府行政機關辦公日曆表》, data.gov.tw dataset 14718, ROC 115 (2026) and 116 (2027). Columns `西元日期,星期,是否放假,備註`; `是否放假` is `0` workday, `2` day off.
- **A holiday** is a date with `是否放假 == "2"` that is Mon–Fri, or that is Sat/Sun with a non-empty `備註`. An ordinary weekend is not a holiday.
- **Make-up workdays** (`是否放假 == "0"` on Sat/Sun): none exist in 2026–2027. Not modelled. The calendar builder raises on one, so a future calendar forces a decision.
- Holiday classification uses the **Taipei local date** of a timestamp, never UTC.
- **Beyond the calendar's coverage, behave exactly as today:** no holiday slot, no holiday fare, no holiday notice.
- Bucket geometry: 48 half-hours a day; clock buckets `0..335` unchanged (bucket 0 = **Thursday** 00:00 Taipei); holiday slot = day slot 7, buckets `336..383`.
- `week.bin` version 2 = 384 buckets; version 1 = 336. Both are accepted by the Worker and the app for as long as either can be cached.
- Holiday cells shrink toward the **same half-hour of the prior day** chosen by Task 3's measurement, with strength `CLIMATOLOGY_BUCKET_PRIOR` (8).
- **Fares on a holiday:** a holiday-scoped segment wins; else, if the lot prices holidays (`Tariff.holidays` / `Price.h`), its `weekend` segment is the holiday rate; else, if the schedule distinguishes weekday from weekend at all, **no rate** (range + "may differ on holidays"); an `all`-only schedule resolves as today.
- **Release order:** web + Worker released and verified **before** the collector is rebuilt and recreated. (`tasks/lessons.md`, "Two deploy paths".)
- Python suite: `docker run --rm --user 0:0 -v "D:/Projects/ParkCast/src:/repo/src:ro" -v "D:/Projects/ParkCast/tests:/repo/tests:ro" -v "D:/Projects/ParkCast/scripts:/repo/scripts:ro" -v "D:/Projects/ParkCast/web/tests:/repo/web/tests:ro" -v "D:/Projects/ParkCast/web/src:/repo/web/src:ro" -v "D:/Projects/ParkCast/pyproject.toml:/repo/pyproject.toml:ro" -w /repo -e PYTHONDONTWRITEBYTECODE=1 docker-collector:latest sh -c "pip install -q pytest 2>/dev/null; python -m pytest -q -p no:cacheprovider tests/"`
- Web suite: `npm test --prefix web`; typecheck `npm run typecheck --prefix web`. Worker: `npm test --prefix worker`. Scripts: `node --test scripts/tests/*.test.mjs`.
- This repo is CRLF on disk. Check `git diff --stat` for a too-large diff after any scripted edit.

## Review Focus

1. **An arrival past the calendar's end (2028)** — must behave exactly as today: clock bucket, ordinary fare, no notice. Pinned in Tasks 1, 4, 5.
2. **A version-1 `week.bin` still cached in a browser after the collector moves to version 2** — must index with a 336 stride and read the clock bucket on a holiday, never misalign. Pinned in Task 4.
3. **A timestamp just after Taipei midnight on a holiday** (2026-10-10 00:10 Taipei = 2026-10-09 16:10 UTC) — must classify as the holiday. Pinned in Tasks 1 and 4.
4. **The collector restarting with today's version-1 `week.bin` on disk** — must rebuild as version 2, not re-offer the old table for the rest of the day. Pinned in Task 2.
5. **A stay crossing midnight from a holiday into a workday** (23:00 on 2026-10-10 + 2 h) — each hour must be priced by its own date. Pinned in Task 5.

---

### Task 1: The calendar, shared by both sides

**Files:**
- Create: `scripts/build-calendar.py`, `src/parkcast/holidays_tw.json`, `src/parkcast/holidays.py`, `web/src/holidaysTw.json`, `web/src/holidays.ts`
- Modify: `scripts/deploy-check.mjs` (coverage gate)
- Test: `tests/test_holidays.py`, `web/tests/holidays.test.ts`

**Interfaces:**
- Produces (Python, `parkcast.holidays`): `is_holiday(d: date) -> bool`, `holiday_name(d: date) -> tuple[str, str] | None` (zh, en), `covers(d: date) -> bool`, `taipei_date(ts: int) -> date`.
- Produces (TS, `web/src/holidays.ts`): `isHoliday(ts: number): boolean`, `holidayName(ts: number, lang: Lang): string | null`, `calendarCovers(ts: number): boolean`. `ts` is epoch **seconds**.
- JSON shape (both copies identical bytes): `{"source": [<url>, <url>], "covers": ["2026-01-01", "2027-12-31"], "holidays": {"2026-09-25": ["中秋節", "Mid-Autumn Festival"], ...}}`.

- [ ] **Step 1:** `build-calendar.py <csv> [<csv>...]` reads the DGPA CSVs (UTF-8 with BOM, CRLF), applies the holiday rule, maps every `備註` to English through a fixed table, and writes the JSON with sorted keys. It raises on a make-up workday and on a `備註` the table has no English for. Run it on the two CSVs in the scratchpad; commit its output to both paths.
- [ ] **Step 2: Failing tests** in `tests/test_holidays.py`: `is_holiday(date(2026,9,25))`, `(2026,9,28)`, `(2026,10,9)`, `(2026,10,10)` are True; `(2026,10,3)` (ordinary Saturday) and `(2026,10,8)` False; 2026 has 22 holidays and 2027 has 24; `covers(date(2028,1,1))` is False and `is_holiday` of it is False; `taipei_date(1791562200)` is `date(2026,10,10)` (00:10 Taipei); the two JSON copies are byte-identical; the builder raises on a fixture CSV holding a weekend `是否放假=0` row.
- [ ] **Step 3:** Implement `holidays.py`, loading the JSON once via `importlib.resources`.
- [ ] **Step 4: Failing tests** in `web/tests/holidays.test.ts`: the same dates through `isHoliday`, the 00:10-Taipei case, `holidayName(..., "en")` is `"National Day"` for 2026-10-10, and 2028 is not covered.
- [ ] **Step 5:** Implement `holidays.ts` importing `./holidaysTw.json`.
- [ ] **Step 6:** `deploy-check.mjs` fails when `covers[1]` is earlier than today (Taipei) + 60 days. Test the date arithmetic in `scripts/tests/`.
- [ ] **Step 7:** Run all three suites; commit.

---

### Task 2: Holidays as their own day slot in the climatology

**Files:**
- Modify: `src/parkcast/config.py`, `src/parkcast/forecast.py`, `src/parkcast/week.py`, `src/parkcast/artifacts.py`, `src/parkcast/scheduler.py`, `src/parkcast/features.py:174`
- Test: `tests/test_forecast_holidays.py`, `tests/test_week.py`, `tests/test_artifacts.py`, `tests/test_scheduler.py`

**Interfaces:**
- Consumes: `holidays.is_holiday`, `holidays.taipei_date`.
- Produces: `config.BUCKETS_PER_DAY = 48`, `config.CLOCK_BUCKETS = 336`, `config.HOLIDAY_SLOT = 7`, `config.WEEK_BUCKETS = 384`, `config.HOLIDAY_PRIOR_SLOT` (day slot; Task 3 sets the measured value, default `3` = Sunday); `forecast.day_bucket(ts: int) -> int`; `Climatology.predict_bucket(lot_id: str, bucket: int) -> float | None`; `artifacts.WEEK_VERSION = 2`.

- [ ] **Step 1: Failing tests:** `day_bucket` of 2026-09-25 14:10 Taipei is `336 + 28`; of 2026-09-24 14:10 is `week_bucket(...)`; of a 2028 timestamp is its clock bucket. `Counts` fed one holiday observation increments a bucket ≥ 336 and leaves the Friday clock bucket untouched. A holiday cell with no holiday observations equals the prior slot's cell for that half-hour; with observations it moves toward them; clock cells are unchanged by holiday data. `build_week_cells` rows have 384 cells, cells 336–383 carry the holiday support. `encode_week` writes version 2 and `n_buckets` 384.
- [ ] **Step 2:** Implement. `predict(lot, ts, h)` delegates to `predict_bucket(lot, day_bucket(ts))`; a holiday bucket's prior is `predict_bucket(lot, HOLIDAY_PRIOR_SLOT * 48 + bucket % 48)`, then `_shrink` at `CLIMATOLOGY_BUCKET_PRIOR`. `week.py` iterates buckets through `predict_bucket`, so it no longer needs `_bucket_timestamp` for the holiday slot.
- [ ] **Step 3: Failing scheduler test:** a version-1 `week.bin` built today is on disk; `_publish_week` rebuilds and offers version 2. Fix the daily gate to also require the on-disk version to equal `WEEK_VERSION`.
- [ ] **Step 4:** `features.row`'s bucket support reads `day_bucket`. Full Python suite; commit.

---

### Task 3: Measure which day a holiday resembles

**Files:**
- Create: `scripts/holiday-prior.py`
- Modify: `src/parkcast/config.py` (`HOLIDAY_PRIOR_SLOT`)
- Test: `tests/test_holiday_prior.py`

- [ ] **Step 1:** For each holiday in the corpus, build a `Climatology` from non-holiday observations strictly before that date, score that day's observations against the clock buckets of each of the 7 day slots plus "its own weekday", and report the Brier score per candidate, per holiday and pooled. A unit test drives it on a synthetic corpus where Sunday is the planted answer.
- [ ] **Step 2:** Run it in the collector image (`data/cold:ro`). Set `HOLIDAY_PRIOR_SLOT` to the pooled winner; record the table and the n behind it in the commit message. Four holidays is a small sample: say so.

---

### Task 4: The Worker and the app read version 2

**Files:**
- Modify: `worker/src/validate.ts`, `worker/src/upload.ts`, `web/src/week.ts`, `web/src/types.ts` (`WeekTable.nBuckets`), `web/src/App.tsx`
- Test: `worker/tests/validate.test.ts`, `web/tests/week.test.ts`, `web/tests/seam.test.ts`

**Interfaces:**
- Produces (TS): `WeekTable.nBuckets: 336 | 384`; `dayBucket(ts: number, table: WeekTable): number`; `probabilityAt(...)` returns `{ p, support, holiday: boolean }`.

- [ ] **Step 1: Failing tests:** the Worker accepts `(1, 336)` and `(2, 384)` and refuses `(2, 336)`, `(1, 384)` and anything else; `MAX_WEEK_BODY_BYTES` uses 384. `parseWeek` accepts both; `probabilityAt` on a v2 table on 2026-10-10 14:00 reads cell `336 + 28` with `holiday: true`; on a **v1** table the same timestamp reads its clock bucket with `holiday: false` and a 336 stride (two-lot fixture, so a wrong stride reads the other lot); a 2028 timestamp reads the clock bucket. The seam test reads a v2 table written by the Python encoder.
- [ ] **Step 2:** Implement. Commit.

---

### Task 5: Holiday fares

**Files:**
- Modify: `src/parkcast/pricing.py` (`rate_at`), `web/src/rank.ts` (`rateAt`, `feeForStay`, `Money`), `web/src/format.ts`, `web/src/i18n.ts`
- Test: `tests/test_pricing_schedule.py`, `web/tests/rankPrice.test.ts`, `web/tests/lotCardPrice.test.tsx`

**Interfaces:**
- Produces: `rateAt(price: Price, ts: number): number | null` (was `(segments, ts)`); `Ranked.holidayAtArrival: boolean`; i18n `priceHolidayRate`, `priceMayDifferHoliday`.

- [ ] **Step 1: Failing tests** for the fare rule in Global Constraints, both languages of code: on 2026-10-09 14:00 a folded lot (`h: 1`, weekday 50 / weekend 60) charges **60**; a lot with a holiday segment charges that segment; a weekday/weekend lot that never mentions holidays returns **null**; an `all`-only lot charges as on any day; on 2028-10-10 everything is as today. A 2 h stay from 23:00 on 2026-10-10 prices hour 1 by the holiday rule and hour 2 as an ordinary Sunday.
- [ ] **Step 2:** Implement; the card's label gains `priceHolidayRate` when the shown rate came from the holiday rule, and an unresolved holiday range reads `per hour · {priceMayDifferHoliday}`.
- [ ] **Step 3:** Python, web suites, typecheck; commit.

---

### Task 6: Say it on screen

**Files:**
- Modify: `web/src/App.tsx`, `web/src/confidence.ts`, `web/src/components/ConfidencePill.tsx`, `web/src/i18n.ts`
- Test: `web/tests/app.test.tsx`, `web/tests/confidence.test.ts`

**Interfaces:**
- Produces: a `Notice` with `data-testid="holiday-notice"`; `ConfidenceReason` gains `{ kind: "holidays"; holidays: number }`; `confidenceFor` input gains `holiday: boolean`.

- [ ] **Step 1: Failing tests:** an arrival on 2026-10-10 renders the notice containing the holiday's name in the UI language and the prior day's name; an arrival on 2026-10-08 and on 2028-10-10 renders none. A holiday cell's pill reason counts `floor(support / 6)` past holidays, not weeks.
- [ ] **Step 2:** Implement; commit.

---

### Task 7: The typical week on the selected card

**Files:**
- Create: `web/src/components/WeekProfile.tsx`, `web/src/weekProfile.ts`
- Modify: `web/src/components/LotCard.tsx`, `web/src/components/LotList.tsx`, `web/src/App.tsx` (load `week.bin` when a lot is selected), `web/src/styles/components.css`, `web/src/i18n.ts`
- Test: `web/tests/weekProfile.test.ts`, `web/tests/lotCard.test.tsx`

**Interfaces:**
- Produces: `profileRows(table: WeekTable, row: number): { day: "mon"|…|"sun"|"holiday"; hours: (number | null)[] }[]` — Mon..Sun in that order (clock slot `(r + 4) % 7`), plus `"holiday"` only for a v2 table; each hour is the mean of its two half-hours' `p`. `busiestWindow(rows): { day; startHour; endHour } | null` — the 3-hour same-day window with the lowest mean `p`, returned only when that mean is below 0.6.

- [ ] **Step 1: Failing tests:** row order and the Thursday-anchored slot mapping (a fixture with a marked Monday 09:00 lands in row 0, hour 9); the holiday row exists for v2 only; `busiestWindow` on a planted Saturday 14–17 dip returns it, and on a uniformly free lot returns null; the card renders the profile only when `selected` and a table is in hand, with an `aria-label` carrying the summary.
- [ ] **Step 2:** Implement. Cells use `colour.ts`'s ramp, so the profile and the map agree. Selecting a lot fetches `week.bin` if not yet in hand (the same `loadWeek` and roster key).
- [ ] **Step 3:** Web suite, typecheck; verify in the preview on a selected lot, screenshot; commit.

---

### Task 8: The model ablation

**Files:**
- Modify: `src/parkcast/features.py` (`FEATURES` gains `blend_p`, `is_holiday`), `src/parkcast/train.py` (`fit(..., weight=None)`)
- Create: `scripts/ablate-model.py`
- Test: `tests/test_features.py`, `tests/test_ablate.py`

**Interfaces:**
- Produces: `blend_p` = the `Blend` formula from `clim_p`, `is_free_now` and `horizon_min` (`clim_p` when there is no reading); `is_holiday` = 1.0 when the **target** date is a holiday.

- [ ] **Step 1: Failing tests:** `blend_p` equals `forecast.Blend(...).predict` for the same row; `is_holiday` is 1.0 for a target on 2026-10-09; `fit` passes `weight` through to `lgb.Dataset`. `ablate-model.py` on a synthetic corpus writes nothing under its `--models` path and prints one row per variant.
- [ ] **Step 2:** Variants, all on one time split and scored with per-origin histories: `base` (the original 26 columns), `+blend_p`, `+is_holiday`, `+both`, `+both, full rows ×3`, `+both, hard lots ×3`. Report citywide and hard-subset Brier, Brier by horizon, and weighted |gap| over 0.0–0.2 and 0.2–0.9, each against `blend`.
- [ ] **Step 3:** Run it in the collector image (`data/cold:ro`, `--test-fraction 0.20 --origins 200`). Record the table in the commit message. Whatever wins, `Blend` keeps serving until the nightly gate adopts something.

---

### Task 9: Release and record

- [ ] **Step 1:** Python, web, Worker and script suites green.
- [ ] **Step 2:** `npm run deploy:check --prefix worker -- --with-python` from the repo root, in a shell **without** `CLOUDFLARE_API_TOKEN`.
- [ ] **Step 3:** The owner releases web + Worker. Verify the live bundle reads v2 and the notice renders for 2026-10-26 (補假).
- [ ] **Step 4:** Only then the owner rebuilds and recreates the collector. Verify the next tick logs `week table for N lots` and the live `week.bin` header is version 2 with 384 buckets.
- [ ] **Step 5:** `docs/state-of-play.md`: the contamination finding (2 of ~7 Friday samples), the measured prior day, the live verification, and the ablation table.
