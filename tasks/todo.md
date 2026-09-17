# ParkCast — Stage A: arrival at any time, confidence from evidence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The nationwide-collector todo is archived at `docs/superpowers/plans/2026-09-16-nationwide-collector-archive.md`.

**Goal:** Let a driver ask about any arrival time within seven days, and make the confidence label mean "how much history is behind this" rather than "how far away is it".

**Architecture:** A new daily artifact, `week.bin`, carries the per-lot, per-half-hour-of-week climatology the forecaster already computes, plus the observation count behind each cell. The app keeps reading `grid.bin` inside its two-hour window and computes anything beyond it from `week.bin` using the server's own blend, so the two agree at the seam. `confidence.ts` gains support as a second input.

**Tech Stack:** Python 3.13+ (stdlib `struct`), TypeScript/React, Cloudflare Workers. No new dependency.

**Spec:** [`docs/superpowers/specs/2026-09-16-stage-a-any-time-arrival-design.md`](../docs/superpowers/specs/2026-09-16-stage-a-any-time-arrival-design.md) — **read §0 first**; it records what the six-city rollout changed under this design.

## Global Constraints

- **The honesty rules bind every task.** A `null` probability never renders as a number; a count of `0` is a real reading, never "not reporting"; the observed count `f` is never presented as a forecast; the ranker's expected-cost score is never shown.
- **Taipei's existing published bytes must not change.** `grid.bin` and `lots.json` keep their format, their names and their contents. `week.bin` is additive. There is an existing byte-identity test; it must keep passing untouched.
- **Shard naming follows `artifacts.grid_name`:** Taipei's file is `week.bin`; any other city's would be `week-{city}.bin` (`artifacts.UNSUFFIXED_CITY`). Published ids inside a shard are **bare**; `roster_id` hashes the bare ids.
- **Stage A serves Taipei only** — that is what the Worker and app serve today. Write the builder per city; publish for the served city.
- No new runtime dependency. Cloudflare Workers Free: no paid feature, **and no new KV write on the five-minute path**.
- Both layouts stay first-class (phone bottom sheet < 768 px, desktop side panel ≥ 768 px); every tap target ≥ 44 px; `prefers-reduced-motion` honoured.
- **Never read or write anything under `data/`** — a live collector owns it, six cities deep. Tests use `tmp_path` / fixtures.
- Python tests: `cd D:/Projects/ParkCast && ./.venv/Scripts/python.exe -m pytest -q` (575 passed at the start of this plan). Web: `cd web && npx vitest run` (299). Worker: `cd worker && npm test` (66). Scripts: `node --test scripts/tests/*.test.mjs` (50).
- **Never commit** unless a task's final step says to; the `git add` lines are a floor, not a fence.

---

## File structure

| Path | Responsibility |
|---|---|
| `src/parkcast/artifacts.py` | `encode_week`, the `PCW1` header, `week_name(city)`, `publish_week` |
| `src/parkcast/scheduler.py` | building and publishing `week.bin` once a day, per served city |
| `src/parkcast/upload.py` | `send_week` — its own request, off the five-minute path |
| `worker/src/validate.ts`, `serve.ts` | accept, store and serve the week blob |
| `web/src/week.ts` | parse `week.bin`; `weekBucket`; `probabilityAt`; the client half of the blend |
| `web/src/confidence.ts` | rewritten: support, not horizon |
| `web/src/arrival.ts` | the seven-day range and the day/hour/minute option lists |
| `web/src/components/ArrivalPicker.tsx` | replaces `ArrivalStrip.tsx` |
| `web/src/App.tsx` | wiring, and the lazy fetch of `week.bin` |
| `web/public/sw.js` | `VERSION` → `v3`, and one cache-first exception |

---

### Task 1: the `week.bin` encoder

**Files:**
- Modify: `src/parkcast/artifacts.py` (beside `encode_grid`), `src/parkcast/config.py`
- Test: `tests/test_artifacts.py`

**Interfaces:**
- Produces: `artifacts.WEEK_MAGIC = b"PCW1"`, `artifacts.WEEK_HEADER_FORMAT`, `artifacts.WEEK_HEADER_SIZE`, `artifacts.week_name(city: str) -> str`, `artifacts.encode_week(lot_ids: Sequence[str], cells: Mapping[str, Sequence[tuple[int | None, int]]], *, built_ts: int) -> bytes`, `artifacts.decode_week_header(blob: bytes) -> dict`, `artifacts.publish_week(out_dir: Path, city: str, *, week_blob: bytes) -> None` (beside the existing `artifacts.publish`, which Task 3 monkeypatches). `config.WEEK_BUCKETS = 7 * 24 * 60 // CLIMATOLOGY_BUCKET_MIN` — a **derivation, not the literal 336** — and `forecast.BUCKETS_PER_WEEK` becomes an alias of it. Do **not** add `config.WEEK_BUCKET_MIN`: `config.CLIMATOLOGY_BUCKET_MIN` already is that number, and a second name for it would drift the moment anyone changed the bucket width.

`cells` maps a **bare** lot id to exactly `WEEK_BUCKETS` `(probability, support)` pairs, probability a float in `[0, 1]` or `None`, support a non-negative int. The encoder rounds, clamps and caps; it does not compute.

- [ ] **Step 1: Write the failing test**

```python
def test_encode_week_round_trips_a_known_cell():
    cells = {"A": [(None, 0)] * 336, "B": [(None, 0)] * 336}
    cells["A"][5] = (0.86, 12)
    cells["B"][5] = (0.0, 300)          # a real zero, and support past the cap
    blob = artifacts.encode_week(["A", "B"], cells, built_ts=1789600000)

    header = artifacts.decode_week_header(blob)
    assert header["magic"] == artifacts.WEEK_MAGIC
    assert header["n_lots"] == 2
    assert header["n_buckets"] == 336
    assert header["bucket_min"] == 30
    assert header["roster_id"] == artifacts.roster_id(["A", "B"])
    body = blob[artifacts.WEEK_HEADER_SIZE:]
    assert len(body) == 2 * 336 * 2

    def cell(i, b):
        off = (i * 336 + b) * 2
        return body[off], body[off + 1]
    assert cell(0, 5) == (86, 12)
    # A real zero is a probability, not an absence: 0, never the unknown sentinel.
    assert cell(1, 5) == (0, 255)
    assert cell(0, 6) == (255, 0)        # unknown


def test_encode_week_refuses_a_row_of_the_wrong_length():
    with pytest.raises(ValueError):
        artifacts.encode_week(["A"], {"A": [(None, 0)] * 335}, built_ts=1)


def test_week_name_follows_the_shard_convention():
    assert artifacts.week_name("taipei") == "week.bin"
    assert artifacts.week_name("tainan") == "week-tainan.bin"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_artifacts.py -k week -v`
Expected: FAIL — `module 'parkcast.artifacts' has no attribute 'encode_week'`

- [ ] **Step 3: Implement**

Mirror `encode_grid`'s discipline exactly: `n_lots` and `roster_id` are **derived** from `lot_ids`, never passed in beside them, so the header cannot describe a roster the body does not have. Use `255` as the unknown probability sentinel (a real `0` must survive as `0` — that is the honesty rule in byte form) and cap support at `255`.

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS, 575 + your new tests.

- [ ] **Step 5: Commit**

```bash
git add src/parkcast/artifacts.py src/parkcast/config.py tests/test_artifacts.py
git commit -m "feat(artifacts): encode the per-lot week table"
```

---

### Task 2: build the cells from the city's own climatology

**Files:**
- Modify: `src/parkcast/artifacts.py` or a new `src/parkcast/week.py` — your call, say which and why
- Test: `tests/test_week.py`

**Interfaces:**
- Consumes: `forecast.by_city`, `forecast.Climatology`, `forecast.Counts`, `forecast.week_bucket`, `artifacts.encode_week`.
- Produces: `build_week_cells(history: History, lot_ids: Sequence[str]) -> dict[str, list[tuple[float | None, int]]]`, keyed by the **namespaced** store id, each value `WEEK_BUCKETS` long.

- [ ] **Step 1: Write the failing test.** For a history with one lot observed only in bucket `b`: that cell carries a probability and a support equal to the number of observations; every other cell carries the lot's shrunk fall-back with **support 0**. Assert that a bucket with no observations still gets a probability (climatology falls back through lot → citywide; that is the whole point of the shrinkage) but honestly reports `support == 0`.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.** The probability is `Climatology.predict(lot_id, ts_of_bucket, horizon_min=0)` — the same tier chain the live forecast uses, so the two can never drift. Support is that bucket's own raw observation count from `counts.bucket[(lot_id, bucket)]`, **before** shrinkage: it is the honest measure of what the cell rests on. Derive each bucket's representative timestamp from `forecast.week_bucket`'s own arithmetic rather than reimplementing it.
- [ ] **Step 4: Run the suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(week): build the week table from a city's climatology"`.

---

### Task 3: publish and upload it, once a day

**Files:**
- Modify: `src/parkcast/scheduler.py`, `src/parkcast/upload.py`
- Test: `tests/test_scheduler.py`, `tests/test_upload.py`

**Interfaces:**
- Produces: `upload.send_week(url, secret, week: bytes, *, city: str, roster_id: int) -> SendResult`; scheduler publishes `week_name(city)` beside the city's other shards.

**The id bridge lives here.** `build_week_cells` (Task 2) is keyed by the **namespaced** store id (`taipei:TPE0001`), because that is what history holds; `encode_week` (Task 1) takes **bare** ids, because that is what a shard publishes and what `roster_id` hashes. This task converts, with `ids.bare`, at the single point where the two meet — exactly as `publish_city` already does for `grid` and `lots`. Do not push the conversion into either neighbour.

- [ ] **Step 1: Write the failing tests**

```python
def test_the_week_file_is_written_once_a_day_not_once_a_tick(tmp_path, monkeypatch):
    """The five-minute path must stay the size it is. Climatology moves over
    weeks; rewriting a ~700 KB table every tick would spend the whole budget
    re-stating what it said five minutes ago."""
    conn = _seeded_store(tmp_path)
    out = tmp_path / "artifacts"
    writes = []
    monkeypatch.setattr(artifacts, "publish_week",
                        lambda *a, **k: writes.append(k.get("city")))

    day = date(2026, 9, 17)
    for tick in range(12):                       # an hour of ticks, one day
        scheduler.publish_artifacts(conn, LOTS, out_dir=out, today=day)
    assert writes == ["taipei"], "one write on the first tick, none after"

    scheduler.publish_artifacts(conn, LOTS, out_dir=out, today=date(2026, 9, 18))
    assert writes == ["taipei", "taipei"], "and one more when the day rolls over"


def test_a_week_publish_failure_never_stops_the_tick(tmp_path, monkeypatch):
    """Publishing is downstream of collection. A week table that cannot be
    written must not cost a reading that cannot be re-fetched."""
    monkeypatch.setattr(artifacts, "publish_week", _raises(OSError("disk full")))
    scheduler.publish_artifacts(conn, LOTS, out_dir=out)     # must not raise
    assert (out / "grid.bin").exists(), "the five-minute pair still published"
```
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Publishing is downstream of collection and must never stop it: every refusal returns, none raises, exactly as `publish_city` already does. `send_week` is its own request with its own back-off, reusing the existing opener, user agent and skew check; it must not ride `send_pair`'s job.
- [ ] **Step 4: Run the suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(scheduler): publish the week table daily"`.

---

### Task 4: the Worker accepts and serves it

**Files:**
- Modify: `worker/src/validate.ts`, `worker/src/serve.ts`, and the upload handler
- Test: `worker/tests/validate.test.ts`, `worker/tests/serve.test.ts`

- [ ] **Step 1: Write the failing tests.** `validate` accepts a well-formed week blob and rejects: a wrong magic, an unknown schema version, a body length that is not `n_lots × 336 × 2`, and a header whose `roster_id` disagrees with the stored `lots.json`. `serve` returns it at `/artifacts/week.bin` with `Cache-Control: max-age=3600`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** A new KV key `week`; the five-minute pair's handling is untouched.
- [ ] **Step 4: Run `npm test` in `worker/`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(worker): accept and serve the week table"`.

---

### Task 5: `web/src/week.ts` — parse, bucket, blend

**Files:**
- Create: `web/src/week.ts`, `web/tests/week.test.ts`
- Modify: `web/src/types.ts`

**Interfaces:**
- Produces:

```ts
export interface WeekTable { nLots: number; rosterId: number; builtTs: number; cells: Uint8Array }
export function parseWeek(buf: ArrayBuffer): WeekTable        // throws on a bad header, like parseGrid
export function weekBucket(ts: number): number                 // 0..335
export function probabilityAt(week: WeekTable, lotIndex: number, ts: number): { p: number | null; support: number }
export function blend(observedFree: number | null, climatologyP: number, minutesFromReading: number): number
export const BLEND_HALF_LIFE_MIN = 30;
```

`minutesFromReading` is measured from the shard's **`base_data_ts`**, never from `Date.now()`.
The server's horizon is measured from `history.latest_ts`, which is what `base_data_ts` carries;
measuring from the wall clock would pass every unit test and be wrong in the field by however
long ago the last reading was.

- [ ] **Step 1: Write the failing tests.**

```ts
it("buckets a timestamp the way the Python side does", () => {
  // ((ts + 8h) / 60 / 30) mod 336, matching forecast.week_bucket exactly.
  //
  // BUCKET 0 IS THURSDAY 00:00 TAIPEI, NOT MONDAY. `week_bucket` anchors on
  // the Unix epoch and does no calendar arithmetic, and 1970-01-01 was a
  // Thursday. An earlier draft of this plan asserted a Monday-anchored table;
  // a `weekBucket` written to satisfy it would have disagreed with Python by
  // 192 buckets -- four days -- passed its own test, and read the wrong time
  // of week for every arrival beyond the grid window.
  //
  // These values are generated by `scripts/build-seam-fixture.py`, not typed
  // by hand. Read them from the fixture; do not inline them.
  expect(weekBucket(TAIPEI_THURSDAY_0000)).toBe(0);
  expect(weekBucket(TAIPEI_MONDAY_0000)).toBe(192);
  expect(weekBucket(TAIPEI_MONDAY_0029)).toBe(192);
  expect(weekBucket(TAIPEI_MONDAY_0030)).toBe(193);
  expect(weekBucket(TAIPEI_SUNDAY_2330)).toBe(191);
});

it("reports a real zero as a probability and an unknown as null", () => {
  // 255 is the unknown sentinel; 0 is a lot that is reliably full at this hour.
  expect(probabilityAt(table, 0, ts).p).toBe(0);
  expect(probabilityAt(table, 1, ts).p).toBeNull();
});

it("weights the reading by the blend's own half-life", () => {
  // weight = 0.5 ** (minutes / 30): at the half-life the two contribute equally.
  expect(blend(5, 0.2, 30)).toBeCloseTo(0.6, 5);
  expect(blend(0, 0.2, 0)).toBe(0);      // a full lot now is a full lot now
});
```

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** `parseWeek` validates its header the way `parseGrid` does and throws on a mismatch rather than returning something half-trusted.
- [ ] **Step 4: Run `npx vitest run` in `web/`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): read the week table"`.

---

### Task 6: the seam — prove the two sources agree

The load-bearing test of this plan. A driver moving the arrival across the two-hour boundary must not see the number jump.

**Files:**
- Create: `scripts/build-seam-fixture.py`, `web/tests/seam.test.ts`, `tests/test_seam_fixture.py`
- Fixtures: `web/tests/fixtures/seam-grid.bin`, `web/tests/fixtures/seam-week.bin`, `web/tests/fixtures/seam.json`

**The fixtures are built by Python and only read by JavaScript.** `scripts/build-seam-fixture.py`
constructs a small synthetic history and runs it through the **real** `Climatology`, `Blend`,
`build_grid`/`encode_grid` and `build_week_cells`/`encode_week` — no hand-written bytes, no
JS-side construction of either blob. `tests/test_seam_fixture.py` regenerates and asserts the
committed files are byte-identical, so they cannot rot silently. `seam.json` carries only what the
JS test needs to index them: the lot's row, its `f`, and `base_data_ts`.

Why so strict: a fixture that builds both sides of a comparison can only prove they agree with
each other. This is the one test standing between a driver and a number that jumps as they cross
the two-hour boundary; built in JS, it would be the client's arithmetic on both sides of the
equals sign.

- [ ] **Step 1: Write the failing test.** For the fixture lot, the client's `blend(f, probabilityAt(week, i, t).p, minutesFromReading)` at `+120 min` must equal that lot's **last column** in `grid.bin` within **1 percentage point**.

  **The tolerance is arithmetic, not slack.** Worst case is **0.96875 pp**: the grid's own `round()`
  (≤ 0.5 pp) plus the week cell's `round()` scaled by `1 − weight` — and `1 − weight = 0.9375`,
  since `weight = 0.5 ** (120/30) = 0.0625`, so that term is `0.5 × 0.9375 = 0.46875 pp`.
  **Headroom under the 1 pp gate is 0.03125 pp**, about a thirtieth of it. Any extra rounding
  introduced anywhere in the client's path has more than enough room to break this test
  legitimately. (An earlier draft of this plan said 0.9375 pp and 0.0625 pp of headroom — that used
  0.4375 for the week term and was wrong. The gate itself has never moved.)

  Pick a fixture lot with **real climatology**. When `Climatology` returns `None` but
  `Persistence` does not, `Blend` returns pure persistence and the grid stores 0 or 100, while the
  week cell stores 255 and the client honestly renders "no data". That divergence is intended and
  is not what this test is for.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Make it pass.** If it does not, the bug is real and is in the client's arithmetic or in the encoder — **do not widen the tolerance to make it green**. Both sides compute `weight × persistence + (1 − weight) × climatology` from the same inputs; a disagreement means one of them is wrong. Say in your report which side you corrected.
- [ ] **Step 4: Run the suite.**
- [ ] **Step 5: Commit** — `git commit -m "test(web): pin the grid/week seam to one point"`.

---

### Task 7: confidence from evidence

**Files:**
- Modify: `web/src/confidence.ts`, `web/src/i18n.ts`
- Test: `web/tests/confidence.test.ts`

**Interfaces:**
- Produces: `confidenceFor({ minutesFromReading, readingAgeMin, support, updating, probability }) -> { level: Confidence; reason: ConfidenceReason } | null`, where `reason` names the evidence so the pill can explain itself.

- [ ] **Step 1: Write the failing tests** — one per row of the spec's §6 table, plus the null cases:

| | Condition | Level |
|---|---|---|
| — | no forecast, or the lot is not updating | `null` |
| High | arrival within 30 min of a reading ≤ 15 min old | `high`, reason `reading` |
| High | `support ≥ 24` (≈ 4 weeks of this half-hour) | `high`, reason `weeks` |
| Medium | `support ≥ 6` (≈ 1 week), or arrival within 75 min of a reading ≤ 30 min old | `medium` |
| Low | otherwise | `low`, reason `thin` |

Include the case the whole change exists for: **21:20 tomorrow with four weeks of support reads `high`**, while **40 minutes from now at a lot first seen yesterday reads `medium`**. Assert `weeks === Math.floor(support / 6)`.

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Thresholds are named constants, not literals in branches. Keep `HIGH_MAX_MIN` / `MEDIUM_MAX_MIN` for the reading-led rows.

  **This changes `confidenceFor`'s signature from four positional arguments to one object, so every caller moves with it.** `ConfidencePill.tsx` renders the level and must now also render the reason; `LotCard.tsx` passes the inputs and must now supply `support`, which it does not have yet — until Task 10 wires the week table through, pass `support: 0`, which reads as "no history behind this hour" and is true of a card that has not consulted the table. Say in your report which callers you touched.
- [ ] **Step 4: Run the suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): grade confidence by evidence, not distance"`.

---

### Task 8: the seven-day arrival range

**Files:**
- Modify: `web/src/arrival.ts`
- Test: `web/tests/arrival.test.ts`

**Interfaces:**
- Produces: `MAX_LEAD_SEC = 7 * 24 * 3600`; `dayOptions(nowSec)`, `hourOptions()`, `minuteOptions()`; `composeArrival(daySec, hour, minute)`; `clampArrival` extended to the new range.

- [ ] **Step 1: Write the failing tests.** The range runs from `ceilToStep(now + 5 min)` to `now + 7 days`; a time before now is clamped forward; the day list reads today, tomorrow, then weekday names in Taipei time; minutes step by 5. Cover a DST-free but month-crossing case (Taipei has no DST — say so in a comment so nobody adds one later).
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** `formatClock` and `relativeMinutes` keep working unchanged; a relative label beyond a day should read as a day and time, not "in 4,300 minutes".
- [ ] **Step 4: Run the suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): offer any arrival within seven days"`.

---

### Task 9: `ArrivalPicker`

**Files:**
- Create: `web/src/components/ArrivalPicker.tsx`, `web/tests/arrivalPicker.test.tsx`
- Delete: `web/src/components/ArrivalStrip.tsx`, `web/tests/arrivalStrip.test.tsx`
- Modify: `web/src/i18n.ts`

- [ ] **Step 1: Write the failing tests.** Quick chips (now, +15, +30, +1 h) each set the arrival; the three native `<select>`s compose a time; the 7-day bound holds at both ends; every control is keyboard-reachable and labelled; a drag across the chips changes nothing (the strip's old sweep is gone and must stay gone).
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** `App.tsx` imports `ArrivalStrip` today and must switch to `ArrivalPicker` in this task, not the next one — a deleted component with a live import is a broken build, and Task 10 assumes a green tree. Native `<select>` deliberately — it is the control every phone renders as a wheel, it is keyboard- and screen-reader-complete for free, and it holds the 44 px floor. The readout keeps its shape: the clock time, large, with the relative distance beside it.
- [ ] **Step 4: Run the suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): pick an arrival day, hour and minute"`.

---

### Task 10: wire it up, lazily

**Files:**
- Modify: `web/src/App.tsx`, `web/src/artifacts.ts`, `web/public/sw.js`, `scripts/smoke-live.mjs`
- Test: `web/tests/app.test.tsx`, `web/tests/swRouting.test.ts`, `scripts/tests/smoke-live.test.mjs`

- [ ] **Step 1: Write the failing tests.** `week.bin` is **not** fetched on load; it is fetched once when an arrival outside the grid window is first chosen; a failed fetch leaves the in-window app fully working and retries on the next attempt rather than remembering the failure forever. `sw.js` `VERSION` is `v3` and `routeFor` returns cache-first for `week.bin` while everything else under `artifacts/` stays network-first.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Follow `PlaceSearch`'s index fetch for the lazy-load shape, **including the lesson learned there**: the cleanup must reset the loading flag, or a blur mid-fetch strands it forever.
- [ ] **Step 4: Run every suite** — web, then `node --test scripts/tests/*.test.mjs`.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): fetch the week table only when it is needed"`.

---

### Task 11: documentation

**Files:**
- Modify: `docs/pwa.md`, `docs/state-of-play.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1:** `docs/pwa.md` — the new artifact, its routing rule and why it is the one cache-first exception under `artifacts/`.
- [ ] **Step 2:** `CLAUDE.md` — `week.bin`'s shape, that confidence now means evidence, and the seam rule (grid inside two hours, week beyond).
- [ ] **Step 3:** `docs/state-of-play.md` — a Stage A section with the **measured** artifact size and gzip figure, and the test counts you actually ran.
- [ ] **Step 4:** `README.md` — status line and the app paragraph.
- [ ] **Step 5: Commit** — `git commit -m "docs: record Stage A"`.

---

## Verification before the branch is finished

- Every suite green: Python, web, Worker, scripts.
- **The Python suite must also be run in the main checkout, not only in the worktree.** Three tests
  read the real collected corpus and *skip* wherever `data/` is absent:
  `tests/test_artifacts_integration.py:36` and `tests/test_history_bounds.py:39,60`
  ("no collected data on this machine"). A worktree run is therefore three tests weaker than
  main's, and `test_artifacts_integration.py` is the very test that caught the id-convention
  defect at merge on the collector branch. Stage A modifies `artifacts.py`. A green worktree run
  is necessary and not sufficient. Do **not** close the gap by copying `data/` into the worktree:
  the live collector owns it, and a mid-write snapshot would make a passing test meaningless.
- `week.bin`'s real size and gzip measured against the spec's ≤ 600 KB gate — if it exceeds it, the fallback is a narrower support byte, **not** a wider gate.
- A browser pass on both layouts, light and dark: pick a time tomorrow evening and confirm the probability, the confidence pill and its reason all change coherently, and that nothing animates at rest.
- `npm run deploy:check --prefix worker` clean. The release itself is the user's.
