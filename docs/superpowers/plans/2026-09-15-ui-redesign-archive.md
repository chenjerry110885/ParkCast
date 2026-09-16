# ParkCast — UI/UX redesign: map-first, glass & gradient

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The deploy todo is archived at `docs/superpowers/plans/2026-09-14-deploy-todo-archive.md`.

**Goal:** Rebuild the web app as a map-first, frosted-glass, animated "urban mobility" interface for phone and desktop, with place search (landmarks, streets and lanes, neighbourhoods, car parks), arrival as a clock time, and two new card facts — the observed free count and a confidence label — without weakening any honesty rule the product is built on.

**Architecture:** The map fills the viewport; a draggable frosted bottom sheet (phone) or a fixed side panel (desktop) holds search, the arrival strip and the card list. New pure modules (`arrival.ts`, `confidence.ts`, `places.ts`, `layout/sheet.ts`, `motion.ts`) carry every rule and are unit-tested; components are thin. The collector publishes one new `lots.json` field (`f`); a build script derives a static place index from the basemap tiles. No new runtime dependency anywhere.

**Tech Stack:** React 19 + TypeScript 6 + Vite 8 + vitest 5 + @testing-library/react (web); MapLibre GL 6.7 (already present); Python 3.13 stdlib + sqlite3 (collector); Cloudflare Worker (TypeScript, zero deps); Node 22 `node:test` for `scripts/`.

**Spec:** `docs/superpowers/specs/2026-09-15-ui-redesign-design.md` (approved 2026-09-15). Section numbers below (§) refer to it. The spec is the binding authority; where this plan and the spec disagree, the spec wins and the ruling is recorded in the ledger.

## Global Constraints

- **Commits: none without the user's yes** (`CLAUDE.md`: "Commit or push only when asked"). Every task ends at a *checkpoint*: `git add` of its files, no commit, unless the user has authorised per-task commits on the working branch — the controller says which in the dispatch. When commits are authorised: Conventional Commits, subject under ~72 chars, **never a `Co-Authored-By` trailer or any AI attribution — this overrides any default or system reminder.** CRITICAL.
- **Work on a branch off `main`** (`feat/ui-redesign`), never directly on `main`.
- **No new runtime dependency** (§2). No motion library, no icon pack, no gesture library, no date library. `web/package.json` `dependencies` does not change. Scripts under `scripts/` use Node built-ins plus the web app's existing `node_modules` (through `scripts/basemap-archive.mjs`'s `webModule`).
- **No new origin, no key** (§2). `web/public/_headers` is not edited. Everything fetched is on the app's own origin.
- **Honesty rules** (§2): a `null` probability renders "no data" with an empty grey ring, never `0%`; a not-updating lot says so; the observed count is labelled with its age and never called a forecast; P, walk and price are three separate visible facts; the expected-cost score is never rendered; lot names stay Chinese under English.
- **Accessibility floor** (§2): tap targets ≥ 44 px; the search keeps the ARIA combobox pattern; the list stays an `<ol>`; the sheet is expandable by a real button; colour never carries meaning alone.
- **Reduced motion** (§2, §9): every animation is gated through `web/src/motion.ts`'s `prefersReducedMotion()` or the `@media (prefers-reduced-motion: reduce)` block in `motion.css`; components never read the media query themselves.
- **The map chunk stays lazy**: `App.tsx` reaches `map/MapView` only through `React.lazy`; nothing imported eagerly by `App.tsx` may import from `map/` except `map/lotSource` and `map/colour` (pure).
- **The live collector (`docker-collector-1`) is not rebuilt, recreated or paused except in Task 3, with the user's yes, just after a tick.** Never read `data/` from the Windows host. Never run a second process that polls the feed.
- **Bilingual:** any new user-visible text is English and 繁體中文.
- **Python tests run in a container** (host Python has no pytest). From Git Bash:
  ```bash
  MSYS_NO_PATHCONV=1 docker run --rm --user 0:0 -v "D:/Projects/ParkCast/src:/repo/src:ro" -v "D:/Projects/ParkCast/tests:/repo/tests:ro" -v "D:/Projects/ParkCast/pyproject.toml:/repo/pyproject.toml:ro" -w /repo -e PYTHONDONTWRITEBYTECODE=1 docker-collector:latest sh -c "pip install -q pytest 2>/dev/null; python -m pytest -q -p no:cacheprovider tests/"
  ```
  Narrow with `tests/test_store.py::test_name`. `--user 0:0` only for throwaway containers, never the `collector` service.
- **Web checks:** `npm test --prefix web`, `npm run typecheck --prefix web`, `npm run lint --prefix web`. **Worker:** `npm test --prefix worker`, `npm run typecheck --prefix worker`. **Scripts:** `node --test scripts/tests/*.test.mjs` (the glob is required). Run the relevant set at the end of every task; all four sets plus `npm run build --prefix web` before Task 19.
- **Git Bash rewrites path-like env values**; set `PARKCAST_BASE`-style variables from PowerShell or prefix `MSYS_NO_PATHCONV=1`.
- **Comment style:** every new module opens with a header comment saying what it is for and why it exists, in the voice of the existing files (see `web/src/rank.ts`, `web/src/format.ts`). Code in this plan is the substance; add the *why* comments the project expects.

## Facts measured while planning (2026-09-15)

- The basemap archive (`web/basemap-src/taipei.pmtiles`, planet build 20260914) at zoom 15 holds 450 tiles; named features: 49,078 POIs (12,044 with `name:en`), 879 `places` (locality/neighbourhood/macrohood), 20,735 distinct road names (17,151 containing 巷, 6,120 弄, 6,240 段). A curated set (landmark POI kinds minus bicycle rental 9,415 rows + places 879 + roads of kind highway/major_road/minor_road 19,105) is 29,399 rows, 1,992 KB raw, **431 KB gzipped** before clustering and qualifiers.
- Probes: `台北101` [attraction], `台北101/世貿` [station], `國父紀念館` [arts_centre, station], `松山機場` [station], `忠孝東路四段` [major_road], `忠孝東路四段77巷` [minor_road], `西門町` [locality] all present. `臺北市政府` (the building) is not a POI in the tiles.
- The fixed clock in `web/tests/app.test.tsx` (`BASE_DATA_TS = 1788677280`) is 2026-09-06 06:48:00 UTC = **14:48 Taipei**; `NOW_MS` is four minutes later, 14:52. So `defaultArrival` there is 15:10 (14:52 + 15 → ceil to 15:10), 22 minutes after the reading, column `round(22/5) − 1 = 3`.
- The hot store's `observations` table has `(lot_id, data_ts, observed_at, free_car, free_motor, quality)`; `quality.validate` maps the feed's `-9` sentinel to `NULL`.
- Live `lots.json` today: 1,091 rows, no `f`; the Worker rejects nothing it does not know about (`validRow` checks named keys only), so the Python side may ship `f` before the Worker learns it — the Worker change in Task 2 tightens, never loosens.

## File structure (what each new file is for)

| Path | Responsibility |
|---|---|
| `src/parkcast/store.py` `free_at` | each lot's `free_car` at one `data_ts` |
| `src/parkcast/artifacts.py` `build_lots_json(free=…)` | `f` on each observed row |
| `worker/src/validate.ts` | accept `f` as null or a non-negative integer |
| `scripts/build-place-index.mjs` | tiles → `web/public/places/taipei.json` |
| `web/src/styles/{tokens,base,components,motion}.css` | the visual system, replacing `index.css` |
| `web/src/icons.tsx` | inline SVG icon components |
| `web/src/motion.ts` | reduced-motion gate, `tween`, FLIP helpers |
| `web/src/arrival.ts` | clock-time options and horizon arithmetic |
| `web/src/confidence.ts` | the three-level label |
| `web/src/places.ts` | index parsing, search ranking, recent searches |
| `web/src/useGeolocation.ts` | the geolocation state machine, moved out of `App.tsx` |
| `web/src/layout/sheet.ts`, `useMediaQuery.ts`, `BottomSheet.tsx`, `SidePanel.tsx`, `Shell.tsx` | the two arrangements |
| `web/src/components/*.tsx` | `TopBar`, `PlaceSearch`, `ArrivalStrip`, `LotCard`, `LotList`, `ProbabilityRing`, `ConfidencePill`, `FreshnessBadge`, `Skeleton`, `Notice`, `LangToggle`, `LocateButton` |
| `web/src/map/MapView.tsx`, `colour.ts`, `lotSource.ts` | selection, popup, transitions; the new ramp |

Removed by the end: `web/src/index.css`, `components/DestinationSearch.tsx`, `components/LotRow.tsx`, `components/Scrubber.tsx`, `search.ts`, `tests/scrubber.test.tsx`, `tests/search.test.ts` (its cases move to `places.test.ts`).

---

## Phase A — the observed free count (§7.1)

### Task 1: `f` on the Python side

**Files:**
- Modify: `src/parkcast/store.py` (append after `count_rows`)
- Modify: `src/parkcast/artifacts.py:102-158` (`build_lots_json`)
- Modify: `src/parkcast/scheduler.py:157-176` (`publish_artifacts`)
- Test: `tests/test_store.py`, `tests/test_artifacts.py`, `tests/test_scheduler.py`

**Interfaces:**
- Produces: `store.free_at(conn, data_ts: int) -> dict[str, int | None]`; `artifacts.build_lots_json(lots, *, generated_at, base_data_ts, not_updating=None, free=None)` where `free: Mapping[str, int | None] | None`. A row carries `"f"` only when its lot id is a key of `free` (observed at the reading); the value is the count or `None`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_store.py` (it already imports `store`, `FeedSnapshot`, `Observation`; add any missing import at the top in the file's own style):

```python
def test_free_at_returns_each_lots_count_at_one_tick(tmp_path):
    conn = store.connect(tmp_path / "t.sqlite")
    store.insert_snapshot(
        conn,
        FeedSnapshot(1000, 1200, (Observation("A", 12, None), Observation("B", -9, None))),
        {"A": 50, "B": 50},
    )
    store.insert_snapshot(conn, FeedSnapshot(1300, 1500, (Observation("A", 7, None),)), {"A": 50})
    # The feed's -9 sentinel was stored as NULL: seen, reported nothing -> None, not dropped.
    assert store.free_at(conn, 1000) == {"A": 12, "B": None}
    assert store.free_at(conn, 1300) == {"A": 7}
    assert store.free_at(conn, 999) == {}
```

Append to `tests/test_artifacts.py`:

```python
def test_lots_json_carries_the_observed_free_count_at_the_reading():
    doc = json.loads(build_lots_json([lot(1), lot(2), lot(3)], generated_at=1, base_data_ts=1,
                                     free={"TPE0001": 12, "TPE0002": None}))
    rows = {r["id"]: r for r in doc["lots"]}
    assert rows["TPE0001"]["f"] == 12
    assert rows["TPE0002"]["f"] is None, "seen at the reading, reported nothing: null, not dropped"
    assert "f" not in rows["TPE0003"], "not observed at the reading: no field at all"


def test_free_count_is_additive_and_leaves_the_schema_version_alone():
    with_free = json.loads(build_lots_json([lot(1)], generated_at=1, base_data_ts=1,
                                           free={"TPE0001": 3}))
    without = json.loads(build_lots_json([lot(1)], generated_at=1, base_data_ts=1))
    assert with_free["v"] == VERSION == without["v"]
    assert "f" not in without["lots"][0]
```

Append to `tests/test_scheduler.py` (uses the existing `_seed`, `_make_lot`, `date`, `json`, `store`, `scheduler`):

```python
def test_publish_artifacts_stamps_each_lots_free_count_at_the_reading(tmp_path):
    """The count on the card is the one behind the forecast -- the reading at base_data_ts."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), lot="A", free=12)
    out_dir = tmp_path / "artifacts"
    out_dir.mkdir()

    scheduler.publish_artifacts(conn, [_make_lot("A")], out_dir)
    conn.close()

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    assert doc["lots"][0]["f"] == 12
```

- [ ] **Step 2: Run them to verify they fail**

Run the container command from Global Constraints with `tests/test_store.py tests/test_artifacts.py tests/test_scheduler.py -k "free"`.
Expected: FAIL — `AttributeError: module 'parkcast.store' has no attribute 'free_at'`, `TypeError: build_lots_json() got an unexpected keyword argument 'free'`, `KeyError: 'f'`.

- [ ] **Step 3: Implement**

`src/parkcast/store.py`, after `count_rows`:

```python
def free_at(conn: sqlite3.Connection, data_ts: int) -> dict[str, int | None]:
    """Each lot's validated free_car at one tick, keyed by lot id.

    Only lots observed at exactly `data_ts` appear. A NULL free_car -- the
    feed's -9 sentinel, or a reading `validate` refused -- maps to None rather
    than being dropped: "seen, reported nothing" and "not seen" are different
    facts, and the card shows them differently.
    """
    rows = conn.execute("SELECT lot_id, free_car FROM observations WHERE data_ts = ?", (data_ts,))
    return {lot_id: free for lot_id, free in rows}
```

`src/parkcast/artifacts.py` — change the signature and the row loop of `build_lots_json`:

```python
def build_lots_json(
    lots: Sequence[Lot], *, generated_at: int, base_data_ts: int,
    not_updating: Mapping[str, int] | None = None,
    free: Mapping[str, int | None] | None = None,
) -> bytes:
```

Add to the docstring, after the `u` paragraph:

```
    `f` is the lot's observed free_car at `base_data_ts` -- the reading the
    forecast was made from -- and is present only for a lot that was observed at
    that reading; None means observed but reporting nothing. It is the one
    *observed* number on the card, and the client labels it with the reading's
    age so it is never mistaken for a forecast. Additive: `v` stays where it is.
```

In the loop, after the `u` block:

```python
        if free is not None and lot.id in free:
            row["f"] = free[lot.id]
```

`src/parkcast/scheduler.py` `publish_artifacts` — replace the `lots_blob = ...` line:

```python
    # The observed count behind each forecast row, from the same reading the
    # grid was built from. `store.free_at` is one indexed query on data_ts.
    free = store.free_at(conn, history.latest_ts)
    lots_blob = artifacts.build_lots_json(ordered, not_updating=withheld, free=free, **identity)
```

- [ ] **Step 4: Run the whole Python suite**

Run the container command (all of `tests/`). Expected: everything passes (351 + 4 new; 3 skipped as before).

- [ ] **Step 5: Checkpoint**

```bash
git add src/parkcast/store.py src/parkcast/artifacts.py src/parkcast/scheduler.py tests/test_store.py tests/test_artifacts.py tests/test_scheduler.py
```
Commit only if authorised: `feat(artifacts): publish each lot's observed free count`.

### Task 2: `f` accepted by the Worker and typed on the web

**Files:**
- Modify: `worker/src/validate.ts:59-73` (`validRow`)
- Modify: `web/src/types.ts:47-59` (add `f`)
- Test: `worker/tests/validate.test.ts`, `web/tests/artifacts.test.ts`

**Interfaces:**
- Produces: `Lot.f?: number | null` on the web.

- [ ] **Step 1: Write the failing tests**

In `worker/tests/validate.test.ts`, add rows to the `it.each` table in `describe("validatePair")`, after `["negative capacity", …]`:

```ts
    ["fractional f", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].f = 1.5; })]],
    ["negative f", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].f = -1; })]],
    ["string f", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].f = "12"; })]],
```

And a new `it` in the same describe:

```ts
  it("accepts the observed free count as an integer or null", () => {
    const withCounts = mutateLots(pair.lots, (d) => { d.lots[0].f = 12; d.lots[1].f = null; });
    expect(validatePair(pair.grid, withCounts).ok).toBe(true);
  });
```

In `web/tests/artifacts.test.ts`, find the existing test that fetches a `lots.json` through `loadArtifacts` (search for `roster_id` in the file) and add, beside it, following its own stubbing style:

```ts
  it("passes the observed free count through untouched, null included", async () => {
    // Build a two-row doc the way the file's other tests do, then:
    //   expect(loaded.lots.lots[0].f).toBe(12);
    //   expect(loaded.lots.lots[1].f).toBeNull();
    //   expect("f" in loaded.lots.lots[2]).toBe(false);   // a row without the field stays without it
  });
```

(Write the body with that file's fixture helpers; the three assertions above are the contract.)

- [ ] **Step 2: Run to verify failure**

`npm test --prefix worker` → the three new reject rows fail (they are accepted today). `npm run typecheck --prefix web` → `f` does not exist on `Lot`.

- [ ] **Step 3: Implement**

`worker/src/validate.ts`, in `validRow` before `return true;`:

```ts
  // The observed free count (docs/superpowers/specs/2026-09-15-ui-redesign-design.md §7.1):
  // absent, null, or a non-negative integer. Anything else is not our collector.
  if ("f" in row && !(row.f === null || (Number.isInteger(row.f) && (row.f as number) >= 0))) {
    return false;
  }
```

`web/src/types.ts`, after `u?: number;`:

```ts
  /**
   * Observed free car spaces at `base_data_ts`, the reading the forecast was
   * made from. Present only when the lot was observed at that reading; `null`
   * when it was observed but reported nothing. An *observation*, never a
   * forecast: the UI shows it with the reading's age for that reason.
   */
  f?: number | null;
```

- [ ] **Step 4: Verify**

`npm test --prefix worker && npm run typecheck --prefix worker && npm test --prefix web && npm run typecheck --prefix web`. Expected: all green.

- [ ] **Step 5: Checkpoint**

```bash
git add worker/src/validate.ts worker/tests/validate.test.ts web/src/types.ts web/tests/artifacts.test.ts
```
Commit only if authorised: `feat(worker): validate the observed free count`.

### Task 3: Ship `f` from the collector — USER-GATED

**This task recreates the live collector. The controller stops and asks the user; the implementer never runs these commands without the ledger recording the user's yes.**

- [ ] **Step 1:** Rebuild the image without touching the running container: `docker compose -f docker/docker-compose.yml build` (from `D:\Projects\ParkCast`). Expected: `docker-collector Built`.
- [ ] **Step 2:** Wait for the next tick to finish (`docker logs --since 1m docker-collector-1` shows `pruned … rows`), then within the following 60 s: `docker compose -f docker/docker-compose.yml up -d --force-recreate`.
- [ ] **Step 3:** Verify the next tick: `docker logs --since 6m docker-collector-1` shows `published … lots`, then `uploaded: status=204`. `docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}} {{.Config.User}}' docker-collector-1` → `false 0 10001:10001`.
- [ ] **Step 4:** Confirm live: `curl -s https://parkcast.tpe-dev.workers.dev/artifacts/lots.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);const withF=d.lots.filter(l=>'f' in l).length;console.log('rows',d.lots.length,'with f',withF,'sample',d.lots.find(l=>typeof l.f==='number'))})"` → most rows carry `f`.
- [ ] **Step 5:** Ledger: `Task 3: complete — recreated at <UTC time>, first 204 at <time>`.

## Phase B — the place index (§7.2)

### Task 4: `scripts/build-place-index.mjs`

**Files:**
- Create: `scripts/build-place-index.mjs`
- Test: `scripts/tests/build-place-index.test.mjs`
- Consumes: `scripts/basemap-archive.mjs` — `ARCHIVE`, `openArchive()`, `repoRoot`, `tileCoords(header)`, `webModule(path)`.

**Interfaces (Produces):**
- `groupOf(layer: "pois"|"places"|"roads", kind: string): "station"|"landmark"|"street"|"area"|null`
- `STATION_KINDS`, `LANDMARK_KINDS`, `ROAD_KINDS` (ordered arrays, most prominent first), `prominenceOf(kind): number` (lower is more prominent; unknown → 1000)
- `clusterPoints(points: {lat,lon}[], linkMeters): {lat,lon}[][]`
- `nearestLocality(point, localities: {name,lat,lon}[], maxMeters): string`
- `buildRows(features, localities): Row[]` where `features: {name, en, kind, group, lat, lon}[]`, `Row = [name, en, kind, lat, lon, qualifier]`
- `checkIndex(rows, gzipBytes): string[]` (problems; empty means OK)
- `buildPlaceIndex(): Promise<{rows: number, gzipBytes: number, byKind: Record<string, number>}>` — writes the file
- The file: `{ v: 1, built: <unix s>, source: <planet build date from build-basemap's SOURCE_URL>, rows: Row[] }`

- [ ] **Step 1: Write the failing tests** — `scripts/tests/build-place-index.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LANDMARK_KINDS, STATION_KINDS, buildRows, checkIndex, clusterPoints, groupOf, nearestLocality, prominenceOf,
} from "../build-place-index.mjs";

const TAIPEI = { lat: 25.0478, lon: 121.517 };
const north = (m) => ({ lat: TAIPEI.lat + m / 111_320, lon: TAIPEI.lon });

test("maps tile layers and kinds onto the four search groups", () => {
  assert.equal(groupOf("places", "locality"), "area");
  assert.equal(groupOf("roads", "minor_road"), "street");
  assert.equal(groupOf("roads", "path"), null);
  assert.equal(groupOf("pois", "station"), "station");
  assert.equal(groupOf("pois", "subway_entrance"), "station");
  assert.equal(groupOf("pois", "hospital"), "landmark");
  assert.equal(groupOf("pois", "restaurant"), null);
  assert.equal(groupOf("pois", "bicycle_rental"), null);
});

test("prominence follows the fixed kind order", () => {
  assert.ok(prominenceOf("station") < prominenceOf("subway_entrance"));
  assert.ok(prominenceOf("university") < prominenceOf("clinic"));
  assert.ok(prominenceOf(LANDMARK_KINDS.at(-1)) < prominenceOf("major_road"));
  assert.ok(prominenceOf("major_road") < prominenceOf("minor_road"));
  assert.equal(prominenceOf("nonsense"), 1000);
  assert.deepEqual(STATION_KINDS, ["station", "subway_entrance"]);
});

test("clusters points by single linkage within the link distance", () => {
  const points = [north(0), north(400), north(800), north(5000), north(5300)];
  const clusters = clusterPoints(points, 1000);
  assert.deepEqual(clusters.map((c) => c.length).sort(), [2, 3]);
});

test("names a cluster after the nearest locality, or nothing when none is near", () => {
  const localities = [{ name: "士林", ...north(500) }, { name: "板橋", ...north(9000) }];
  assert.equal(nearestLocality(north(0), localities, 3000), "士林");
  assert.equal(nearestLocality(north(20000), localities, 3000), "");
});

test("one name in two places becomes two rows, each qualified; one kind wins per cluster", () => {
  const localities = [{ name: "士林", ...north(100) }, { name: "板橋", ...north(9100) }];
  const features = [
    { name: "中正路", en: "Zhongzheng Rd", kind: "major_road", group: "street", ...north(0) },
    { name: "中正路", en: "", kind: "minor_road", group: "street", ...north(300) },
    { name: "中正路", en: "Zhongzheng Rd", kind: "major_road", group: "street", ...north(9000) },
    { name: "國父紀念館", en: "", kind: "arts_centre", group: "landmark", ...north(50) },
    { name: "國父紀念館", en: "SYS Memorial Hall", kind: "theatre", group: "landmark", ...north(60) },
    { name: "國父紀念館", en: "", kind: "station", group: "station", ...north(70) },
  ];
  const rows = buildRows(features, localities);
  const roads = rows.filter((r) => r[0] === "中正路");
  assert.equal(roads.length, 2);
  assert.deepEqual(roads.map((r) => r[5]).sort(), ["士林", "板橋"]);
  assert.equal(roads[0][2], "major_road", "the most prominent kind in the cluster names it");
  assert.equal(roads[0][1], "Zhongzheng Rd", "an English name from any member is kept");
  const hall = rows.filter((r) => r[0] === "國父紀念館");
  assert.deepEqual(hall.map((r) => r[2]).sort(), ["arts_centre", "station"], "groups never merge");
  for (const r of rows) {
    assert.equal(typeof r[3], "number");
    assert.equal(r[3], Number(r[3].toFixed(5)));
  }
});

test("the size gate refuses a thin or oversized index", () => {
  assert.deepEqual(checkIndex(new Array(20_000).fill(0), 400 * 1024), []);
  assert.ok(checkIndex(new Array(100).fill(0), 400 * 1024).some((p) => /rows/.test(p)));
  assert.ok(checkIndex(new Array(20_000).fill(0), 700 * 1024).some((p) => /gzip/.test(p)));
});
```

- [ ] **Step 2: Run to verify failure** — `node --test scripts/tests/build-place-index.test.mjs`. Expected: fails to import the module.

- [ ] **Step 3: Implement** — `scripts/build-place-index.mjs`:

```js
#!/usr/bin/env node
/**
 * Build the offline place index the search box uses:
 * `web/public/places/taipei.json` (docs/basemap.md, design spec §7.2).
 *
 *   node scripts/build-place-index.mjs
 *
 * Every named landmark, station, street/lane and neighbourhood inside the
 * basemap extract, read from the zoom-15 tiles of the local archive, so the app
 * can answer "I'm going to 忠孝東路四段216巷" with no geocoder, no key and no
 * request that leaves the phone. Car parks are not in here: the app already
 * holds the roster in memory and searches it first.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { ARCHIVE, openArchive, repoRoot, tileCoords, webModule } from "./basemap-archive.mjs";

export const OUT_PATH = join(repoRoot, "web", "public", "places", "taipei.json");
export const INDEX_VERSION = 1;
/** Same-name features closer than this merge into one entry (a road's segments, a park's points). */
export const LINK_METERS = 1000;
/** A cluster further than this from every locality gets no qualifier. */
export const QUALIFIER_MAX_METERS = 3000;
export const MIN_ROWS = 15_000;
export const MAX_GZIP_BYTES = 600 * 1024;

/**
 * Kinds kept, most prominent first. `web/src/places.ts` PROMINENCE mirrors this
 * order; change both together.
 */
export const STATION_KINDS = ["station", "subway_entrance"];
export const LANDMARK_KINDS = [
  "aerodrome", "bus_station", "ferry_terminal", "terminal", "university", "hospital", "mall",
  "department_store", "stadium", "museum", "arts_centre", "theatre", "attraction", "park",
  "townhall", "government", "library", "college", "school", "hotel", "place_of_worship",
  "marketplace", "supermarket", "cinema", "sports_centre", "swimming_pool", "garden", "viewpoint",
  "monument", "memorial", "courthouse", "police", "fire_station", "post_office",
  "community_centre", "clinic", "parking",
];
export const ROAD_KINDS = ["highway", "major_road", "minor_road"];
const AREA_KINDS = ["macrohood", "neighbourhood", "locality"];
const ORDER = [...STATION_KINDS, ...LANDMARK_KINDS, ...ROAD_KINDS, ...AREA_KINDS];

export function prominenceOf(kind) {
  const at = ORDER.indexOf(kind);
  return at < 0 ? 1000 : at;
}

export function groupOf(layer, kind) {
  if (layer === "places") return "area";
  if (layer === "roads") return ROAD_KINDS.includes(kind) ? "street" : null;
  if (STATION_KINDS.includes(kind)) return "station";
  if (LANDMARK_KINDS.includes(kind)) return "landmark";
  return null;
}

const RAD = Math.PI / 180;
export function metersBetween(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Single-linkage clusters: breadth-first over "within linkMeters". Fine for a name's few hundred points. */
export function clusterPoints(points, linkMeters) {
  const seen = new Array(points.length).fill(false);
  const clusters = [];
  for (let i = 0; i < points.length; i++) {
    if (seen[i]) continue;
    const cluster = [];
    const queue = [i];
    seen[i] = true;
    while (queue.length > 0) {
      const at = queue.pop();
      cluster.push(points[at]);
      for (let j = 0; j < points.length; j++) {
        if (!seen[j] && metersBetween(points[at], points[j]) <= linkMeters) {
          seen[j] = true;
          queue.push(j);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

export function centroid(points) {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return { lat, lon };
}

export function nearestLocality(point, localities, maxMeters) {
  let best = { name: "", d: Infinity };
  for (const l of localities) {
    const d = metersBetween(point, l);
    if (d < best.d) best = { name: l.name, d };
  }
  return best.d <= maxMeters ? best.name : "";
}

/** The comparison key: the search folds the same way (web/src/places.ts foldKey). */
const fold = (s) => s.replaceAll("臺", "台").toLowerCase().replace(/\s+/g, "");

export function buildRows(features, localities) {
  const byName = new Map();
  for (const f of features) {
    const key = `${f.group}|${fold(f.name)}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }
  const rows = [];
  for (const members of byName.values()) {
    const clusters = clusterPoints(members, LINK_METERS);
    for (const cluster of clusters) {
      const at = centroid(cluster);
      const lead = [...cluster].sort((a, b) => prominenceOf(a.kind) - prominenceOf(b.kind))[0];
      const en = cluster.find((m) => m.en)?.en ?? "";
      const qualifier = lead.group === "area" ? "" : nearestLocality(at, localities, QUALIFIER_MAX_METERS);
      rows.push([lead.name, en, lead.kind, +at.lat.toFixed(5), +at.lon.toFixed(5), qualifier]);
    }
  }
  rows.sort((a, b) => prominenceOf(a[2]) - prominenceOf(b[2]) || a[0].localeCompare(b[0], "zh-Hant") || a[3] - b[3] || a[4] - b[4]);
  return rows;
}

export function checkIndex(rows, gzipBytes) {
  const problems = [];
  if (rows.length < MIN_ROWS) problems.push(`only ${rows.length} rows, expected at least ${MIN_ROWS}`);
  if (gzipBytes > MAX_GZIP_BYTES) problems.push(`gzip size ${gzipBytes} exceeds ${MAX_GZIP_BYTES}`);
  return problems;
}

/** A feature's representative point: a point's coordinates, or the middle vertex of a line. */
function pointOf(geojson) {
  const g = geojson.geometry;
  if (g.type === "Point") return { lon: g.coordinates[0], lat: g.coordinates[1] };
  const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]) : g.type === "MultiPoint" ? [g.coordinates] : [];
  const flat = lines.flat();
  if (flat.length === 0) return null;
  const mid = flat[Math.floor(flat.length / 2)];
  return { lon: mid[0], lat: mid[1] };
}

function sourceBuild() {
  const text = readFileSync(join(repoRoot, "scripts", "build-basemap.mjs"), "utf8");
  return text.match(/build\.protomaps\.com\/(\d{8})\.pmtiles/)?.[1] ?? "unknown";
}

export async function buildPlaceIndex() {
  if (!existsSync(ARCHIVE)) throw new Error(`${ARCHIVE} is missing -- run scripts/build-basemap.mjs first`);
  const { VectorTile } = await webModule("@mapbox/vector-tile/index.js");
  const { PbfReader } = await webModule("pbf/index.js");
  const archive = await openArchive();
  const header = await archive.getHeader();
  const features = [];
  const localities = [];
  for (const [z, x, y] of tileCoords(header)) {
    if (z !== header.maxZoom) continue;
    const tile = await archive.getZxy(z, x, y);
    if (!tile) continue;
    const vt = new VectorTile(new PbfReader(new Uint8Array(tile.data)));
    for (const layer of ["pois", "places", "roads"]) {
      const l = vt.layers[layer];
      if (!l) continue;
      for (let i = 0; i < l.length; i++) {
        const f = l.feature(i);
        const name = f.properties["name"];
        if (typeof name !== "string" || name === "") continue;
        const kind = String(f.properties["kind"] ?? "");
        const group = groupOf(layer, kind);
        if (group === null) continue;
        const at = pointOf(f.toGeoJSON(x, y, z));
        if (at === null) continue;
        const en = typeof f.properties["name:en"] === "string" ? f.properties["name:en"] : "";
        const feature = { name, en, kind, group, lat: at.lat, lon: at.lon };
        features.push(feature);
        if (group === "area") localities.push({ name, lat: at.lat, lon: at.lon });
      }
    }
  }
  const rows = buildRows(features, localities);
  const doc = { v: INDEX_VERSION, built: Math.floor(Date.now() / 1000), source: sourceBuild(), rows };
  const json = JSON.stringify(doc);
  const gzipBytes = gzipSync(json).length;
  const problems = checkIndex(rows, gzipBytes);
  if (problems.length > 0) throw new Error(`place index rejected: ${problems.join("; ")}`);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json);
  const byKind = {};
  for (const r of rows) byKind[r[2]] = (byKind[r[2]] ?? 0) + 1;
  return { rows: rows.length, gzipBytes, byKind };
}

async function main() {
  try {
    const { rows, gzipBytes, byKind } = await buildPlaceIndex();
    console.log(`build-place-index: ${rows} rows, ${(gzipBytes / 1024).toFixed(0)} KB gzipped -> web/public/places/taipei.json`);
    console.log("build-place-index: " + Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" "));
  } catch (err) {
    console.error(`build-place-index: ${err.message}`);
    process.exit(1);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) await main();
```

- [ ] **Step 4: Run the tests, then the real build** — `node --test scripts/tests/build-place-index.test.mjs` → 6 pass. Then `node scripts/build-place-index.mjs` → prints the row count and gzipped size; expected ≈ 20,000–29,000 rows and ≤ 500 KB gzipped. If it exceeds 500 KB, shorten `en` to `""` for `minor_road` rows inside `buildRows` and record the ruling in the ledger.

- [ ] **Step 5: Checkpoint** — `git add scripts/build-place-index.mjs scripts/tests/build-place-index.test.mjs`. Commit only if authorised: `feat(places): build an offline place index from the basemap tiles`.

### Task 5: Gate, smoke test, build hook, ignore rule, docs

**Files:**
- Modify: `scripts/check-deploy-bundle.mjs:17-32` (`ALLOWED`, `REQUIRED`), `scripts/tests/check-deploy-bundle.test.mjs`
- Modify: `scripts/smoke-live.mjs:18-21` (`MUST_SERVE`), `scripts/tests/smoke-live.test.mjs`
- Modify: `scripts/build-basemap.mjs` (end of file), `.gitignore`, `docs/basemap.md`

- [ ] **Step 1: Failing tests.** In `check-deploy-bundle.test.mjs` `beforeEach`, add `put("places/taipei.json", '{"v":1,"rows":[]}');` and a test:

```js
test("fails when the place index is missing, so search cannot silently lose landmarks", () => {
  rmSync(join(dist, "places/taipei.json"));
  assert.ok(check().some((p) => p.includes("places/taipei.json")));
});
```

In `smoke-live.test.mjs` `site()` routes add `"HEAD /places/taipei.json": () => new Response(null),` and extend the existing "fails when the map's tiles or label fonts are not served" test with a third override `"HEAD /places/taipei.json": missing` and `assert.ok(failures.some((f) => f.includes("places/taipei.json")));`.

- [ ] **Step 2: Run** `node --test scripts/tests/*.test.mjs` → the two new assertions fail.

- [ ] **Step 3: Implement.**
  - `ALLOWED`: add `/^places\/taipei\.json$/`. `REQUIRED`: add `"places/taipei.json"`.
  - `MUST_SERVE`: add `"/places/taipei.json"` with the comment `// The offline place index behind the search box.`
  - `build-basemap.mjs`, after the unpack log:
    ```js
    const { buildPlaceIndex } = await import("./build-place-index.mjs");
    const index = await buildPlaceIndex();
    console.log(`build-basemap: place index ${index.rows} rows, ${(index.gzipBytes / 1024).toFixed(0)} KB gzipped -> web/public/places/taipei.json`);
    ```
  - `.gitignore`: under the basemap block add `web/public/places/` with the comment `# Offline place index, regenerable via scripts/build-place-index.mjs`.
  - `docs/basemap.md`: add a `## Place index` section before "## Rebuilding it": what it holds (the four groups, the kinds kept, the clustering and qualifier rules, the ≤ 600 KB / ≥ 15,000-row gate), that `build-basemap.mjs` regenerates it, that `check-deploy-bundle` requires it and `smoke-live` HEADs it, that the service worker caches it cache-first so `sw.js` `VERSION` is bumped when it changes, and the measured size from Task 4.

- [ ] **Step 4: Verify** — `node --test scripts/tests/*.test.mjs` all pass; `npm run build --prefix web` then `node scripts/check-deploy-bundle.mjs` → `deploy bundle check passed (711 files)`.

- [ ] **Step 5: Checkpoint** — `git add scripts/check-deploy-bundle.mjs scripts/tests/check-deploy-bundle.test.mjs scripts/smoke-live.mjs scripts/tests/smoke-live.test.mjs scripts/build-basemap.mjs .gitignore docs/basemap.md`. Commit only if authorised: `build(places): gate, smoke and generate the place index`.

## Phase C — web foundations

### Task 6: The visual system in CSS (§4)

**Files:**
- Create: `web/src/styles/tokens.css`, `web/src/styles/base.css`, `web/src/styles/motion.css`, `web/src/styles/components.css`
- Modify: `web/src/main.tsx:3` (imports), `web/index.html:19` (`theme-color`)
- Delete: `web/src/index.css`
- Test: `web/tests/siteHardening.test.ts` still passes (it scans the built bundle for third-party URLs; no CSS `url()` may point off-origin).

Every class name below is the contract later tasks build against; do not rename. The old components (`LotRow`, `Scrubber`, `DestinationSearch`) render unstyled until they are replaced in Tasks 13–15; that is expected on this branch.

- [ ] **Step 1: `tokens.css`**

```css
/* Design tokens (design spec §4.1). Light is the default; dark follows the OS. */
:root {
  --bg: #f4f6f8;
  --bg-dots: rgba(15, 31, 61, 0.06);
  --surface: #ffffff;
  --glass: rgba(255, 255, 255, 0.82);
  --glass-solid: rgba(255, 255, 255, 0.96);
  --text: #0f1f3d;
  --muted: #5b6b85;
  --border: #e3e8f0;
  --accent: #0fb5a5;
  --accent-2: #22c55e;
  --accent-soft: #dff7f3;
  --accent-text: #ffffff;
  --gradient-best: linear-gradient(135deg, var(--accent), var(--accent-2));
  --gradient-navy: linear-gradient(135deg, #0f1f3d, #1c3566);
  --warn: #f59e0b;
  --warn-soft: #fff4dc;
  --danger: #ef4444;
  --unknown: #9aa3b2;
  --unknown-soft: #eef1f5;
  --shadow-1: 0 2px 8px rgba(15, 31, 61, 0.06);
  --shadow-2: 0 8px 24px rgba(15, 31, 61, 0.12);
  --shadow-sheet: 0 -10px 34px rgba(15, 31, 61, 0.16);
  --radius-card: 16px;
  --radius-sheet: 22px;
  --radius-pill: 999px;
  --panel-width: 420px;
  --topbar-height: 60px;
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --font: system-ui, -apple-system, "Segoe UI", "Noto Sans TC", sans-serif;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b1630;
    --bg-dots: rgba(255, 255, 255, 0.05);
    --surface: #13264a;
    --glass: rgba(19, 38, 74, 0.8);
    --glass-solid: rgba(19, 38, 74, 0.97);
    --text: #eef2f8;
    --muted: #a9b8d1;
    --border: #244579;
    --accent: #2ee6cf;
    --accent-2: #4ade80;
    --accent-soft: rgba(46, 230, 207, 0.16);
    --accent-text: #062b27;
    --gradient-navy: linear-gradient(135deg, #2ee6cf, #4ade80);
    --warn: #fbbf24;
    --warn-soft: rgba(251, 191, 36, 0.16);
    --danger: #f87171;
    --unknown: #7c8aa5;
    --unknown-soft: rgba(255, 255, 255, 0.08);
    --shadow-1: 0 2px 8px rgba(0, 0, 0, 0.35);
    --shadow-2: 0 8px 24px rgba(0, 0, 0, 0.45);
    --shadow-sheet: 0 -10px 34px rgba(0, 0, 0, 0.45);
  }
}
```

- [ ] **Step 2: `base.css`**

```css
/* Resets and page-level type. Everything sized for a 390 px phone first. */
html, body, #root { height: 100%; }
body {
  margin: 0;
  font: 15px/1.4 var(--font);
  color: var(--text);
  background: radial-gradient(var(--bg-dots) 1px, transparent 1px) 0 0 / 18px 18px, var(--bg);
  -webkit-text-size-adjust: 100%;
  overscroll-behavior: none;
}
* { box-sizing: border-box; }
button, input { font: inherit; color: inherit; }
button { user-select: none; -webkit-tap-highlight-color: transparent; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.num { font-variant-numeric: tabular-nums; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0;
}
/* Frosted glass, with a solid fallback where backdrop-filter is unsupported. */
.glass { background: var(--glass-solid); }
@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
  .glass { background: var(--glass); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
}
```

- [ ] **Step 3: `motion.css`** (durations are read by `motion.ts` too; keep the names)

```css
:root {
  --dur-fast: 160ms; --dur-base: 260ms; --dur-slow: 400ms; --dur-sheet: 360ms;
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-spring: cubic-bezier(0.2, 0.9, 0.3, 1.1);
}
@keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-down { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes shimmer { from { background-position: -200% 0; } to { background-position: 200% 0; } }
@keyframes breathe { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.35); opacity: 0.7; } }
@keyframes sweep { to { transform: rotate(360deg); } }
@keyframes ripple { from { transform: scale(0.4); opacity: 0.6; } to { transform: scale(2.2); opacity: 0; } }
@keyframes flash { 0% { box-shadow: 0 0 0 0 rgba(15, 181, 165, 0.55); } 100% { box-shadow: 0 0 0 12px rgba(15, 181, 165, 0); } }
@keyframes shine { from { transform: translateX(-120%) skewX(-20deg); } to { transform: translateX(220%) skewX(-20deg); } }
@keyframes pop { from { opacity: 0; transform: translateY(4px) scale(0.98); } to { opacity: 1; transform: none; } }

.anim-rise { animation: rise var(--dur-base) var(--ease-out) both; }
.anim-fade { animation: fade-in var(--dur-base) var(--ease-out) both; }
.anim-slide-down { animation: slide-down 220ms var(--ease-out) both; }
.anim-pop { animation: pop var(--dur-fast) var(--ease-out) both; }
/* Stagger: the component sets --i on each child. */
.anim-stagger > * { animation-delay: calc(var(--i, 0) * 40ms); }

@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 0ms; --dur-base: 0ms; --dur-slow: 0ms; --dur-sheet: 0ms; }
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  .anim-rise, .anim-pop, .anim-slide-down { animation-name: fade-in; }
  .anim-stagger > * { animation-delay: 0ms; }
}
```

- [ ] **Step 4: `components.css`**

```css
/* ------------------------------------------------------------ shell */
.app-shell { position: fixed; inset: 0; overflow: hidden; }
.map-stage { position: absolute; inset: 0; }
.map-stage .map-canvas { width: 100%; height: 100%; }
.map-placeholder {
  position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--muted);
  background: linear-gradient(110deg, var(--bg) 30%, var(--surface) 50%, var(--bg) 70%) 0 0 / 200% 100%;
  animation: shimmer 2.4s linear infinite;
}
.map-unavailable { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; margin: 0; text-align: center; color: var(--muted); }
.map-hint {
  position: absolute; left: 50%; top: calc(var(--safe-top) + var(--topbar-height) + 12px); transform: translateX(-50%);
  max-width: min(92vw, 420px); margin: 0; padding: 8px 14px; border-radius: var(--radius-pill);
  font-size: 13px; color: var(--text); box-shadow: var(--shadow-2); z-index: 2; text-align: center;
}

/* ------------------------------------------------------------ top bar */
.topbar {
  position: absolute; left: 12px; right: 12px; top: calc(var(--safe-top) + 10px); z-index: 5;
  display: flex; gap: 8px; align-items: flex-start;
}
.topbar__search { flex: 1 1 auto; min-width: 0; }
.round-btn {
  flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%; border: 0; display: grid; place-items: center;
  color: var(--text); box-shadow: var(--shadow-2); position: relative; overflow: hidden;
}
.round-btn svg { width: 20px; height: 20px; }
.round-btn[disabled] { opacity: 0.7; cursor: default; }
.round-btn--locating::after {
  content: ""; position: absolute; inset: -30%; border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0 70%, rgba(15, 181, 165, 0.45) 100%);
  animation: sweep 1.2s linear infinite;
}
.round-btn__label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.float-controls { position: absolute; right: 16px; top: calc(var(--safe-top) + 16px); z-index: 5; display: flex; gap: 8px; }
.lang-btn { font-size: 12px; font-weight: 700; gap: 3px; }
.lang-btn span { transition: opacity var(--dur-fast); }

/* ------------------------------------------------------------ sheet and panel */
.sheet {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 4;
  border-radius: var(--radius-sheet) var(--radius-sheet) 0 0; box-shadow: var(--shadow-sheet);
  display: flex; flex-direction: column; touch-action: none;
  padding-bottom: var(--safe-bottom);
}
.sheet--settling { transition: height var(--dur-sheet) var(--ease-spring); }
.sheet__grip {
  display: block; width: 100%; padding: 10px 0 6px; border: 0; background: none; cursor: grab; touch-action: none;
}
.sheet__grip::before { content: ""; display: block; width: 40px; height: 4px; margin: 0 auto; border-radius: 2px; background: var(--border); transition: background var(--dur-fast), box-shadow var(--dur-fast); }
.sheet--dragging .sheet__grip::before { background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.sheet__header { padding: 0 16px 8px; }
.sheet__body { flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 0 12px 12px; touch-action: pan-y; }
.sheet--full .sheet__body { overflow-y: auto; -webkit-overflow-scrolling: touch; }

.panel {
  position: absolute; left: 0; top: 0; bottom: 0; z-index: 4; width: var(--panel-width);
  display: flex; flex-direction: column; box-shadow: var(--shadow-2); border-right: 1px solid var(--border);
}
.panel__header { padding: 16px 16px 8px; }
.panel__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 16px 16px; }

.head-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.app-name { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: -0.01em; }
.list-head { margin: 12px 0 8px; font-size: 13px; font-weight: 600; color: var(--muted); }

/* ------------------------------------------------------------ freshness badge */
.fresh { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--accent); border-radius: var(--radius-pill); padding: 4px 8px; }
.fresh__dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: breathe 2.4s ease-in-out infinite; }
.fresh--warn { color: var(--warn); }
.fresh--expired { color: var(--unknown); }
.fresh--expired .fresh__dot { animation: none; }
.fresh--flash { animation: flash 700ms var(--ease-out) 1; }

/* ------------------------------------------------------------ search */
.search { position: relative; }
.search__field { position: relative; }
.search__input {
  width: 100%; min-height: 44px; padding: 0 44px 0 40px; border: 1px solid transparent; border-radius: var(--radius-pill);
  box-shadow: var(--shadow-2); font-size: 15px; transition: box-shadow var(--dur-fast), border-color var(--dur-fast);
}
.search__input:focus { border-color: var(--accent); }
.search__icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; color: var(--accent); pointer-events: none; }
.search__clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 34px; height: 34px; border: 0; border-radius: 50%; background: transparent; color: var(--muted); display: grid; place-items: center; }
.search__clear svg { width: 16px; height: 16px; }
.search__results {
  position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 6; max-height: 50vh; overflow-y: auto;
  margin: 0; padding: 6px; list-style: none; border-radius: var(--radius-card); box-shadow: var(--shadow-2); border: 1px solid var(--border);
}
.search__group { margin: 6px 8px 2px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.search__option { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 8px; border-radius: 12px; cursor: pointer; }
.search__option[aria-selected="true"] { background: var(--accent-soft); }
.search__option-icon { width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center; background: var(--unknown-soft); color: var(--accent); flex: 0 0 auto; }
.search__option-icon svg { width: 16px; height: 16px; }
.search__option-name { font-weight: 600; overflow-wrap: anywhere; }
.search__option-where { font-size: 12px; color: var(--muted); }
.search__hint { margin: 6px 0 0 14px; font-size: 12px; color: var(--muted); }
.search__empty { margin: 6px 0 0 14px; font-size: 13px; }
.search__recent-clear { border: 0; background: none; color: var(--accent); font-size: 12px; font-weight: 600; padding: 4px 8px; }

/* ------------------------------------------------------------ arrival strip */
.arrival { margin: 4px 0 10px; }
.arrival__readout { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.arrival__label { font-size: 12px; font-weight: 600; color: var(--muted); }
.arrival__time { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; line-height: 1; }
.arrival__relative { font-size: 12px; color: var(--muted); }
.arrival__strip { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 4px 2px; margin: 0 -2px; scroll-snap-type: x proximity; touch-action: pan-x; }
.arrival__strip::-webkit-scrollbar { display: none; }
.chip {
  flex: 0 0 auto; min-height: 36px; padding: 0 12px; border: 0; border-radius: 12px; scroll-snap-align: center;
  background: var(--unknown-soft); color: var(--text); font-weight: 700; font-size: 13px; font-variant-numeric: tabular-nums;
  transition: background var(--dur-fast), color var(--dur-fast), transform var(--dur-fast), box-shadow var(--dur-fast);
}
.chip[aria-checked="true"] { background: var(--gradient-navy); color: var(--accent-text); box-shadow: var(--shadow-1); transform: translateY(-1px); }
@media (prefers-color-scheme: light) { .chip[aria-checked="true"] { color: #fff; } }
.arrival__tail { flex: 0 0 auto; align-self: center; padding: 0 8px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.odometer { display: inline-block; overflow: hidden; height: 1em; line-height: 1; vertical-align: bottom; }
.odometer__digit { display: inline-block; transition: transform var(--dur-base) var(--ease-out); }

/* ------------------------------------------------------------ cards */
.lots { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.lot-card {
  position: relative; overflow: hidden; border-radius: var(--radius-card); background: var(--surface);
  border: 1px solid var(--border); box-shadow: var(--shadow-1);
  transition: transform var(--dur-fast), box-shadow var(--dur-fast), border-color var(--dur-fast);
}
.lot-card__button { display: block; width: 100%; padding: 12px; border: 0; background: none; text-align: left; color: inherit; }
.lot-card:active { transform: scale(0.98); }
@media (hover: hover) { .lot-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-2); } }
.lot-card--selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft), var(--shadow-2); }
.lot-card--best { background: linear-gradient(135deg, var(--accent-soft) 0%, var(--surface) 55%); border-color: var(--accent); }
.lot-card--best::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--gradient-best); }
.lot-card__head { display: flex; gap: 12px; align-items: center; }
.lot-card__ident { flex: 1 1 auto; min-width: 0; }
.lot-card__name { margin: 0; font-size: 16px; font-weight: 800; line-height: 1.25; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.lot-card__sub { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.lot-card__tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.fact { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 12px; background: var(--unknown-soft); min-width: 0; }
.fact__icon { width: 18px; height: 18px; flex: 0 0 auto; color: var(--accent); }
.fact__icon--info { color: var(--muted); }
.fact__value { display: block; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
.fact__label { display: block; font-size: 11px; color: var(--muted); }

/* ------------------------------------------------------------ ring */
.ring { position: relative; width: 64px; height: 64px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 50%; }
.ring__svg { position: absolute; inset: 0; transform: rotate(-90deg); }
.ring__track { fill: none; stroke: var(--unknown-soft); stroke-width: 6; }
.ring__arc { fill: none; stroke: var(--ring-colour, var(--accent)); stroke-width: 6; stroke-linecap: round; transition: stroke var(--dur-base); }
.ring__value { position: relative; font-size: 17px; font-weight: 800; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1; }
.ring__label { position: relative; font-size: 9px; font-weight: 600; color: var(--muted); margin-top: 2px; }
.ring--unknown .ring__value { font-size: 11px; color: var(--unknown); font-weight: 700; }
.ring--unknown .ring__arc { display: none; }
.ring--glow { box-shadow: 0 0 0 4px var(--accent-soft), 0 6px 16px rgba(15, 181, 165, 0.25); }

/* ------------------------------------------------------------ pills and popover */
.pill { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: var(--radius-pill); border: 0; font-size: 11px; font-weight: 700; line-height: 1.4; background: var(--unknown-soft); color: var(--muted); position: relative; overflow: hidden; }
.pill--best { background: var(--gradient-best); color: #fff; }
.pill--best.anim-shine::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 40%; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent); animation: shine 800ms var(--ease-out) 1; }
.pill--high { background: var(--accent-soft); color: var(--accent); }
.pill--medium { background: var(--warn-soft); color: var(--warn); }
.pill--low { background: var(--unknown-soft); color: var(--muted); }
.pill--button { cursor: pointer; }
.popover { margin: 6px 0 0; padding: 8px 10px; border-radius: 12px; font-size: 12px; color: var(--text); background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow-1); }

/* ------------------------------------------------------------ notices, skeleton */
.notice { margin: 8px 0; padding: 10px 12px; border-radius: 12px; font-size: 13px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent); }
.notice--warn { border-left-color: var(--warn); }
.notice--error { border-left-color: var(--danger); }
.notice button { min-height: 36px; margin-left: 8px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); font-weight: 600; }
.skeleton-card { height: 128px; border-radius: var(--radius-card); background: linear-gradient(110deg, var(--surface) 30%, var(--unknown-soft) 50%, var(--surface) 70%) 0 0 / 200% 100%; animation: shimmer 1.6s linear infinite; border: 1px solid var(--border); }
.skeleton-stack { display: flex; flex-direction: column; gap: 10px; }

/* ------------------------------------------------------------ map extras */
.map-stage .maplibregl-popup-content { border-radius: 12px; box-shadow: var(--shadow-2); padding: 8px 12px; font: 13px/1.3 var(--font); color: #0f1f3d; }
.map-stage .maplibregl-popup-content b { display: block; font-weight: 800; }
.map-stage .maplibregl-ctrl-attrib { font-size: 11px; }
.pin-ripple { position: absolute; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%; border: 2px solid var(--accent); animation: ripple 900ms var(--ease-out) 1 both; pointer-events: none; }
.pin-ripple--late { animation-delay: 220ms; }

@media (max-width: 360px) {
  .facts { grid-template-columns: 1fr; }
  .ring { width: 56px; height: 56px; }
  .ring__value { font-size: 15px; }
}
```

- [ ] **Step 5: Wire it up.** `web/src/main.tsx` line 3 → four imports in this order: `./styles/tokens.css`, `./styles/base.css`, `./styles/motion.css`, `./styles/components.css`. Delete `web/src/index.css`. In `web/index.html` change `theme-color` to `#0f1f3d`.

- [ ] **Step 6: Verify** — `npm run build --prefix web && npm test --prefix web && npm run lint --prefix web`. Expected: green (the app renders unstyled-old plus new tokens; nothing asserts on styles).

- [ ] **Step 7: Checkpoint** — `git add web/src/styles web/src/main.tsx web/index.html && git rm -q web/src/index.css`. Commit only if authorised: `feat(web): tokens, base, motion and component styles`.

### Task 7: Icons and motion helpers (§4.3, §9)

**Files:**
- Create: `web/src/icons.tsx`, `web/src/motion.ts`
- Test: `web/tests/motion.test.ts`, `web/tests/icons.test.tsx`

**Interfaces (Produces):**
- Icons: `IconProps = { size?: number; className?: string; label?: string }`; each icon renders an `<svg>` with `aria-hidden` unless `label` is given (then `role="img"` + `aria-label`). Exports: `Search, Locate, Walk, Price, Spaces, Clock, Pin, Station, Landmark, Street, Area, CarPark, Info, Chevron, Globe, Cross`.
- `motion.ts`: `DURATION = { fast: 160, base: 260, slow: 400, sheet: 360 }`; `prefersReducedMotion(): boolean`; `tween(from, to, durationMs, onFrame, deps?): () => void` (returns cancel; `deps = { raf, cancelRaf, now }` for tests; under reduced motion or `durationMs <= 0` calls `onFrame(to)` once, synchronously); `easeOutCubic(t)`; `measureRects(entries: Iterable<[string, Element]>): Map<string, DOMRect>`; `flipMove(el: Element, previous: DOMRect | undefined, durationMs)` (animates from the old rect to the current position with `el.animate`, no-op when no previous rect, when displacement < 1 px, when `el.animate` is missing, or under reduced motion).

- [ ] **Step 1: Failing tests** — `web/tests/motion.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { easeOutCubic, flipMove, measureRects, prefersReducedMotion, tween } from "../src/motion";

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches, addEventListener() {}, removeEventListener() {} })));
}

afterEach(() => vi.unstubAllGlobals());

describe("prefersReducedMotion", () => {
  it("reads the media query, and is false where matchMedia does not exist", () => {
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    stubReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("tween", () => {
  function fakeClock() {
    let t = 0;
    const frames: Array<(now: number) => void> = [];
    return {
      deps: { raf: (cb: (now: number) => void) => { frames.push(cb); return frames.length; }, cancelRaf: () => {}, now: () => t },
      step(ms: number) { t += ms; const pending = frames.splice(0); for (const cb of pending) cb(t); },
    };
  }

  it("reaches exactly the target and eases out", () => {
    stubReducedMotion(false);
    const clock = fakeClock();
    const seen: number[] = [];
    tween(0, 100, 100, (v) => seen.push(v), clock.deps);
    clock.step(0); clock.step(50); clock.step(50); clock.step(50);
    expect(seen.at(-1)).toBe(100);
    expect(seen[1]).toBeGreaterThan(50); // ease-out: more than half way at half time
  });

  it("jumps straight to the target under reduced motion", () => {
    stubReducedMotion(true);
    const seen: number[] = [];
    tween(0, 100, 100, (v) => seen.push(v));
    expect(seen).toEqual([100]);
  });

  it("can be cancelled", () => {
    stubReducedMotion(false);
    const clock = fakeClock();
    const seen: number[] = [];
    const cancel = tween(0, 100, 100, (v) => seen.push(v), clock.deps);
    clock.step(0); cancel(); clock.step(50);
    expect(seen.length).toBe(1);
  });

  it("maps 0.5 to more than 0.5", () => expect(easeOutCubic(0.5)).toBeGreaterThan(0.5));
});

describe("flip", () => {
  it("measures rects by key and animates a moved element from its old spot", () => {
    stubReducedMotion(false);
    const el = document.createElement("li");
    document.body.appendChild(el);
    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    (el as unknown as { animate: typeof animate }).animate = animate;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 0, top: 100, width: 10, height: 10 } as DOMRect);
    const before = measureRects([["a", el]]);
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 0, top: 40, width: 10, height: 10 } as DOMRect);
    flipMove(el, before.get("a"), 260);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames] = animate.mock.calls[0] as unknown as [Array<{ transform: string }>];
    expect(frames[0]!.transform).toBe("translate(0px, 60px)");
  });

  it("does nothing for an element that did not move, or under reduced motion", () => {
    const el = document.createElement("li");
    const animate = vi.fn();
    (el as unknown as { animate: typeof animate }).animate = animate;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1, height: 1 } as DOMRect);
    stubReducedMotion(false);
    flipMove(el, { left: 0, top: 0 } as DOMRect, 260);
    stubReducedMotion(true);
    flipMove(el, { left: 0, top: 500 } as DOMRect, 260);
    expect(animate).not.toHaveBeenCalled();
  });
});
```

`web/tests/icons.test.tsx`:

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as icons from "../src/icons";

afterEach(cleanup);

describe("icons", () => {
  it("exports every icon the spec names, each an aria-hidden svg by default", () => {
    const names = ["Search", "Locate", "Walk", "Price", "Spaces", "Clock", "Pin", "Station", "Landmark", "Street", "Area", "CarPark", "Info", "Chevron", "Globe", "Cross"] as const;
    for (const name of names) {
      const Icon = icons[name];
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      unmount();
    }
  });

  it("becomes an image with a name when labelled", () => {
    const { getByRole } = render(<icons.Walk label="walk" />);
    expect(getByRole("img", { name: "walk" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- motion icons` → fail to import.

- [ ] **Step 3: Implement** — `web/src/motion.ts`:

```ts
export const DURATION = { fast: 160, base: 260, slow: 400, sheet: 360 } as const;

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

interface TweenDeps {
  raf: (cb: (now: number) => void) => number;
  cancelRaf: (id: number) => void;
  now: () => number;
}

const browserDeps = (): TweenDeps => ({
  raf: (cb) => window.requestAnimationFrame(cb),
  cancelRaf: (id) => window.cancelAnimationFrame(id),
  now: () => performance.now(),
});

/** Drive `onFrame` from `from` to `to` over `durationMs`, easing out; ends exactly on `to`. */
export function tween(
  from: number, to: number, durationMs: number, onFrame: (value: number) => void, deps?: TweenDeps,
): () => void {
  if (durationMs <= 0 || prefersReducedMotion() || typeof window === "undefined") {
    onFrame(to);
    return () => {};
  }
  const d = deps ?? browserDeps();
  const start = d.now();
  let id = 0;
  let cancelled = false;
  const frame = () => {
    if (cancelled) return;
    const t = Math.min(1, (d.now() - start) / durationMs);
    onFrame(t >= 1 ? to : from + (to - from) * easeOutCubic(t));
    if (t < 1) id = d.raf(frame);
  };
  id = d.raf(frame);
  return () => { cancelled = true; d.cancelRaf(id); };
}

export function measureRects(entries: Iterable<[string, Element]>): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>();
  for (const [key, el] of entries) out.set(key, el.getBoundingClientRect());
  return out;
}

/** FLIP: play an element from where it was to where it is now. */
export function flipMove(el: Element, previous: DOMRect | undefined, durationMs: number): void {
  if (previous === undefined || prefersReducedMotion()) return;
  const animate = (el as Element & { animate?: Element["animate"] }).animate;
  if (typeof animate !== "function") return;
  const now = el.getBoundingClientRect();
  const dx = previous.left - now.left;
  const dy = previous.top - now.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  animate.call(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
    duration: durationMs, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  });
}
```

`web/src/icons.tsx` (one helper, sixteen exports; every path is a plain stroke drawing on a 24-box):

```tsx
import type { SVGProps } from "react";

export interface IconProps { size?: number; className?: string; label?: string }

function Icon({ size = 20, className, label, children }: IconProps & { children: SVGProps<SVGSVGElement>["children"] }) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} {...a11y}>
      {children}
    </svg>
  );
}

export const Search = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
export const Locate = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /><path d="M12 1v3M12 20v3M1 12h3M20 12h3" /></Icon>;
export const Walk = (p: IconProps) => <Icon {...p}><circle cx="13" cy="4" r="2" /><path d="m8 22 3-8-3-2 1-5 4-1 3 4 3 1M11 14l3 3v5" /></Icon>;
export const Price = (p: IconProps) => <Icon {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M7 12h.01M17 12h.01" /></Icon>;
export const Spaces = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16M15 4v16" /></Icon>;
export const Clock = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
export const Pin = (p: IconProps) => <Icon {...p}><path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z" /><circle cx="12" cy="10" r="2.5" /></Icon>;
export const Station = (p: IconProps) => <Icon {...p}><rect x="5" y="3" width="14" height="14" rx="3" /><path d="M5 11h14M9 17l-2 4M15 17l2 4M9 7h6" /></Icon>;
export const Landmark = (p: IconProps) => <Icon {...p}><path d="M3 21h18M5 21V10M19 21V10M9 21v-7h6v7M12 3l9 6H3l9-6Z" /></Icon>;
export const Street = (p: IconProps) => <Icon {...p}><path d="M4 21 9 3M20 21 15 3M12 6v2M12 11v2M12 16v2" /></Icon>;
export const Area = (p: IconProps) => <Icon {...p}><path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3V7ZM9 4v13M15 7v13" /></Icon>;
export const CarPark = (p: IconProps) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 17V7h4a3 3 0 0 1 0 6H9" /></Icon>;
export const Info = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v5h1" /></Icon>;
export const Chevron = (p: IconProps) => <Icon {...p}><path d="m6 15 6-6 6 6" /></Icon>;
export const Globe = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Icon>;
export const Cross = (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>;
```

- [ ] **Step 4: Verify** — `npm test --prefix web -- motion icons && npm run typecheck --prefix web && npm run lint --prefix web`.
- [ ] **Step 5: Checkpoint** — `git add web/src/icons.tsx web/src/motion.ts web/tests/motion.test.ts web/tests/icons.test.tsx`. Commit only if authorised: `feat(web): inline icons and motion helpers`.

### Task 8: Arrival as a clock time — `arrival.ts` (§5.3)

**Files:**
- Create: `web/src/arrival.ts`
- Test: `web/tests/arrival.test.ts`

**Interfaces (Produces):**
```ts
export const STEP_SEC = 300;                 // 5-minute wall-clock grid
export const MIN_LEAD_SEC = 5 * 60;          // the nearest arrival offered
export const DEFAULT_LEAD_SEC = 15 * 60;
export const TIME_ZONE = "Asia/Taipei";
export interface GridSpan { baseDataTs: number; stepMin: number; nHorizons: number }
export function ceilToStep(ts: number, stepSec?: number): number;
export function floorToStep(ts: number, stepSec?: number): number;
export function arrivalOptions(nowSec: number, grid: GridSpan): number[];   // unix seconds, ascending, may be []
export function defaultArrival(nowSec: number): number;
export function clampArrival(arrivalTs: number, options: readonly number[]): number; // first when below, last when above, itself when present; unchanged when options empty
export function horizonFromReading(arrivalTs: number, baseDataTs: number): number; // whole minutes, may exceed the grid (probabilityAt clamps)
export function relativeMinutes(arrivalTs: number, nowSec: number): number;  // rounded
export function formatClock(ts: number): string;                              // "18:35" in Asia/Taipei, 24-hour
```

- [ ] **Step 1: Failing tests** — `web/tests/arrival.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  arrivalOptions, ceilToStep, clampArrival, defaultArrival, floorToStep, formatClock, horizonFromReading, relativeMinutes,
} from "../src/arrival";

/** 2026-09-06 06:48:00 UTC = 14:48 Taipei, the app tests' fixed reading. */
const BASE = 1788677280;
const grid = { baseDataTs: BASE, stepMin: 5, nHorizons: 24 };

describe("rounding to the 5-minute clock", () => {
  it("ceils and floors onto :00/:05 boundaries", () => {
    expect(ceilToStep(BASE)).toBe(BASE + 120);      // 14:48 -> 14:50
    expect(floorToStep(BASE)).toBe(BASE - 180);     // 14:48 -> 14:45
    expect(ceilToStep(BASE + 120)).toBe(BASE + 120); // already on the grid
  });
});

describe("arrivalOptions", () => {
  it("runs every 5 minutes from now+5 (rounded up) to the grid's last column (rounded down)", () => {
    const now = BASE + 240; // 14:52
    const options = arrivalOptions(now, grid);
    expect(options[0]).toBe(BASE + 720);            // 14:57 -> 15:00
    expect(options.at(-1)).toBe(floorToStep(BASE + 120 * 60)); // 16:48 -> 16:45
    expect(options.every((t, i) => i === 0 || t - options[i - 1]! === 300)).toBe(true);
  });

  it("shrinks as the reading ages and empties once nothing is left", () => {
    expect(arrivalOptions(BASE + 100 * 60, grid).length).toBeGreaterThan(0);
    expect(arrivalOptions(BASE + 118 * 60, grid)).toEqual([]);
  });
});

describe("defaultArrival and clampArrival", () => {
  it("defaults to now+15 rounded up to the clock grid", () => {
    expect(formatClock(defaultArrival(BASE + 240))).toBe("15:10"); // 14:52 + 15 = 15:07 -> 15:10
  });

  it("keeps a valid selection, snaps a passed one forward and an overrun one back", () => {
    const options = [BASE + 720, BASE + 1020, BASE + 1320];
    expect(clampArrival(BASE + 1020, options)).toBe(BASE + 1020);
    expect(clampArrival(BASE + 600, options)).toBe(BASE + 720);
    expect(clampArrival(BASE + 9999, options)).toBe(BASE + 1320);
    expect(clampArrival(BASE + 9999, [])).toBe(BASE + 9999);
  });
});

describe("horizons and display", () => {
  it("measures the horizon from the reading, which is the whole staleness correction", () => {
    expect(horizonFromReading(BASE + 22 * 60, BASE)).toBe(22);
  });

  it("reports minutes from now, rounded", () => {
    expect(relativeMinutes(BASE + 1320, BASE + 240)).toBe(18);
  });

  it("formats in Taipei time, 24-hour, zero-padded", () => {
    expect(formatClock(BASE)).toBe("14:48");
    expect(formatClock(1788566400)).toBe("08:00"); // 00:00 UTC
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- arrival` → fails to import.

- [ ] **Step 3: Implement** — `web/src/arrival.ts`:

```ts
export const STEP_SEC = 300;
export const MIN_LEAD_SEC = 5 * 60;
export const DEFAULT_LEAD_SEC = 15 * 60;
export const TIME_ZONE = "Asia/Taipei";

export interface GridSpan { baseDataTs: number; stepMin: number; nHorizons: number }

export function ceilToStep(ts: number, stepSec = STEP_SEC): number {
  return Math.ceil(ts / stepSec) * stepSec;
}

export function floorToStep(ts: number, stepSec = STEP_SEC): number {
  return Math.floor(ts / stepSec) * stepSec;
}

/** Every clock time the strip offers: now+5 rounded up, through the grid's last column rounded down. */
export function arrivalOptions(nowSec: number, grid: GridSpan): number[] {
  const first = ceilToStep(nowSec + MIN_LEAD_SEC);
  const last = floorToStep(grid.baseDataTs + grid.stepMin * grid.nHorizons * 60);
  const out: number[] = [];
  for (let t = first; t <= last; t += STEP_SEC) out.push(t);
  return out;
}

export function defaultArrival(nowSec: number): number {
  return ceilToStep(nowSec + DEFAULT_LEAD_SEC);
}

export function clampArrival(arrivalTs: number, options: readonly number[]): number {
  if (options.length === 0) return arrivalTs;
  const first = options[0]!;
  const last = options[options.length - 1]!;
  if (arrivalTs < first) return first;
  if (arrivalTs > last) return last;
  return arrivalTs;
}

/** Minutes between the reading behind the forecast and the arrival: the age is inside this number. */
export function horizonFromReading(arrivalTs: number, baseDataTs: number): number {
  return (arrivalTs - baseDataTs) / 60;
}

export function relativeMinutes(arrivalTs: number, nowSec: number): number {
  return Math.round((arrivalTs - nowSec) / 60);
}

const clockFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE,
});

export function formatClock(ts: number): string {
  return clockFormat.format(new Date(ts * 1000));
}
```

- [ ] **Step 4: Verify** — `npm test --prefix web -- arrival && npm run typecheck --prefix web`.
- [ ] **Step 5: Checkpoint** — `git add web/src/arrival.ts web/tests/arrival.test.ts`. Commit only if authorised: `feat(web): clock-time arrival arithmetic`.

### Task 9: Confidence and the new colour ramp (§4.2, §6)

**Files:**
- Create: `web/src/confidence.ts`; Test: `web/tests/confidence.test.ts`
- Modify: `web/src/map/colour.ts`; Test: `web/tests/colour.test.ts`

**Interfaces (Produces):**
- `type Confidence = "high" | "medium" | "low"`; `HIGH_MAX_MIN = 30`, `MEDIUM_MAX_MIN = 75`; `confidenceFor(horizonFromReadingMin: number, updating: boolean, probability: number | null): Confidence | null`.
- `colour.ts`: `PROBABILITY_RAMP: ReadonlyArray<readonly [number, string]>` = `[[0, "#e5484d"], [0.35, "#f5a524"], [0.7, "#12b5a6"], [1, "#0e9384"]]`; `UNKNOWN_COLOUR = "#9aa3b2"`; `colourFor(p)` interpolates between the stops that bracket `p`.

- [ ] **Step 1: Failing tests** — `web/tests/confidence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HIGH_MAX_MIN, MEDIUM_MAX_MIN, confidenceFor } from "../src/confidence";

describe("confidenceFor", () => {
  it("follows the blend's persistence weight: high to 30 min, medium to 75, low beyond", () => {
    expect(confidenceFor(5, true, 0.8)).toBe("high");
    expect(confidenceFor(HIGH_MAX_MIN, true, 0.8)).toBe("high");
    expect(confidenceFor(HIGH_MAX_MIN + 1, true, 0.8)).toBe("medium");
    expect(confidenceFor(MEDIUM_MAX_MIN, true, 0.8)).toBe("medium");
    expect(confidenceFor(MEDIUM_MAX_MIN + 1, true, 0.8)).toBe("low");
    expect(confidenceFor(500, true, 0.8)).toBe("low");
  });

  it("has nothing to say without a forecast or for a lot that is not updating", () => {
    expect(confidenceFor(5, true, null)).toBeNull();
    expect(confidenceFor(5, false, 0.8)).toBeNull();
  });
});
```

Replace `web/tests/colour.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { PROBABILITY_RAMP, UNKNOWN_COLOUR, colourFor } from "../src/map/colour";

describe("colourFor", () => {
  it("gives unknown its own grey, off the ramp and never the colour of zero", () => {
    expect(colourFor(null)).toBe(UNKNOWN_COLOUR);
    expect(colourFor(Number.NaN)).toBe(UNKNOWN_COLOUR);
    expect(colourFor(0)).not.toBe(UNKNOWN_COLOUR);
    expect(PROBABILITY_RAMP.map(([, c]) => c)).not.toContain(UNKNOWN_COLOUR);
  });

  it("hits every stop exactly and is monotone between them", () => {
    for (const [p, hex] of PROBABILITY_RAMP) expect(colourFor(p)).toBe(hex);
    const steps = [0, 0.2, 0.35, 0.5, 0.7, 0.85, 1].map((p) => colourFor(p));
    expect(new Set(steps).size).toBe(steps.length);
  });

  it("runs red to teal, never green: the red-green colour-blind reading stays intact", () => {
    expect(PROBABILITY_RAMP[0]![1]).toBe("#e5484d");
    expect(PROBABILITY_RAMP.at(-1)![1]).toBe("#0e9384");
  });

  it("returns a valid colour for every probability, clamping outside 0..1", () => {
    for (let p = -0.5; p <= 1.5; p += 0.05) expect(colourFor(p)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(colourFor(2)).toBe(colourFor(1));
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- confidence colour` → confidence fails to import; the colour stop tests fail.

- [ ] **Step 3: Implement** — `web/src/confidence.ts`:

```ts
export type Confidence = "high" | "medium" | "low";

/** The blend halves its weight on the live reading every 30 min of horizon (config.BLEND_HALF_LIFE_MIN). */
export const HIGH_MAX_MIN = 30;   // persistence weight >= 1/2
export const MEDIUM_MAX_MIN = 75; // persistence weight >= ~1/6

export function confidenceFor(horizonFromReadingMin: number, updating: boolean, probability: number | null): Confidence | null {
  if (probability === null || !updating) return null;
  if (horizonFromReadingMin <= HIGH_MAX_MIN) return "high";
  if (horizonFromReadingMin <= MEDIUM_MAX_MIN) return "medium";
  return "low";
}
```

`web/src/map/colour.ts` — replace `PROBABILITY_RAMP`, `UNKNOWN_COLOUR` and `colourFor` (keep the header comment's argument; update it to say red→amber→teal and why not green):

```ts
export const PROBABILITY_RAMP = [
  [0, "#e5484d"],    // almost certainly full
  [0.35, "#f5a524"],
  [0.7, "#12b5a6"],
  [1, "#0e9384"],    // almost certainly a space
] as const;

export const UNKNOWN_COLOUR = "#9aa3b2";

export function colourFor(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return UNKNOWN_COLOUR;
  const clamped = Math.min(1, Math.max(0, p));
  let i = 0;
  while (i < PROBABILITY_RAMP.length - 2 && clamped > PROBABILITY_RAMP[i + 1]![0]) i++;
  const [p0, c0] = PROBABILITY_RAMP[i]!;
  const [p1, c1] = PROBABILITY_RAMP[i + 1]!;
  const frac = p1 === p0 ? 0 : (clamped - p0) / (p1 - p0);
  const lo = channels(c0);
  const hi = channels(c1);
  return `#${lo.map((c, k) => hex2(c + (hi[k]! - c) * frac)).join("")}`;
}
```

(`channels` and `hex2` stay as they are.)

- [ ] **Step 4: Verify** — `npm test --prefix web && npm run typecheck --prefix web` (the lotSource and mapSource tests use `colourFor` and must still pass).
- [ ] **Step 5: Checkpoint** — `git add web/src/confidence.ts web/tests/confidence.test.ts web/src/map/colour.ts web/tests/colour.test.ts`. Commit only if authorised: `feat(web): confidence label and red-amber-teal ramp`.

### Task 10: Place search logic — `places.ts` (§5.2)

**Files:**
- Create: `web/src/places.ts`
- Test: `web/tests/places.test.ts` (absorbs the fold cases from `tests/search.test.ts`, which Task 15 deletes)

**Interfaces (Produces):**
```ts
export type PlaceKind = "carpark" | "station" | "landmark" | "street" | "area";
export interface Place { name: string; en: string; kind: PlaceKind; detail: string; lat: number; lon: number; qualifier: string; lotId?: string }
export interface PlaceIndexDoc { v: number; built: number; source: string; rows: unknown[] }
export const SEARCH_LIMIT = 10;
export const RECENT_LIMIT = 5;
export const RECENT_KEY = "parkcast.recent.v1";
export function foldKey(text: string): string;                         // 臺→台, lowercase, whitespace removed
export function kindOf(detail: string): PlaceKind;                     // raw tile kind -> group ("locality"→area, "major_road"→street, "station"→station, else landmark)
export function prominence(detail: string): number;                    // index in PROMINENCE; unknown → 1000; "carpark" → -1
export function parsePlaceIndex(doc: unknown): Place[];                // validates; throws on a bad document
export function lotsAsPlaces(lots: readonly Lot[]): Place[];           // kind "carpark", detail "carpark", qualifier = district, lotId
export function searchPlaces(places: readonly Place[], query: string, limit?: number): Place[];
export function loadPlaceIndex(url: string, fetchImpl?: typeof fetch): Promise<Place[]>; // memoised per url; a failed load resolves [] and is retried on the next call
export function resetPlaceIndexCache(): void;                          // tests
export function readRecent(storage: Storage | null): Place[];
export function pushRecent(storage: Storage | null, place: Place): Place[];
export function clearRecent(storage: Storage | null): void;
```
Ordering (§5.2): tier by kind (carpark 0, station 1, landmark 2, street 3, area 4), then match position (the smaller of the name and English positions), then `prominence(detail)`, then name (`localeCompare` with `"zh-Hant"`), then lat, then lon.

- [ ] **Step 1: Failing tests** — `web/tests/places.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_LIMIT, SEARCH_LIMIT, clearRecent, foldKey, kindOf, loadPlaceIndex, lotsAsPlaces, parsePlaceIndex, pushRecent,
  readRecent, resetPlaceIndexCache, searchPlaces, type Place,
} from "../src/places";
import type { Lot } from "../src/types";

const lot = (id: string, n: string, a = "信義區"): Lot => ({ i: 0, id, n, a, y: 25.03, x: 121.56, c: 10, t: "民營停車場", p: { k: "unknown" } });
const place = (name: string, detail: string, extra: Partial<Place> = {}): Place => ({
  name, en: "", kind: kindOf(detail), detail, lat: 25.04, lon: 121.55, qualifier: "", ...extra,
});

describe("foldKey", () => {
  it("folds 臺 to 台, lowercases, and ignores spaces", () => {
    expect(foldKey("臺北車站")).toBe("台北車站");
    expect(foldKey("USPACE 信義")).toBe("uspace信義");
  });
});

describe("kindOf", () => {
  it("groups raw tile kinds", () => {
    expect(kindOf("locality")).toBe("area");
    expect(kindOf("minor_road")).toBe("street");
    expect(kindOf("subway_entrance")).toBe("station");
    expect(kindOf("hospital")).toBe("landmark");
    expect(kindOf("carpark")).toBe("carpark");
  });
});

describe("parsePlaceIndex", () => {
  it("reads the row tuples and refuses a document it does not understand", () => {
    const rows = parsePlaceIndex({ v: 1, built: 1, source: "20260914", rows: [["台北101", "Taipei 101", "attraction", 25.0339, 121.5645, "信義"]] });
    expect(rows).toEqual([{ name: "台北101", en: "Taipei 101", kind: "landmark", detail: "attraction", lat: 25.0339, lon: 121.5645, qualifier: "信義" }]);
    expect(() => parsePlaceIndex({ v: 2, rows: [] })).toThrow();
    expect(() => parsePlaceIndex({ v: 1, rows: [["x", "", "park", "no", 1, ""]] })).toThrow();
    expect(() => parsePlaceIndex(null)).toThrow();
  });
});

describe("searchPlaces", () => {
  const roster = lotsAsPlaces([lot("TPE1", "台北101停車場"), lot("TPE2", "臺北車站停車場", "中正區")]);
  const index = [
    place("台北101", "attraction", { en: "Taipei 101" }),
    place("台北101/世貿", "station"),
    place("忠孝東路四段", "major_road", { qualifier: "大安" }),
    place("忠孝東路四段216巷", "minor_road"),
    place("信義區", "locality"),
    place("台北市立圖書館", "library"),
  ];
  const all = [...roster, ...index];

  it("returns nothing for an empty query", () => {
    expect(searchPlaces(all, "  ")).toEqual([]);
  });

  it("ranks car parks, then stations, landmarks, streets and areas", () => {
    const names = searchPlaces(all, "台北").map((p) => p.name);
    expect(names.slice(0, 2)).toEqual(["台北101停車場", "臺北車站停車場"]);
    expect(names.indexOf("台北101/世貿")).toBeLessThan(names.indexOf("台北101"));
    expect(names.indexOf("台北101")).toBeLessThan(names.indexOf("台北市立圖書館"));
  });

  it("folds 臺 and 台 both ways and matches English names", () => {
    expect(searchPlaces(all, "臺北101").map((p) => p.name)).toContain("台北101");
    expect(searchPlaces(all, "taipei").map((p) => p.name)).toContain("台北101");
  });

  it("orders streets by match position, so the section comes before its lanes", () => {
    const names = searchPlaces(all, "忠孝東路四段").map((p) => p.name);
    expect(names).toEqual(["忠孝東路四段", "忠孝東路四段216巷"]);
  });

  it("matches a car park by its district too, after name matches", () => {
    expect(searchPlaces(all, "中正").map((p) => p.name)).toEqual(["臺北車站停車場"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => place(`公園${i}`, "park"));
    expect(searchPlaces(many, "公園").length).toBe(SEARCH_LIMIT);
    expect(searchPlaces(many, "公園", 3).length).toBe(3);
  });
});

describe("loadPlaceIndex", () => {
  beforeEach(resetPlaceIndexCache);

  it("fetches once per url and shares the promise", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ v: 1, built: 1, source: "x", rows: [["西門町", "", "locality", 25.04, 121.5, ""]] })));
    const a = loadPlaceIndex("/places/taipei.json", fetchImpl as unknown as typeof fetch);
    const b = loadPlaceIndex("/places/taipei.json", fetchImpl as unknown as typeof fetch);
    expect(await a).toEqual(await b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await a)[0]!.kind).toBe("area");
  });

  it("resolves empty on failure and tries again next time", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(await loadPlaceIndex("/places/taipei.json", fetchImpl as unknown as typeof fetch)).toEqual([]);
    await loadPlaceIndex("/places/taipei.json", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("recent searches", () => {
  function fakeStorage(): Storage {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;
  }

  it("keeps the last five, newest first, without duplicates", () => {
    const s = fakeStorage();
    for (let i = 0; i < 7; i++) pushRecent(s, place(`p${i}`, "park"));
    pushRecent(s, place("p6", "park"));
    const names = readRecent(s).map((p) => p.name);
    expect(names).toEqual(["p6", "p5", "p4", "p3", "p2"]);
    expect(names.length).toBe(RECENT_LIMIT);
    clearRecent(s);
    expect(readRecent(s)).toEqual([]);
  });

  it("survives a storage that throws or is missing", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} } as unknown as Storage;
    expect(readRecent(broken)).toEqual([]);
    expect(() => pushRecent(broken, place("x", "park"))).not.toThrow();
    expect(readRecent(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- places` → fails to import.

- [ ] **Step 3: Implement** — `web/src/places.ts`:

```ts
import type { Lot } from "./types";

export type PlaceKind = "carpark" | "station" | "landmark" | "street" | "area";

export interface Place {
  name: string;
  en: string;
  kind: PlaceKind;
  /** The raw kind from the tiles ("station", "minor_road", "locality"…) or "carpark". */
  detail: string;
  lat: number;
  lon: number;
  /** District for a car park, nearest locality for anything else, "" when none. */
  qualifier: string;
  lotId?: string;
}

export interface PlaceIndexDoc { v: number; built: number; source: string; rows: unknown[] }

export const SEARCH_LIMIT = 10;
export const RECENT_LIMIT = 5;
export const RECENT_KEY = "parkcast.recent.v1";
const INDEX_VERSION = 1;

/** Mirrors STATION_KINDS + LANDMARK_KINDS + ROAD_KINDS + area kinds in scripts/build-place-index.mjs. */
const PROMINENCE = [
  "station", "subway_entrance",
  "aerodrome", "bus_station", "ferry_terminal", "terminal", "university", "hospital", "mall",
  "department_store", "stadium", "museum", "arts_centre", "theatre", "attraction", "park",
  "townhall", "government", "library", "college", "school", "hotel", "place_of_worship",
  "marketplace", "supermarket", "cinema", "sports_centre", "swimming_pool", "garden", "viewpoint",
  "monument", "memorial", "courthouse", "police", "fire_station", "post_office",
  "community_centre", "clinic", "parking",
  "highway", "major_road", "minor_road",
  "macrohood", "neighbourhood", "locality",
];
const STATION = new Set(["station", "subway_entrance"]);
const STREET = new Set(["highway", "major_road", "minor_road"]);
const AREA = new Set(["macrohood", "neighbourhood", "locality"]);
const TIER: Record<PlaceKind, number> = { carpark: 0, station: 1, landmark: 2, street: 3, area: 4 };

export function foldKey(text: string): string {
  return text.replaceAll("臺", "台").toLowerCase().replace(/\s+/g, "");
}

export function kindOf(detail: string): PlaceKind {
  if (detail === "carpark") return "carpark";
  if (STATION.has(detail)) return "station";
  if (STREET.has(detail)) return "street";
  if (AREA.has(detail)) return "area";
  return "landmark";
}

export function prominence(detail: string): number {
  if (detail === "carpark") return -1;
  const at = PROMINENCE.indexOf(detail);
  return at < 0 ? 1000 : at;
}

function isRow(row: unknown): row is [string, string, string, number, number, string] {
  return Array.isArray(row) && row.length === 6 && typeof row[0] === "string" && typeof row[1] === "string"
    && typeof row[2] === "string" && Number.isFinite(row[3]) && Number.isFinite(row[4]) && typeof row[5] === "string";
}

export function parsePlaceIndex(doc: unknown): Place[] {
  if (typeof doc !== "object" || doc === null) throw new Error("place index is not an object");
  const d = doc as Partial<PlaceIndexDoc>;
  if (d.v !== INDEX_VERSION || !Array.isArray(d.rows)) throw new Error(`place index v${String(d.v)} is not readable`);
  return d.rows.map((row) => {
    if (!isRow(row)) throw new Error("place index row is malformed");
    const [name, en, detail, lat, lon, qualifier] = row;
    return { name, en, kind: kindOf(detail), detail, lat, lon, qualifier };
  });
}

export function lotsAsPlaces(lots: readonly Lot[]): Place[] {
  return lots.map((lot) => ({ name: lot.n, en: "", kind: "carpark", detail: "carpark", lat: lot.y, lon: lot.x, qualifier: lot.a, lotId: lot.id }));
}

interface Hit { place: Place; tier: number; at: number }

export function searchPlaces(places: readonly Place[], query: string, limit: number = SEARCH_LIMIT): Place[] {
  const needle = foldKey(query);
  if (needle === "") return [];
  const hits: Hit[] = [];
  for (const place of places) {
    const inName = foldKey(place.name).indexOf(needle);
    const inEn = place.en === "" ? -1 : foldKey(place.en).indexOf(needle);
    const at = inName >= 0 && inEn >= 0 ? Math.min(inName, inEn) : Math.max(inName, inEn);
    if (at >= 0) {
      hits.push({ place, tier: TIER[place.kind], at });
      continue;
    }
    // A car park also answers to its district, behind every name match.
    if (place.kind === "carpark" && foldKey(place.qualifier).indexOf(needle) >= 0) {
      hits.push({ place, tier: TIER.carpark, at: 1000 });
    }
  }
  hits.sort((a, b) =>
    a.tier - b.tier || a.at - b.at || prominence(a.place.detail) - prominence(b.place.detail)
    || a.place.name.localeCompare(b.place.name, "zh-Hant") || a.place.lat - b.place.lat || a.place.lon - b.place.lon);
  return hits.slice(0, limit).map((h) => h.place);
}

const cache = new Map<string, Promise<Place[]>>();

export function resetPlaceIndexCache(): void {
  cache.clear();
}

/** The index, fetched once per page; a failure yields [] now and a fresh attempt next time. */
export function loadPlaceIndex(url: string, fetchImpl: typeof fetch = fetch): Promise<Place[]> {
  const pending = cache.get(url);
  if (pending) return pending;
  const attempt = (async () => {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parsePlaceIndex(await res.json());
    } catch {
      cache.delete(url);
      return [];
    }
  })();
  cache.set(url, attempt);
  return attempt;
}

export function readRecent(storage: Storage | null): Place[] {
  try {
    const raw = storage?.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is Place => typeof p === "object" && p !== null && typeof (p as Place).name === "string") : [];
  } catch {
    return [];
  }
}

export function pushRecent(storage: Storage | null, place: Place): Place[] {
  const same = (a: Place, b: Place) => a.name === b.name && a.kind === b.kind && a.lat === b.lat && a.lon === b.lon;
  const next = [place, ...readRecent(storage).filter((p) => !same(p, place))].slice(0, RECENT_LIMIT);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full: recents are a convenience, never a requirement.
  }
  return next;
}

export function clearRecent(storage: Storage | null): void {
  try {
    storage?.removeItem(RECENT_KEY);
  } catch {
    // Same as above.
  }
}
```

- [ ] **Step 4: Verify** — `npm test --prefix web -- places && npm run typecheck --prefix web && npm run lint --prefix web`.
- [ ] **Step 5: Checkpoint** — `git add web/src/places.ts web/tests/places.test.ts`. Commit only if authorised: `feat(web): place search over the roster and the offline index`.

### Task 11: Sheet snap logic and the layout media query (§3)

**Files:**
- Create: `web/src/layout/sheet.ts`, `web/src/layout/useMediaQuery.ts`
- Test: `web/tests/sheet.test.ts`, `web/tests/useMediaQuery.test.tsx`

**Interfaces (Produces):**
```ts
export type Snap = "peek" | "half" | "full";
export const SNAPS: readonly Snap[] = ["peek", "half", "full"];
export const FLICK_PX_PER_MS = 0.5;
export const PEEK_MIN_PX = 240;
export interface SnapHeights { peek: number; half: number; full: number }
export function snapHeights(viewportH: number, topBarH: number): SnapHeights;   // peek max(240, .34vh), half .55vh, full vh − topBarH − 12
export function nearestSnap(height: number, heights: SnapHeights): Snap;
export function settleSnap(height: number, velocityPxPerMs: number, heights: SnapHeights, from: Snap): Snap; // velocity > 0 = sheet growing (drag up); a flick moves one step in its direction; otherwise nearest
export function stepSnap(from: Snap, direction: "up" | "down"): Snap;
export const DESKTOP_QUERY = "(min-width: 768px)";
export function useMediaQuery(query: string): boolean;   // false during SSR / when matchMedia is missing; updates on change
```

- [ ] **Step 1: Failing tests** — `web/tests/sheet.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nearestSnap, settleSnap, snapHeights, stepSnap } from "../src/layout/sheet";

describe("snapHeights", () => {
  it("derives the three heights from the viewport with a floor on peek", () => {
    expect(snapHeights(800, 60)).toEqual({ peek: 272, half: 440, full: 728 });
    expect(snapHeights(600, 60).peek).toBe(240);
  });
});

describe("nearestSnap and settleSnap", () => {
  const h = snapHeights(800, 60);
  it("picks the closest snap point", () => {
    expect(nearestSnap(300, h)).toBe("peek");
    expect(nearestSnap(400, h)).toBe("half");
    expect(nearestSnap(700, h)).toBe("full");
  });
  it("lets a flick move one step in its direction, whatever the position", () => {
    expect(settleSnap(300, 0.8, h, "peek")).toBe("half");
    expect(settleSnap(700, -0.8, h, "full")).toBe("half");
    expect(settleSnap(700, 0.8, h, "full")).toBe("full");
    expect(settleSnap(600, 0.1, h, "half")).toBe("half");
  });
  it("steps within the three points", () => {
    expect(stepSnap("peek", "up")).toBe("half");
    expect(stepSnap("full", "up")).toBe("full");
    expect(stepSnap("half", "down")).toBe("peek");
  });
});
```

`web/tests/useMediaQuery.test.tsx`:

```tsx
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_QUERY, useMediaQuery } from "../src/layout/useMediaQuery";

function Probe() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return <p>{desktop ? "desktop" : "phone"}</p>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("useMediaQuery", () => {
  it("follows the query and its changes", () => {
    let listener: ((e: { matches: boolean }) => void) | null = null;
    const mql = { matches: false, addEventListener: (_: string, cb: typeof listener) => { listener = cb; }, removeEventListener: () => {} };
    vi.stubGlobal("matchMedia", vi.fn(() => mql));
    render(<Probe />);
    expect(screen.getByText("phone")).toBeInTheDocument();
    act(() => listener?.({ matches: true }));
    expect(screen.getByText("desktop")).toBeInTheDocument();
  });

  it("is false where matchMedia does not exist", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Probe />);
    expect(screen.getByText("phone")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- sheet useMediaQuery` → fail to import.

- [ ] **Step 3: Implement** — `web/src/layout/sheet.ts`:

```ts
export type Snap = "peek" | "half" | "full";
export const SNAPS: readonly Snap[] = ["peek", "half", "full"];
export const FLICK_PX_PER_MS = 0.5;
export const PEEK_MIN_PX = 240;
export interface SnapHeights { peek: number; half: number; full: number }

export function snapHeights(viewportH: number, topBarH: number): SnapHeights {
  return {
    peek: Math.max(PEEK_MIN_PX, Math.round(viewportH * 0.34)),
    half: Math.round(viewportH * 0.55),
    full: Math.round(viewportH - topBarH - 12),
  };
}

export function nearestSnap(height: number, heights: SnapHeights): Snap {
  let best: Snap = "peek";
  let bestDistance = Infinity;
  for (const snap of SNAPS) {
    const distance = Math.abs(heights[snap] - height);
    if (distance < bestDistance) { best = snap; bestDistance = distance; }
  }
  return best;
}

export function stepSnap(from: Snap, direction: "up" | "down"): Snap {
  const at = SNAPS.indexOf(from);
  const next = direction === "up" ? Math.min(SNAPS.length - 1, at + 1) : Math.max(0, at - 1);
  return SNAPS[next]!;
}

/** Where a release lands: a flick goes one step its way, otherwise the nearest point. */
export function settleSnap(height: number, velocityPxPerMs: number, heights: SnapHeights, from: Snap): Snap {
  if (velocityPxPerMs >= FLICK_PX_PER_MS) return stepSnap(from, "up");
  if (velocityPxPerMs <= -FLICK_PX_PER_MS) return stepSnap(from, "down");
  return nearestSnap(height, heights);
}
```

`web/src/layout/useMediaQuery.ts`:

```ts
import { useEffect, useState } from "react";

export const DESKTOP_QUERY = "(min-width: 768px)";

function matches(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (event: { matches: boolean }) => setValue(event.matches);
    setValue(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return value;
}
```

- [ ] **Step 4: Verify** — `npm test --prefix web -- sheet useMediaQuery && npm run typecheck --prefix web && npm run lint --prefix web`.
- [ ] **Step 5: Checkpoint** — `git add web/src/layout/sheet.ts web/src/layout/useMediaQuery.ts web/tests/sheet.test.ts web/tests/useMediaQuery.test.tsx`. Commit only if authorised: `feat(web): sheet snap arithmetic and layout media query`.

## Phase D — components

### Task 12: Ring, confidence pill, freshness badge, skeleton, notice (§5.4, §5.5)

**Files:**
- Create: `web/src/components/ProbabilityRing.tsx`, `ConfidencePill.tsx`, `FreshnessBadge.tsx`, `Skeleton.tsx`, `Notice.tsx`
- Modify: `web/src/i18n.ts` — add the keys used below to `Strings`, `en` and `zh`
- Test: `web/tests/smallComponents.test.tsx`

**i18n keys added in this task** (add to the interface with a one-line doc each, and to both dictionaries):

| key | en | zh |
|---|---|---|
| `spaceLabel` | `space` | `有車位` |
| `bestPick` | `Best pick` | `最佳選擇` |
| `confidence` | `Confidence` | `信心` |
| `confidenceHigh` | `High` | `高` |
| `confidenceMedium` | `Medium` | `中` |
| `confidenceLow` | `Low` | `低` |
| `confidenceWhyHigh` | `Based mostly on the live reading.` | `主要依據最新讀數。` |
| `confidenceWhyMedium` | `A mix of the live reading and the usual pattern for this time.` | `綜合最新讀數與此時段的平常狀況。` |
| `confidenceWhyLow` | `Mostly the usual pattern for this time of week.` | `主要依據此時段每週的平常狀況。` |
| `expired` | `expired` | `已過期` |
| `freshnessLabel` | `Data age` | `資料時間` |

**Interfaces (Produces):**
```tsx
ProbabilityRing({ probability: number | null; unknownText: string; label: string; best?: boolean; size?: number })
  // <div class="ring [ring--unknown] [ring--glow]" style="--ring-colour"> with an SVG circle; data-testid="lot-probability" on the value element; tweens the arc and counts the number when `probability` changes (motion.tween, DURATION.slow)
ConfidencePill({ level: Confidence; lang: Lang })
  // <button class="pill pill--high|medium|low pill--button" aria-expanded> toggling a <p class="popover" role="note"> with the why-line
FreshnessBadge({ ageMin: number | null; expired: boolean; lang: Lang })
  // <span class="fresh [fresh--warn|fresh--expired] [fresh--flash]" data-testid="staleness">: teal under 10 min, warn from 10, expired grey with the word; flashes for 700 ms when ageMin drops (a new reading landed); text is fillTemplate(stalenessTemplate, {n}) or `${expired}` suffix
Skeleton({ count?: number })          // <div class="skeleton-stack" aria-hidden="true"> of .skeleton-card
Notice({ tone?: "info"|"warn"|"error"; role?: string; testId?: string; children })  // <p class="notice notice--tone anim-slide-down">
```

- [ ] **Step 1: Failing tests** — `web/tests/smallComponents.test.tsx`:

```tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfidencePill } from "../src/components/ConfidencePill";
import { FreshnessBadge } from "../src/components/FreshnessBadge";
import { Notice } from "../src/components/Notice";
import { ProbabilityRing } from "../src/components/ProbabilityRing";
import { Skeleton } from "../src/components/Skeleton";
import { t } from "../src/i18n";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const reduced = () => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));

describe("ProbabilityRing", () => {
  it("shows the percentage and the arc for a known probability", () => {
    reduced();
    render(<ProbabilityRing probability={0.86} unknownText="No data" label="space" />);
    expect(screen.getByTestId("lot-probability")).toHaveTextContent("86%");
    const arc = document.querySelector(".ring__arc") as SVGCircleElement;
    expect(arc).not.toBeNull();
    expect(Number(arc.getAttribute("stroke-dashoffset"))).toBeGreaterThan(0);
  });

  it("says no data with an empty grey ring for null, and never 0%", () => {
    reduced();
    render(<ProbabilityRing probability={null} unknownText="No data" label="space" />);
    expect(screen.getByTestId("lot-probability")).toHaveTextContent("No data");
    expect(screen.getByTestId("lot-probability")).not.toHaveTextContent("0%");
    expect(document.querySelector(".ring")).toHaveClass("ring--unknown");
  });

  it("glows only for the best pick", () => {
    reduced();
    const { rerender } = render(<ProbabilityRing probability={0.5} unknownText="No data" label="space" best />);
    expect(document.querySelector(".ring")).toHaveClass("ring--glow");
    rerender(<ProbabilityRing probability={0.5} unknownText="No data" label="space" />);
    expect(document.querySelector(".ring")).not.toHaveClass("ring--glow");
  });
});

describe("ConfidencePill", () => {
  it("names the level and explains itself on tap", () => {
    render(<ConfidencePill level="medium" lang="en" />);
    const pill = screen.getByRole("button", { name: /confidence.*medium/i });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("note")).toHaveTextContent(t("en").confidenceWhyMedium);
  });
});

describe("FreshnessBadge", () => {
  it("reports the age, turns amber past ten minutes and grey when expired", () => {
    const { rerender } = render(<FreshnessBadge ageMin={4} expired={false} lang="en" />);
    const badge = screen.getByTestId("staleness");
    expect(badge).toHaveTextContent("data from 4 min ago");
    expect(badge).not.toHaveClass("fresh--warn");
    rerender(<FreshnessBadge ageMin={12} expired={false} lang="en" />);
    expect(badge).toHaveClass("fresh--warn");
    rerender(<FreshnessBadge ageMin={130} expired lang="en" />);
    expect(badge).toHaveClass("fresh--expired");
    expect(badge).toHaveTextContent("expired");
  });

  it("flashes once when a fresher reading lands", () => {
    vi.useFakeTimers();
    const { rerender } = render(<FreshnessBadge ageMin={9} expired={false} lang="en" />);
    rerender(<FreshnessBadge ageMin={1} expired={false} lang="en" />);
    expect(screen.getByTestId("staleness")).toHaveClass("fresh--flash");
    act(() => { vi.advanceTimersByTime(800); });
    expect(screen.getByTestId("staleness")).not.toHaveClass("fresh--flash");
    vi.useRealTimers();
  });
});

describe("Skeleton and Notice", () => {
  it("renders hidden placeholders and a toned notice", () => {
    render(<><Skeleton count={3} /><Notice tone="warn" testId="n">hello</Notice></>);
    expect(document.querySelectorAll(".skeleton-card").length).toBe(3);
    expect(document.querySelector(".skeleton-stack")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("n")).toHaveClass("notice--warn");
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- smallComponents` → fail to import.

- [ ] **Step 3: Implement.**

`ProbabilityRing.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { colourFor } from "../map/colour";
import { DURATION, tween } from "../motion";

interface Props { probability: number | null; unknownText: string; label: string; best?: boolean; size?: number }

const STROKE = 6;

export function ProbabilityRing({ probability, unknownText, label, best = false, size = 64 }: Props) {
  const [shown, setShown] = useState(probability ?? 0);
  const previous = useRef(probability ?? 0);

  // Tween from the last value: a change of arrival time animates the arc and counts the number.
  useEffect(() => {
    const target = probability ?? 0;
    const cancel = tween(previous.current, target, DURATION.slow, setShown);
    previous.current = target;
    return cancel;
  }, [probability]);

  const r = (size - STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - Math.min(1, Math.max(0, shown)));
  const unknown = probability === null;
  const className = ["ring", unknown ? "ring--unknown" : "", best ? "ring--glow" : ""].filter(Boolean).join(" ");
  return (
    <div className={className} style={{ width: size, height: size, ["--ring-colour" as string]: colourFor(probability) }}>
      <svg className="ring__svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring__track" cx={size / 2} cy={size / 2} r={r} />
        {!unknown && (
          <circle className="ring__arc" cx={size / 2} cy={size / 2} r={r} strokeDasharray={circumference} strokeDashoffset={dashOffset} />
        )}
      </svg>
      <span className="ring__value" data-testid="lot-probability">{unknown ? unknownText : `${Math.round(shown * 100)}%`}</span>
      {!unknown && <span className="ring__label">{label}</span>}
    </div>
  );
}
```

`ConfidencePill.tsx`:

```tsx
import { useId, useState } from "react";
import type { Confidence } from "../confidence";
import { t, type Lang } from "../i18n";

export function ConfidencePill({ level, lang }: { level: Confidence; lang: Lang }) {
  const s = t(lang);
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const name = { high: s.confidenceHigh, medium: s.confidenceMedium, low: s.confidenceLow }[level];
  const why = { high: s.confidenceWhyHigh, medium: s.confidenceWhyMedium, low: s.confidenceWhyLow }[level];
  return (
    <>
      <button type="button" className={`pill pill--${level} pill--button`} aria-expanded={open} aria-controls={noteId} onClick={() => setOpen((o) => !o)}>
        {s.confidence} · {name}
      </button>
      {open && <p id={noteId} role="note" className="popover anim-pop">{why}</p>}
    </>
  );
}
```

`FreshnessBadge.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { fillTemplate, t, type Lang } from "../i18n";

const WARN_FROM_MIN = 10;
const FLASH_MS = 700;

export function FreshnessBadge({ ageMin, expired, lang }: { ageMin: number | null; expired: boolean; lang: Lang }) {
  const s = t(lang);
  const [flash, setFlash] = useState(false);
  const last = useRef(ageMin);
  useEffect(() => {
    if (ageMin !== null && last.current !== null && ageMin < last.current) {
      setFlash(true);
      const id = setTimeout(() => setFlash(false), FLASH_MS);
      last.current = ageMin;
      return () => clearTimeout(id);
    }
    last.current = ageMin;
    return undefined;
  }, [ageMin]);
  if (ageMin === null) return null;
  const tone = expired ? "fresh--expired" : ageMin >= WARN_FROM_MIN ? "fresh--warn" : "";
  const text = fillTemplate(s.stalenessTemplate, { n: ageMin }) + (expired ? ` · ${s.expired}` : "");
  return (
    <span className={["fresh", tone, flash ? "fresh--flash" : ""].filter(Boolean).join(" ")} data-testid="staleness" aria-label={`${s.freshnessLabel}: ${text}`}>
      <i className="fresh__dot" aria-hidden="true" />
      {text}
    </span>
  );
}
```

`Skeleton.tsx` and `Notice.tsx`:

```tsx
export function Skeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <div key={i} className="skeleton-card" />)}
    </div>
  );
}
```

```tsx
import type { ReactNode } from "react";

interface Props { tone?: "info" | "warn" | "error"; role?: string; testId?: string; children: ReactNode }

export function Notice({ tone = "info", role, testId, children }: Props) {
  return (
    <p className={`notice notice--${tone} anim-slide-down`} role={role} data-testid={testId}>{children}</p>
  );
}
```

- [ ] **Step 4: Verify** — `npm test --prefix web && npm run typecheck --prefix web && npm run lint --prefix web` (adding `Strings` keys breaks nothing else because both dictionaries are updated).
- [ ] **Step 5: Checkpoint** — `git add web/src/components/ProbabilityRing.tsx web/src/components/ConfidencePill.tsx web/src/components/FreshnessBadge.tsx web/src/components/Skeleton.tsx web/src/components/Notice.tsx web/src/i18n.ts web/tests/smallComponents.test.tsx`. Commit only if authorised: `feat(web): ring, confidence pill, freshness badge, skeleton, notice`.

### Task 13: The card and the list (§5.4, §5.5, §9 #2–4)

**Files:**
- Create: `web/src/components/LotCard.tsx`; rewrite `web/src/components/LotList.tsx`
- Delete: `web/src/components/LotRow.tsx`
- Modify: `web/src/i18n.ts` — add `walkTile` ("Walk" / "步行"), `arrivalTile` ("Arrival" / "預計抵達"), `spacesNowTemplate` ("{f} / {c} free · {n} min ago" / "現在 {f} / {c} 位 · {n} 分鐘前"), `spacesNowNoCapacityTemplate` ("{f} free · {n} min ago" / "現在 {f} 位 · {n} 分鐘前"), `spacesNowLabel` ("Observed spaces" / "觀測空位"), `selectCard` ("Show on map" / "在地圖上顯示")
- Test: `web/tests/lotCard.test.tsx`

**Interfaces (Produces):**
```tsx
interface LotCardProps {
  row: Ranked; lang: Lang; baseDataTs: number; ageMin: number;
  arrivalTs: number; horizonFromReadingMin: number;
  best: boolean; selected: boolean; onSelect: (id: string) => void; index: number;
}
LotCard  // <li class="lot-card [lot-card--best] [lot-card--selected] anim-rise" style="--i: index" data-testid="lot-row" data-lot-id>
         //   <button class="lot-card__button" aria-pressed={selected} aria-label={`${row.lot.n} — ${s.selectCard}`}> … </button>
interface LotListProps { rows: readonly Ranked[]; lang: Lang; baseDataTs: number; ageMin: number; arrivalTs: number; horizonFromReadingMin: number; bestId: string | null; selectedId: string | null; onSelect: (id: string) => void }
LotList  // <ol class="lots anim-stagger" data-testid="lot-list">; FLIP on reorder via measureRects/flipMove keyed by row id
```

Card contents, in order: `ProbabilityRing` (unknown text = `notUpdating` + hours when `notUpdatingHours` is non-null, else `noData`), name (`lang="zh-Hant"`, `data-testid="lot-name"`), sub-line `district · type`, tags (`bestPick` pill when `best`, `ConfidencePill` when `confidenceFor(...)` is non-null), then the facts grid: walk (`Walk` icon; value `${walkMin} ${minutesUnit}`; label `formatDistance`), price (`Price` icon; value/label from `formatPrice` split at the first space — value is the amount, label the unit — or the whole `priceUnknown` string as value), observed spaces (`Spaces` icon, only when `row.lot.f !== undefined && row.lot.f !== null`; value from `spacesNowTemplate`/`spacesNowNoCapacityTemplate` depending on `row.lot.c`, label `spacesNowLabel`; `data-testid="lot-spaces"`), arrival (`Clock` icon, value `formatClock(arrivalTs)`, label `arrivalTile`). The whole card is the `<li>`; the `<button>` wraps the content so the card is one tap target.

- [ ] **Step 1: Failing tests** — `web/tests/lotCard.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LotCard } from "../src/components/LotCard";
import { LotList } from "../src/components/LotList";
import { t } from "../src/i18n";
import type { Ranked } from "../src/rank";
import type { Lot } from "../src/types";

const BASE = 1788677280;
const lot = (over: Partial<Lot> = {}): Lot => ({ i: 0, id: "TPE1", n: "台北101停車場", a: "信義區", y: 25.03, x: 121.56, c: 400, t: "民營停車場", p: { k: "exact", lo: 60, hi: 60 }, f: 38, ...over });
const row = (over: Partial<Ranked> = {}, lotOver: Partial<Lot> = {}): Ranked => ({
  lot: lot(lotOver), id: lotOver.id ?? "TPE1", index: 0, probability: 0.86, hourly: 60, perEntry: null, priceKnown: true, meters: 320, walkMin: 4, cost: 100, ...over,
});
const props = { lang: "en" as const, baseDataTs: BASE, ageMin: 4, arrivalTs: BASE + 22 * 60, horizonFromReadingMin: 22, onSelect: vi.fn(), index: 0 };

beforeEach(() => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("LotCard", () => {
  it("shows P, walk, price, the observed count with its age, and the arrival time as separate facts", () => {
    render(<ol><LotCard row={row()} {...props} best selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    expect(within(card).getByTestId("lot-probability")).toHaveTextContent("86%");
    expect(within(card).getByTestId("lot-walk")).toHaveTextContent("4 min");
    expect(within(card).getByTestId("lot-walk")).toHaveTextContent("320 m");
    expect(within(card).getByTestId("lot-price")).toHaveTextContent("NT$60");
    expect(within(card).getByTestId("lot-spaces")).toHaveTextContent("38 / 400 free · 4 min ago");
    expect(within(card).getByTestId("lot-arrival")).toHaveTextContent("15:10");
    expect(within(card).getByText(t("en").bestPick)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /confidence.*high/i })).toBeInTheDocument();
    expect(card).toHaveClass("lot-card--best");
    expect(card.textContent).not.toMatch(/cost|NT\$100/);
  });

  it("omits the count tile without an observation, and shows the count alone without a capacity", () => {
    const { rerender } = render(<ol><LotCard row={row({}, { f: undefined })} {...props} best={false} selected={false} /></ol>);
    expect(screen.queryByTestId("lot-spaces")).toBeNull();
    rerender(<ol><LotCard row={row({}, { f: 7, c: null })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-spaces")).toHaveTextContent("7 free · 4 min ago");
  });

  it("says no data for a missing forecast, with no confidence and never 0%", () => {
    render(<ol><LotCard row={row({ probability: null, cost: null })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-probability")).toHaveTextContent(t("en").noData);
    expect(screen.getByTestId("lot-probability")).not.toHaveTextContent("0%");
    expect(screen.queryByRole("button", { name: /confidence/i })).toBeNull();
  });

  it("says a lot is not updating, and for how long", () => {
    render(<ol><LotCard row={row({ probability: null, cost: null }, { u: BASE - 30 * 3600 })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-probability")).toHaveTextContent(t("en").notUpdating);
    expect(screen.getByTestId("lot-row")).toHaveTextContent("No change in 30 h");
  });

  it("shows an unparsed fare as words, a per-entry fare per entry, and a range as a range", () => {
    const { rerender } = render(<ol><LotCard row={row({ priceKnown: false, hourly: null }, { p: { k: "unknown" } })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-price")).toHaveTextContent(t("en").priceUnknown);
    expect(screen.getByTestId("lot-price").textContent).not.toMatch(/\d/);
    rerender(<ol><LotCard row={row({ hourly: null, perEntry: 50 }, { p: { k: "entry", lo: 50, hi: 50 } })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-price")).toHaveTextContent("NT$50");
    expect(screen.getByTestId("lot-price")).toHaveTextContent(t("en").perEntry);
    rerender(<ol><LotCard row={row({ hourly: 30 }, { p: { k: "range", lo: 20, hi: 40 } })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-price")).toHaveTextContent("NT$20–40");
  });

  it("keeps the name Chinese under English and selects on tap", () => {
    const onSelect = vi.fn();
    render(<ol><LotCard row={row()} {...props} onSelect={onSelect} best={false} selected /></ol>);
    expect(screen.getByTestId("lot-name")).toHaveTextContent("台北101停車場");
    expect(screen.getByTestId("lot-name")).toHaveAttribute("lang", "zh-Hant");
    fireEvent.click(screen.getByRole("button", { name: /台北101停車場/ }));
    expect(onSelect).toHaveBeenCalledWith("TPE1");
    expect(screen.getByTestId("lot-row")).toHaveClass("lot-card--selected");
  });
});

describe("LotList", () => {
  it("is an ordered list keyed by lot, with exactly one best pick", () => {
    const rows = [row(), row({ id: "TPE2", probability: 0.5 }, { id: "TPE2", n: "二號停車場" })];
    render(<LotList rows={rows} {...props} bestId="TPE1" selectedId={null} />);
    const list = screen.getByTestId("lot-list");
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByTestId("lot-row").length).toBe(2);
    expect(within(list).getAllByText(t("en").bestPick).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- lotCard` → fails to import.

- [ ] **Step 3: Implement.** `LotCard.tsx`:

```tsx
import { confidenceFor } from "../confidence";
import { formatClock } from "../arrival";
import { formatDistance, formatPrice, notUpdatingHours } from "../format";
import { Clock, Price, Spaces, Walk } from "../icons";
import { districtName, fillTemplate, lotTypeName, t, type Lang } from "../i18n";
import type { Ranked } from "../rank";
import { ConfidencePill } from "./ConfidencePill";
import { ProbabilityRing } from "./ProbabilityRing";

export interface LotCardProps {
  row: Ranked; lang: Lang; baseDataTs: number; ageMin: number; arrivalTs: number; horizonFromReadingMin: number;
  best: boolean; selected: boolean; onSelect: (id: string) => void; index: number;
}

/** "NT$60 per hour" -> ["NT$60", "per hour"]; a wordy price stays whole. */
function splitPrice(text: string): [string, string] {
  const at = text.indexOf(" ");
  if (at < 0 || !/\d/.test(text)) return [text, ""];
  return [text.slice(0, at), text.slice(at + 1)];
}

export function LotCard({ row, lang, baseDataTs, ageMin, arrivalTs, horizonFromReadingMin, best, selected, onSelect, index }: LotCardProps) {
  const s = t(lang);
  const stalled = notUpdatingHours(row, baseDataTs);
  const unknownText = stalled === null ? s.noData : s.notUpdating;
  const level = confidenceFor(horizonFromReadingMin, row.lot.u === undefined, row.probability);
  const [priceValue, priceLabel] = splitPrice(formatPrice(row, s));
  const f = row.lot.f;
  const spaces = typeof f === "number"
    ? fillTemplate(row.lot.c === null ? s.spacesNowNoCapacityTemplate : s.spacesNowTemplate, { f, c: row.lot.c ?? "", n: ageMin })
    : null;
  const className = ["lot-card", best ? "lot-card--best" : "", selected ? "lot-card--selected" : "", "anim-rise"].filter(Boolean).join(" ");
  return (
    <li className={className} style={{ ["--i" as string]: index }} data-testid="lot-row" data-lot-id={row.id}>
      <button type="button" className="lot-card__button" aria-pressed={selected} aria-label={`${row.lot.n} — ${s.selectCard}`} onClick={() => onSelect(row.id)}>
        <div className="lot-card__head">
          <ProbabilityRing probability={row.probability} unknownText={unknownText} label={s.spaceLabel} best={best} />
          <div className="lot-card__ident">
            <h3 className="lot-card__name" data-testid="lot-name" lang="zh-Hant">{row.lot.n}</h3>
            <p className="lot-card__sub">
              {districtName(row.lot.a, lang)} · {lotTypeName(row.lot.t, lang)}
              {stalled !== null && <> · {fillTemplate(s.unchangedForTemplate, { n: stalled })}</>}
            </p>
            {(best || level !== null) && (
              <div className="lot-card__tags">
                {best && <span className="pill pill--best anim-shine">★ {s.bestPick}</span>}
                {level !== null && <ConfidencePill level={level} lang={lang} />}
              </div>
            )}
          </div>
        </div>
        <div className="facts">
          <div className="fact" data-testid="lot-walk">
            <Walk className="fact__icon" /><span><b className="fact__value">{row.walkMin} {s.minutesUnit}</b><span className="fact__label">{s.walkTile} · {formatDistance(row.meters, s)}</span></span>
          </div>
          <div className="fact" data-testid="lot-price">
            <Price className="fact__icon" /><span><b className="fact__value">{priceValue}</b><span className="fact__label">{priceLabel}</span></span>
          </div>
          {spaces !== null && (
            <div className="fact" data-testid="lot-spaces">
              <Spaces className="fact__icon" /><span><b className="fact__value">{spaces}</b><span className="fact__label">{s.spacesNowLabel}</span></span>
            </div>
          )}
          <div className="fact" data-testid="lot-arrival">
            <Clock className="fact__icon fact__icon--info" /><span><b className="fact__value">{formatClock(arrivalTs)}</b><span className="fact__label">{s.arrivalTile}</span></span>
          </div>
        </div>
      </button>
    </li>
  );
}
```

`LotList.tsx`:

```tsx
import { useLayoutEffect, useRef } from "react";
import type { Lang } from "../i18n";
import { DURATION, flipMove, measureRects } from "../motion";
import type { Ranked } from "../rank";
import { LotCard } from "./LotCard";

export interface LotListProps {
  rows: readonly Ranked[]; lang: Lang; baseDataTs: number; ageMin: number; arrivalTs: number; horizonFromReadingMin: number;
  bestId: string | null; selectedId: string | null; onSelect: (id: string) => void;
}

export function LotList({ rows, lang, baseDataTs, ageMin, arrivalTs, horizonFromReadingMin, bestId, selectedId, onSelect }: LotListProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const previous = useRef<Map<string, DOMRect>>(new Map());

  // FLIP: measure before React commits the new order (the ref holds last commit's rects), play after.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const items = [...list.querySelectorAll<HTMLElement>("[data-lot-id]")].map((el): [string, HTMLElement] => [el.dataset["lotId"] ?? "", el]);
    for (const [id, el] of items) flipMove(el, previous.current.get(id), DURATION.base);
    previous.current = measureRects(items);
  });

  return (
    <ol className="lots anim-stagger" data-testid="lot-list" ref={listRef}>
      {rows.map((row, index) => (
        <LotCard key={row.id} row={row} lang={lang} baseDataTs={baseDataTs} ageMin={ageMin} arrivalTs={arrivalTs}
          horizonFromReadingMin={horizonFromReadingMin} best={row.id === bestId} selected={row.id === selectedId} onSelect={onSelect} index={Math.min(index, 7)} />
      ))}
    </ol>
  );
}
```

Delete `LotRow.tsx`. `App.tsx` still imports `LotList` with the old props at this point and will not typecheck until Task 18 — **that is expected; run only the new test file and `npm run lint` in this task**, and record in the report that typecheck is deferred to Task 18. (Ruling: the app is rewired once, in Task 18, rather than patched three times.)

- [ ] **Step 4: Verify** — `npm test --prefix web -- lotCard smallComponents && npm run lint --prefix web`.
- [ ] **Step 5: Checkpoint** — `git add web/src/components/LotCard.tsx web/src/components/LotList.tsx web/src/i18n.ts web/tests/lotCard.test.tsx && git rm -q web/src/components/LotRow.tsx`. Commit only if authorised: `feat(web): the parking card and FLIP list`.

### Task 14: The arrival strip (§5.3, §9 #10)

**Files:**
- Create: `web/src/components/ArrivalStrip.tsx`
- Delete: `web/src/components/Scrubber.tsx`, `web/tests/scrubber.test.tsx`
- Modify: `web/src/i18n.ts` — add `arrivalLabel` ("Arrive at" / "抵達"), `inMinutesTemplate` ("in {n} min" / "{n} 分鐘後"), `noForecastBeyond` ("no forecast beyond this yet" / "之後尚無預測"), `arrivalGroupLabel` ("Arrival time" / "抵達時間")
- Test: `web/tests/arrivalStrip.test.tsx`

**Interfaces (Produces):**
```tsx
interface ArrivalStripProps { options: readonly number[]; value: number; nowSec: number; onChange: (arrivalTs: number) => void; expired: boolean; lang: Lang }
// <div class="arrival"> readout (<span class="arrival__time" data-testid="arrival-time">18:35</span>, relative text) + <div role="radiogroup" aria-label class="arrival__strip"> of <button role="radio" aria-checked class="chip" data-ts>; arrow keys move the selection; a pointer drag across the strip sweeps it; when `expired` or options is empty the strip renders the tail text only.
```

- [ ] **Step 1: Failing tests** — `web/tests/arrivalStrip.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatClock } from "../src/arrival";
import { ArrivalStrip } from "../src/components/ArrivalStrip";
import { t } from "../src/i18n";

const BASE = 1788677280;               // 14:48 Taipei
const NOW = BASE + 240;                 // 14:52
const options = [BASE + 720, BASE + 1020, BASE + 1320, BASE + 1620]; // 15:00 15:05 15:10 15:15

afterEach(cleanup);

describe("ArrivalStrip", () => {
  it("offers each option as a clock-time radio and shows the selection with its lead time", () => {
    render(<ArrivalStrip options={options} value={BASE + 1320} nowSec={NOW} onChange={() => {}} expired={false} lang="en" />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["15:00", "15:05", "15:10", "15:15"]);
    expect(screen.getByRole("radio", { name: "15:10" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("arrival-time")).toHaveTextContent("15:10");
    expect(screen.getByText("in 18 min")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup")).toHaveAccessibleName(t("en").arrivalGroupLabel);
  });

  it("reports the chosen unix time on click and on arrow keys", () => {
    const onChange = vi.fn();
    render(<ArrivalStrip options={options} value={BASE + 1020} nowSec={NOW} onChange={onChange} expired={false} lang="en" />);
    fireEvent.click(screen.getByRole("radio", { name: "15:15" }));
    expect(onChange).toHaveBeenLastCalledWith(BASE + 1620);
    fireEvent.keyDown(screen.getByRole("radio", { name: "15:05" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(BASE + 1320);
    fireEvent.keyDown(screen.getByRole("radio", { name: "15:05" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(BASE + 720);
  });

  it("ends with the honest tail and renders no chips once the forecast has expired", () => {
    const { rerender } = render(<ArrivalStrip options={options} value={options[0]!} nowSec={NOW} onChange={() => {}} expired={false} lang="zh" />);
    expect(screen.getByText(t("zh").noForecastBeyond)).toBeInTheDocument();
    rerender(<ArrivalStrip options={options} value={options[0]!} nowSec={NOW} onChange={() => {}} expired lang="zh" />);
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.getByText(t("zh").noForecastBeyond)).toBeInTheDocument();
  });

  it("formats the selected time exactly as the card will", () => {
    render(<ArrivalStrip options={options} value={BASE + 1620} nowSec={NOW} onChange={() => {}} expired={false} lang="en" />);
    expect(screen.getByTestId("arrival-time")).toHaveTextContent(formatClock(BASE + 1620));
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- arrivalStrip` → fails to import.

- [ ] **Step 3: Implement** — `ArrivalStrip.tsx`:

```tsx
import { useEffect, useId, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { formatClock, relativeMinutes } from "../arrival";
import { fillTemplate, t, type Lang } from "../i18n";

export interface ArrivalStripProps {
  options: readonly number[]; value: number; nowSec: number; onChange: (arrivalTs: number) => void; expired: boolean; lang: Lang;
}

export function ArrivalStrip({ options, value, nowSec, onChange, expired, lang }: ArrivalStripProps) {
  const s = t(lang);
  const groupId = useId();
  const stripRef = useRef<HTMLDivElement>(null);
  const sweeping = useRef(false);
  const show = !expired && options.length > 0;

  // Keep the selected chip in view when the selection moves (arrow keys, a refresh).
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = options[Math.min(options.length - 1, Math.max(0, index + delta))];
    if (next !== undefined) onChange(next);
  }

  // A sweep: press anywhere on the strip and drag; the chip under the pointer becomes the selection.
  function chipUnder(event: PointerEvent<HTMLDivElement>): number | undefined {
    const el = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-ts]");
    return el ? Number(el.dataset["ts"]) : undefined;
  }
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    sweeping.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!sweeping.current) return;
    const ts = chipUnder(event);
    if (ts !== undefined && ts !== value) onChange(ts);
  }
  function onPointerUp() { sweeping.current = false; }

  return (
    <div className="arrival">
      <div className="arrival__readout">
        <span className="arrival__label">{s.arrivalLabel}</span>
        <span className="arrival__time num" data-testid="arrival-time">{show ? formatClock(value) : "—"}</span>
        {show && <span className="arrival__relative">{fillTemplate(s.inMinutesTemplate, { n: relativeMinutes(value, nowSec) })}</span>}
      </div>
      <div className="arrival__strip" role="radiogroup" aria-label={s.arrivalGroupLabel} id={groupId} ref={stripRef}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {show && options.map((ts, index) => (
          <button key={ts} type="button" role="radio" aria-checked={ts === value} className="chip" data-ts={ts}
            tabIndex={ts === value ? 0 : -1} onClick={() => onChange(ts)} onKeyDown={(e) => onKeyDown(e, index)}>
            {formatClock(ts)}
          </button>
        ))}
        <span className="arrival__tail">{s.noForecastBeyond}</span>
      </div>
    </div>
  );
}
```

(The "digits roll" animation of §9 #10 is the `.chip` highlight transition plus `--dur-base` on the readout; an odometer is optional polish and may be added in Task 19 if time allows — record either way.)

- [ ] **Step 4: Verify** — `npm test --prefix web -- arrivalStrip && npm run lint --prefix web`.
- [ ] **Step 5: Checkpoint** — `git add web/src/components/ArrivalStrip.tsx web/src/i18n.ts web/tests/arrivalStrip.test.tsx && git rm -q web/src/components/Scrubber.tsx web/tests/scrubber.test.tsx`. Commit only if authorised: `feat(web): clock-time arrival strip`.

### Task 15: Place search component (§5.2, §9 #11)

**Files:**
- Create: `web/src/components/PlaceSearch.tsx`
- Delete: `web/src/components/DestinationSearch.tsx`, `web/src/search.ts`, `web/tests/search.test.ts`
- Modify: `web/src/i18n.ts` — replace `searchLabel` ("Where are you going?" / "要去哪裡？"), `searchPlaceholder` ("e.g. 台北101, 忠孝東路四段216巷, 西門町" / "例如：台北101、忠孝東路四段216巷、西門町"), `searchHint` ("Finds car parks, landmarks, MRT stations, streets down to the lane, and neighbourhoods — not house numbers." / "可搜尋停車場、地標、捷運站、路名與巷弄、以及地區，但不含門牌號碼。"), `searchResultsLabel` ("Matching places" / "符合的地點"), `searchResultsTemplate` ("{n} matching places" / "{n} 個符合的地點"), `searchNoMatch` ("Nothing matches that. Try a landmark, a street, or tap the map." / "沒有符合的地點。可改試地標、路名，或直接點選地圖。"); add `loadingPlaces` ("loading places…" / "載入地點中…"), `recentSearches` ("Recent" / "最近搜尋"), `clearRecent` ("Clear" / "清除"), `groupCarParks` ("Car parks" / "停車場"), `groupStations` ("Stations" / "捷運與車站"), `groupLandmarks` ("Landmarks" / "地標"), `groupStreets` ("Streets & lanes" / "路名與巷弄"), `groupAreas` ("Areas" / "地區"), `clearSearch` ("Clear search" / "清除搜尋")
- Test: `web/tests/placeSearch.test.tsx`

**Interfaces (Produces):**
```tsx
interface PlaceSearchProps { lots: readonly Lot[]; indexUrl: string; onSelect: (place: Place) => void; lang: Lang; storage?: Storage | null /* defaults to window.localStorage, guarded */ }
// ARIA combobox as DestinationSearch had it (role="combobox", aria-expanded, aria-controls, aria-activedescendant, listbox/option, Escape, arrows, Enter, blur-outside dismiss, onMouseDown preventDefault on options).
// Results grouped: <li role="presentation" class="search__group"> heading before each kind's first option; option shows the kind icon, name, qualifier.
// Focus with an empty box shows recent searches (heading `recentSearches`, a `clearRecent` button) when any exist.
// On first focus calls loadPlaceIndex(indexUrl); while pending and the query is non-empty, a `loadingPlaces` line is shown under the results. Index rows are merged with lotsAsPlaces(lots).
// Choosing: setQuery(place.name), dismiss, pushRecent, onSelect(place). data-testid="search-results", options data-testid="search-option" with data-kind and, for car parks, data-lot-id.
```

- [ ] **Step 1: Failing tests** — `web/tests/placeSearch.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaceSearch } from "../src/components/PlaceSearch";
import { t } from "../src/i18n";
import { resetPlaceIndexCache } from "../src/places";
import type { Lot } from "../src/types";

const lot = (id: string, n: string, a = "信義區"): Lot => ({ i: 0, id, n, a, y: 25.03, x: 121.56, c: 10, t: "民營停車場", p: { k: "unknown" } });
const LOTS = [lot("TPE1", "台北101停車場"), lot("TPE2", "臺北車站停車場", "中正區")];
const INDEX = { v: 1, built: 1, source: "x", rows: [["台北101", "Taipei 101", "attraction", 25.0339, 121.5645, "信義"], ["忠孝東路四段216巷", "", "minor_road", 25.04, 121.55, "大安"], ["西門町", "", "locality", 25.04, 121.5, ""]] };

function storage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

beforeEach(() => {
  resetPlaceIndexCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(INDEX))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PlaceSearch", () => {
  it("finds car parks at once and landmarks, streets and areas once the index has loaded, grouped", async () => {
    const onSelect = vi.fn();
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={onSelect} lang="en" storage={storage()} />);
    const box = screen.getByRole("combobox", { name: t("en").searchLabel });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "台北" } });
    expect(screen.getByText("台北101停車場")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("台北101")).toBeInTheDocument());
    const list = screen.getByTestId("search-results");
    const headings = within(list).getAllByRole("presentation").map((h) => h.textContent);
    expect(headings).toEqual([t("en").groupCarParks, t("en").groupLandmarks]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("selects a street with the keyboard and remembers it", async () => {
    const onSelect = vi.fn();
    const store = storage();
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={onSelect} lang="en" storage={store} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "忠孝東路" } });
    await screen.findByText("忠孝東路四段216巷");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "忠孝東路四段216巷", kind: "street", qualifier: "大安" }));
    expect((box as HTMLInputElement).value).toBe("忠孝東路四段216巷");
    expect(screen.getByTestId("search-results")).not.toBeVisible();
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.focus(box);
    expect(screen.getByText(t("en").recentSearches)).toBeInTheDocument();
    expect(screen.getByText("忠孝東路四段216巷")).toBeInTheDocument();
  });

  it("still searches the roster when the index cannot be loaded, and says nothing matched otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={() => {}} lang="en" storage={storage()} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "臺北車站" } });
    expect(screen.getByText("臺北車站停車場")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "月球" } });
    await waitFor(() => expect(screen.getByTestId("search-no-match")).toBeInTheDocument());
  });

  it("hands a chosen car park back with its lot id", () => {
    const onSelect = vi.fn();
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={onSelect} lang="zh" storage={storage()} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "101" } });
    fireEvent.click(screen.getByText("台北101停車場"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "carpark", lotId: "TPE1" }));
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- placeSearch` → fails to import.

- [ ] **Step 3: Implement** — `PlaceSearch.tsx`:

```tsx
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Area, CarPark, Cross, Landmark, Search, Station, Street } from "../icons";
import { fillTemplate, t, type Lang } from "../i18n";
import { clearRecent, loadPlaceIndex, lotsAsPlaces, pushRecent, readRecent, searchPlaces, type Place, type PlaceKind } from "../places";
import type { Lot } from "../types";

export interface PlaceSearchProps { lots: readonly Lot[]; indexUrl: string; onSelect: (place: Place) => void; lang: Lang; storage?: Storage | null }

const ICONS: Record<PlaceKind, (p: { className?: string }) => JSX.Element> = { carpark: CarPark, station: Station, landmark: Landmark, street: Street, area: Area };

function defaultStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function PlaceSearch({ lots, indexUrl, onSelect, lang, storage }: PlaceSearchProps) {
  const s = t(lang);
  const id = useId();
  const listId = `${id}-results`;
  const hintId = `${id}-hint`;
  const optionId = (i: number) => `${id}-option-${i}`;
  const store = storage === undefined ? defaultStorage() : storage;

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [index, setIndex] = useState<Place[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<Place[]>(() => readRecent(store));

  const roster = useMemo(() => lotsAsPlaces(lots), [lots]);
  const all = useMemo(() => (index ? [...roster, ...index] : roster), [roster, index]);
  const groupName: Record<PlaceKind, string> = { carpark: s.groupCarParks, station: s.groupStations, landmark: s.groupLandmarks, street: s.groupStreets, area: s.groupAreas };

  // The index is fetched on the first focus, never at page load.
  useEffect(() => {
    if (!focused || index !== null || loading) return;
    setLoading(true);
    let cancelled = false;
    loadPlaceIndex(indexUrl).then((rows) => { if (!cancelled) { setIndex(rows); setLoading(false); } });
    return () => { cancelled = true; };
  }, [focused, index, loading, indexUrl]);

  const hasQuery = query.trim() !== "";
  const results = useMemo(() => searchPlaces(all, query), [all, query]);
  const showRecent = focused && !hasQuery && !dismissed && recent.length > 0;
  const options = showRecent ? recent : results;
  const open = !dismissed && (showRecent || (hasQuery && results.length > 0));
  const noMatch = hasQuery && !dismissed && results.length === 0 && !loading;

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(place: Place) {
    setQuery(place.name);
    setDismissed(true);
    setRecent(pushRecent(store, place));
    onSelect(place);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { event.preventDefault(); setDismissed(true); return; }
    if (!open) {
      if (event.key === "ArrowDown" && options.length > 0) { event.preventDefault(); setDismissed(false); }
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => (i + 1) % options.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => (i + options.length - 1) % options.length); }
    else if (event.key === "Enter") { event.preventDefault(); const chosen = options[active]; if (chosen) choose(chosen); }
  }

  let lastKind: PlaceKind | null = null;
  return (
    <div className="search" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { setDismissed(true); setFocused(false); } }}>
      <label className="visually-hidden" htmlFor={id}>{s.searchLabel}</label>
      <div className="search__field">
        <Search className="search__icon" />
        <input id={id} type="search" role="combobox" className="search__input glass" value={query} placeholder={s.searchPlaceholder} autoComplete="off"
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-describedby={hintId} aria-activedescendant={open ? optionId(active) : undefined}
          onFocus={() => { setFocused(true); setDismissed(false); }}
          onChange={(e) => { setQuery(e.target.value); setActive(0); setDismissed(false); }}
          onKeyDown={onKeyDown} />
        {query !== "" && (
          <button type="button" className="search__clear" aria-label={s.clearSearch} onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(""); setDismissed(false); }}>
            <Cross />
          </button>
        )}
        <ul id={listId} role="listbox" aria-label={showRecent ? s.recentSearches : s.searchResultsLabel} className="search__results glass anim-pop" hidden={!open} data-testid="search-results">
          {open && showRecent && (
            <li role="presentation" className="search__group">
              {s.recentSearches}
              <button type="button" className="search__recent-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => { clearRecent(store); setRecent([]); }}>{s.clearRecent}</button>
            </li>
          )}
          {open && options.map((place, i) => {
            const Icon = ICONS[place.kind];
            const heading = !showRecent && place.kind !== lastKind ? <li key={`g-${place.kind}`} role="presentation" className="search__group">{groupName[place.kind]}</li> : null;
            lastKind = place.kind;
            return (
              <>
                {heading}
                <li key={`${place.kind}-${place.name}-${place.lat}-${place.lon}`} id={optionId(i)} role="option" aria-selected={i === active} className="search__option"
                  data-testid="search-option" data-kind={place.kind} data-lot-id={place.lotId}
                  onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(place)}>
                  <span className="search__option-icon"><Icon /></span>
                  <span>
                    <span className="search__option-name" lang="zh-Hant">{place.name}</span>
                    {(place.qualifier || place.en) && <span className="search__option-where"> · {place.qualifier || place.en}</span>}
                  </span>
                </li>
              </>
            );
          })}
        </ul>
      </div>
      <p className="search__hint" id={hintId}>{s.searchHint}</p>
      {loading && hasQuery && <p className="search__hint" role="status">{s.loadingPlaces}</p>}
      {noMatch && <p className="search__empty" role="status" data-testid="search-no-match">{s.searchNoMatch}</p>}
      {open && !showRecent && <p className="visually-hidden" role="status">{fillTemplate(s.searchResultsTemplate, { n: results.length })}</p>}
    </div>
  );
}
```

(Use `Fragment` with a key instead of the bare `<>` inside the map if the linter objects to keyless fragments: `<Fragment key={…}>`.) The `JSX.Element` type: import `type { JSX } from "react"` if not global under this TS config.

- [ ] **Step 4: Verify** — `npm test --prefix web -- placeSearch places && npm run lint --prefix web`.
- [ ] **Step 5: Checkpoint** — `git add web/src/components/PlaceSearch.tsx web/src/i18n.ts web/tests/placeSearch.test.tsx && git rm -q web/src/components/DestinationSearch.tsx web/src/search.ts web/tests/search.test.ts`. Commit only if authorised: `feat(web): place search with grouped results and recents`.

### Task 16: Shell, bottom sheet, side panel, top bar, locate and language buttons, geolocation hook (§3, §5.1, §9 #1, #9, #15)

**Files:**
- Create: `web/src/layout/BottomSheet.tsx`, `web/src/layout/SidePanel.tsx`, `web/src/layout/Shell.tsx`, `web/src/components/TopBar.tsx`, `web/src/components/LocateButton.tsx`, `web/src/useGeolocation.ts`
- Rewrite: `web/src/components/LangToggle.tsx`
- Modify: `web/src/i18n.ts` — add `expandList` ("Expand the list" / "展開清單"), `collapseList` ("Collapse the list" / "收合清單")
- Test: `web/tests/bottomSheet.test.tsx`, `web/tests/useGeolocation.test.tsx`

**Interfaces (Produces):**
```tsx
// useGeolocation.ts
type GeoState = "idle" | "locating" | "ready" | "unavailable";
export const GEO_TIMEOUT_MS = 10_000; export const GEO_WATCHDOG_MS = 12_000;
export function useGeolocation(onFix: (at: LatLon) => void): { geo: GeoState; request: () => void; abandon: () => void; clearFailure: () => void }
  // the exact state machine App.tsx has today (requestLocation + abandonGeoRef + watchdog), extracted; `abandon` settles a pending request to "idle"; `clearFailure` turns "unavailable" into "idle".

// BottomSheet.tsx
interface BottomSheetProps { snap: Snap; onSnapChange: (snap: Snap) => void; topBarHeight?: number; header: ReactNode; children: ReactNode; lang: Lang }
  // <section class="sheet glass [sheet--full] [sheet--dragging] [sheet--settling]" style={{height}} data-testid="sheet" data-snap={snap}>
  //   <button class="sheet__grip" aria-label={expandList|collapseList} aria-expanded={snap === "full"} onClick → stepSnap peek↔full />
  //   <div class="sheet__header">{header}</div><div class="sheet__body">{children}</div>
  // Pointer drag on grip/header: track dy and velocity (last 80 ms), set height live (class sheet--dragging), on release settleSnap(...). Heights from snapHeights(window.innerHeight, topBarHeight), recomputed on resize. When snap !== "full" the body is not scrollable; a downward drag starting on the body at scrollTop 0 while full collapses (settleSnap from the drag).

// SidePanel.tsx: <aside class="panel glass"><div class="panel__header">{header}</div><div class="panel__body">{children}</div></aside>

// Shell.tsx
interface ShellProps { map: ReactNode; topBar: ReactNode /* phone only */; floatControls: ReactNode /* desktop only */; header: ReactNode; children: ReactNode; snap: Snap; onSnapChange: (s: Snap) => void; lang: Lang; overlay?: ReactNode /* e.g. the map hint */ }
export function Shell(props): JSX.Element   // <div class="app-shell"><div class="map-stage">{map}</div>{overlay}{isDesktop ? <>{floatControls}<SidePanel …/></> : <>{topBar}<BottomSheet …/></>}</div>
export function useIsDesktop(): boolean     // useMediaQuery(DESKTOP_QUERY)

// TopBar.tsx: <div class="topbar"><div class="topbar__search">{search}</div>{locate}{lang}</div>
// LocateButton.tsx: <button class="round-btn glass [round-btn--locating]" aria-busy disabled={locating} aria-label={useMyLocation|locating|locationUnavailable}><Locate/></button>
// LangToggle.tsx: <button class="round-btn glass lang-btn" aria-label …><Globe/><span>{other === "zh" ? "中" : "EN"}</span></button>  (same semantics as today: shows the other language)
```

- [ ] **Step 1: Failing tests** — `web/tests/bottomSheet.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "../src/layout/BottomSheet";
import { t } from "../src/i18n";

afterEach(cleanup);

describe("BottomSheet", () => {
  it("exposes a real button that expands and collapses it", () => {
    const onSnapChange = vi.fn();
    render(<BottomSheet snap="peek" onSnapChange={onSnapChange} header={<b>h</b>} lang="en">body</BottomSheet>);
    const grip = screen.getByRole("button", { name: t("en").expandList });
    expect(grip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(grip);
    expect(onSnapChange).toHaveBeenCalledWith("full");
  });

  it("marks the full state so the body can scroll, and settles a drag to the nearest point", () => {
    const onSnapChange = vi.fn();
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const { rerender } = render(<BottomSheet snap="full" onSnapChange={onSnapChange} header={<b>h</b>} lang="en">body</BottomSheet>);
    expect(screen.getByTestId("sheet")).toHaveClass("sheet--full");
    rerender(<BottomSheet snap="half" onSnapChange={onSnapChange} header={<b>h</b>} lang="en">body</BottomSheet>);
    const grip = screen.getByRole("button", { name: t("en").expandList });
    fireEvent.pointerDown(grip, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientY: 600, pointerId: 1 });   // dragged down 200 px, slowly
    fireEvent.pointerUp(grip, { clientY: 600, pointerId: 1 });
    expect(onSnapChange).toHaveBeenLastCalledWith("peek");
  });
});
```

`web/tests/useGeolocation.test.tsx`:

```tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GEO_WATCHDOG_MS, useGeolocation } from "../src/useGeolocation";

function Probe({ onFix }: { onFix: (at: { lat: number; lon: number }) => void }) {
  const { geo, request, abandon } = useGeolocation(onFix);
  return <><p>{geo}</p><button onClick={request}>go</button><button onClick={abandon}>abandon</button></>;
}

afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(navigator, "geolocation"); });

describe("useGeolocation", () => {
  it("reports a fix and lands on ready", () => {
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 25, longitude: 121.5 } }) }, configurable: true });
    const onFix = vi.fn();
    render(<Probe onFix={onFix} />);
    fireEvent.click(screen.getByText("go"));
    expect(onFix).toHaveBeenCalledWith({ lat: 25, lon: 121.5 });
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("is unavailable on denial, without the API, and on a prompt nobody answers", () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: () => {} }, configurable: true });
    render(<Probe onFix={() => {}} />);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("locating")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(GEO_WATCHDOG_MS + 1); });
    expect(screen.getByText("unavailable")).toBeInTheDocument();
  });

  it("can be abandoned by a better answer, and then ignores the late fix", () => {
    let deliver: ((p: unknown) => void) | null = null;
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: (ok: (p: unknown) => void) => { deliver = ok; } }, configurable: true });
    const onFix = vi.fn();
    render(<Probe onFix={onFix} />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByText("abandon"));
    expect(screen.getByText("idle")).toBeInTheDocument();
    act(() => deliver?.({ coords: { latitude: 1, longitude: 1 } }));
    expect(onFix).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** `npm test --prefix web -- bottomSheet useGeolocation` → fail to import.

- [ ] **Step 3: Implement.**

`useGeolocation.ts` (behaviour lifted verbatim from `App.tsx` lines 473–525; keep its comments):

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { LatLon } from "./geo";

export type GeoState = "idle" | "locating" | "ready" | "unavailable";
export const GEO_TIMEOUT_MS = 10_000;
export const GEO_WATCHDOG_MS = 12_000;

export function useGeolocation(onFix: (at: LatLon) => void) {
  const [geo, setGeo] = useState<GeoState>("idle");
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abandonRef = useRef<(() => void) | null>(null);
  const onFixRef = useRef(onFix);
  useEffect(() => { onFixRef.current = onFix; }, [onFix]);
  useEffect(() => () => { if (watchdog.current !== null) clearTimeout(watchdog.current); }, []);

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) { setGeo("unavailable"); return; }
    setGeo("locating");
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (watchdog.current !== null) clearTimeout(watchdog.current);
      watchdog.current = null;
      abandonRef.current = null;
      finish();
    };
    watchdog.current = setTimeout(() => settle(() => setGeo("unavailable")), GEO_WATCHDOG_MS);
    abandonRef.current = () => settle(() => setGeo("idle"));
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => settle(() => { onFixRef.current({ lat: pos.coords.latitude, lon: pos.coords.longitude }); setGeo("ready"); }),
        () => settle(() => setGeo("unavailable")),
        { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 60_000 },
      );
    } catch {
      settle(() => setGeo("unavailable"));
    }
  }, []);

  const abandon = useCallback(() => { abandonRef.current?.(); }, []);
  const clearFailure = useCallback(() => { setGeo((g) => (g === "unavailable" ? "idle" : g)); }, []);
  return { geo, request, abandon, clearFailure };
}
```

`BottomSheet.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { t, type Lang } from "../i18n";
import { settleSnap, snapHeights, stepSnap, type Snap, type SnapHeights } from "./sheet";

export interface BottomSheetProps { snap: Snap; onSnapChange: (snap: Snap) => void; topBarHeight?: number; header: ReactNode; children: ReactNode; lang: Lang }

const VELOCITY_WINDOW_MS = 80;

export function BottomSheet({ snap, onSnapChange, topBarHeight = 60, header, children, lang }: BottomSheetProps) {
  const s = t(lang);
  const [heights, setHeights] = useState<SnapHeights>(() => snapHeights(typeof window === "undefined" ? 800 : window.innerHeight, topBarHeight));
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ startY: number; startHeight: number; samples: Array<[number, number]> } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => setHeights(snapHeights(window.innerHeight, topBarHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [topBarHeight]);

  const begin = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    drag.current = { startY: event.clientY, startHeight: heights[snap], samples: [[performance.now(), event.clientY]] };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [heights, snap]);

  const move = useCallback((event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null) return;
    const now = performance.now();
    d.samples.push([now, event.clientY]);
    while (d.samples.length > 2 && now - d.samples[0]![0] > VELOCITY_WINDOW_MS) d.samples.shift();
    setDragHeight(Math.min(heights.full, Math.max(heights.peek * 0.6, d.startHeight + (d.startY - event.clientY))));
  }, [heights]);

  const end = useCallback(() => {
    const d = drag.current;
    if (d === null) return;
    drag.current = null;
    const [t0, y0] = d.samples[0]!;
    const [t1, y1] = d.samples[d.samples.length - 1]!;
    const velocity = t1 > t0 ? (y0 - y1) / (t1 - t0) : 0; // up = sheet growing = positive
    const height = dragHeight ?? heights[snap];
    setDragHeight(null);
    onSnapChange(settleSnap(height, velocity, heights, snap));
  }, [dragHeight, heights, snap, onSnapChange]);

  // A downward drag at the top of a full, scrolled-to-top list collapses the sheet.
  const bodyDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (snap !== "full" || (bodyRef.current?.scrollTop ?? 0) > 0) return;
    begin(event);
  }, [snap, begin]);

  const height = dragHeight ?? heights[snap];
  const className = ["sheet", "glass", snap === "full" && dragHeight === null ? "sheet--full" : "", dragHeight !== null ? "sheet--dragging" : "sheet--settling"].filter(Boolean).join(" ");
  const toggle = () => onSnapChange(snap === "full" ? "peek" : stepSnap("half", "up"));
  return (
    <section className={className} style={{ height }} data-testid="sheet" data-snap={snap}>
      <button type="button" className="sheet__grip" aria-expanded={snap === "full"} aria-label={snap === "full" ? s.collapseList : s.expandList}
        onClick={toggle} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
      <div className="sheet__header" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>{header}</div>
      <div className="sheet__body" ref={bodyRef} onPointerDown={bodyDown} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>{children}</div>
    </section>
  );
}
```

Note for the drag test above: the click handler must not fire after a drag; guard `toggle` with a `moved` flag set in `move` when |dy| > 6 px and cleared in `begin`.

`SidePanel.tsx`, `Shell.tsx`, `TopBar.tsx`, `LocateButton.tsx`, `LangToggle.tsx`:

```tsx
// SidePanel.tsx
import type { ReactNode } from "react";
export function SidePanel({ header, children }: { header: ReactNode; children: ReactNode }) {
  return <aside className="panel glass" data-testid="panel"><div className="panel__header">{header}</div><div className="panel__body">{children}</div></aside>;
}
```

```tsx
// Shell.tsx
import type { ReactNode } from "react";
import type { Lang } from "../i18n";
import { BottomSheet } from "./BottomSheet";
import { SidePanel } from "./SidePanel";
import type { Snap } from "./sheet";
import { DESKTOP_QUERY, useMediaQuery } from "./useMediaQuery";

export const useIsDesktop = () => useMediaQuery(DESKTOP_QUERY);

export interface ShellProps { map: ReactNode; topBar: ReactNode; floatControls: ReactNode; header: ReactNode; children: ReactNode; snap: Snap; onSnapChange: (s: Snap) => void; lang: Lang; overlay?: ReactNode }

export function Shell({ map, topBar, floatControls, header, children, snap, onSnapChange, lang, overlay }: ShellProps) {
  const desktop = useIsDesktop();
  return (
    <div className="app-shell" data-layout={desktop ? "desktop" : "phone"}>
      <div className="map-stage">{map}</div>
      {overlay}
      {desktop ? (
        <><div className="float-controls">{floatControls}</div><SidePanel header={header}>{children}</SidePanel></>
      ) : (
        <>{topBar}<BottomSheet snap={snap} onSnapChange={onSnapChange} header={header} lang={lang}>{children}</BottomSheet></>
      )}
    </div>
  );
}
```

```tsx
// TopBar.tsx
import type { ReactNode } from "react";
export function TopBar({ search, locate, lang }: { search: ReactNode; locate: ReactNode; lang: ReactNode }) {
  return <div className="topbar"><div className="topbar__search">{search}</div>{locate}{lang}</div>;
}
```

```tsx
// LocateButton.tsx
import { Locate } from "../icons";
import { t, type Lang } from "../i18n";
import type { GeoState } from "../useGeolocation";
export function LocateButton({ geo, onClick, lang }: { geo: GeoState; onClick: () => void; lang: Lang }) {
  const s = t(lang);
  const label = geo === "locating" ? s.locating : geo === "unavailable" ? s.locationUnavailable : s.useMyLocation;
  return (
    <button type="button" className={`round-btn glass${geo === "locating" ? " round-btn--locating" : ""}`} onClick={onClick} disabled={geo === "locating"} aria-busy={geo === "locating"} aria-label={label} title={label}>
      <Locate />
    </button>
  );
}
```

```tsx
// LangToggle.tsx
import { Globe } from "../icons";
import type { Lang } from "../i18n";
export function LangToggle({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  const other: Lang = lang === "en" ? "zh" : "en";
  return (
    <button type="button" className="round-btn glass lang-btn" onClick={() => onChange(other)} aria-label={lang === "en" ? "切換為中文" : "Switch to English"}>
      <Globe size={16} /><span key={other}>{other === "zh" ? "中" : "EN"}</span>
    </button>
  );
}
```

- [ ] **Step 4: Verify** — `npm test --prefix web -- bottomSheet useGeolocation && npm run lint --prefix web`.
- [ ] **Step 5: Checkpoint** — `git add web/src/layout web/src/components/TopBar.tsx web/src/components/LocateButton.tsx web/src/components/LangToggle.tsx web/src/useGeolocation.ts web/src/i18n.ts web/tests/bottomSheet.test.tsx web/tests/useGeolocation.test.tsx`. Commit only if authorised: `feat(web): shell with bottom sheet and side panel`.

### Task 17: The map: selection, popup, transitions, padding (§5.6, §9 #5–8)

**Files:**
- Modify: `web/src/map/MapView.tsx`, `web/src/map/lotSource.ts`
- Test: `web/tests/mapSource.test.tsx` (extend), `web/tests/lotSource.test.ts`

**Interfaces (Produces):**
```tsx
export interface MapViewProps {
  lots: readonly MapLot[]; destination: LatLon | null; onPick?: (at: LatLon) => void; lang: Lang;
  selectedId: string | null; bestId: string | null; onSelectLot?: (id: string) => void;
  centerRequest: { lat: number; lon: number; nonce: number } | null;   // easeTo when nonce changes
  padding: { top: number; right: number; bottom: number; left: number };  // map.setPadding on change
}
// lotSource: LotProperties gains `selected: boolean` and `best: boolean`; toFeatureCollection(rows, { selectedId, bestId }) sets them.
// Layers: LOTS_LAYER (circles, colour-transition 300ms) + LOTS_HALO_LAYER ("lots-halo", a circle layer filtered to selected||best, stroke accent, radius +6, opacity .35) + DESTINATION_LAYER.
// Clicking a lot feature: onSelectLot(id) and a Popup (`<b>name</b>`, `${Math.round(p*100)}%` or noData) at the dot; clicking empty map: onPick. Clicking a card (centerRequest) eases the map there; the best dot's halo pulses via `circle-radius-transition` toggled on an interval only when !prefersReducedMotion().
```

- [ ] **Step 1: Failing tests.** In `web/tests/lotSource.test.ts` add:

```ts
it("marks the selected and best lots on their features", () => {
  const rows = [toMapLot(LOTS[0]!, 0.5), toMapLot(LOTS[1]!, 0.9)];
  const fc = toFeatureCollection(rows, { selectedId: LOTS[0]!.id, bestId: LOTS[1]!.id });
  expect(fc.features[0]!.properties.selected).toBe(true);
  expect(fc.features[0]!.properties.best).toBe(false);
  expect(fc.features[1]!.properties.best).toBe(true);
});
```

(Use that file's own `LOTS`/`toMapLot` fixtures.) In `web/tests/mapSource.test.tsx`, extend `FakeMap` with `setPadding: vi.fn()`, `addLayer` recording specs in a `layerSpecs` map, `getCanvas: () => ({ style: {} })`, `queryRenderedFeatures: () => []`, and add:

```tsx
it("adds a halo layer for the selected and best lots and applies the padding it is given", async () => {
  // render <MapView … selectedId="TPE_A" bestId="TPE_C" centerRequest={null} padding={{top:0,right:0,bottom:300,left:0}} />
  // expect(shared.map.layerSpecs.has("lots-halo")).toBe(true);
  // expect(shared.map.setPadding).toHaveBeenCalledWith({ top: 0, right: 0, bottom: 300, left: 0 });
  // const data = shared.map.getSource("lots").data; expect(data.features.find(f => f.id === "TPE_A").properties.selected).toBe(true);
});

it("eases to a centre request and selects the tapped lot", async () => {
  // rerender with centerRequest={{lat: 25.03, lon: 121.56, nonce: 1}} → expect(easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [121.56, 25.03] }))
  // simulate the registered "click" handler on LOTS_LAYER with { features: [{ properties: { id: "TPE_C" } }], lngLat: {...} } → onSelectLot called with "TPE_C"
});
```

Write those two with the file's fixture conventions (the `on` fake must record handlers by event name and layer so the test can invoke them).

- [ ] **Step 2: Run** `npm test --prefix web -- lotSource mapSource` → fails.

- [ ] **Step 3: Implement.** `lotSource.ts`: add `selected`/`best` to `LotProperties`; `toFeatureCollection(rows, marks: { selectedId?: string | null; bestId?: string | null } = {})` sets `selected: row.id === marks.selectedId`, `best: row.id === marks.bestId`.

`MapView.tsx` changes (keep the module's current comments and structure):
- Import `Popup` from `maplibre-gl` (type-only import stays for `GeoJSONSource`, `MapMouseEvent`); import `prefersReducedMotion` from `../motion`; import `colourFor`.
- Props as above. `features = useMemo(() => toFeatureCollection(lots, { selectedId, bestId }), [lots, selectedId, bestId])`.
- In the layer effect, after `LOTS_LAYER` add:
  ```ts
  map.addLayer({ id: LOTS_HALO_LAYER, type: "circle", source: LOTS_SOURCE, filter: ["any", ["get", "selected"], ["get", "best"]],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 13, 12, 16, 18], "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 3, "circle-stroke-color": "#0fb5a5", "circle-stroke-opacity": 0.55 } }, LOTS_LAYER);
  map.setPaintProperty(LOTS_LAYER, "circle-color-transition", { duration: 300 });
  ```
  and remove it in the cleanup with the others.
- Pulse (best pick): an interval every 1000 ms while `bestId !== null && !prefersReducedMotion()` toggling `circle-stroke-opacity` between 0.55 and 0.2 with `circle-stroke-opacity-transition` 900 ms — set on the halo layer; cleared on unmount.
- `useEffect(() => { map?.setPadding(padding); }, [map, padding.top, padding.right, padding.bottom, padding.left])`.
- `useEffect(() => { if (map && centerRequest) map.easeTo({ center: [centerRequest.lon, centerRequest.lat], duration: prefersReducedMotion() ? 0 : 600 }); }, [map, centerRequest?.nonce])`.
- Click handling: register `map.on("click", LOTS_LAYER, handler)` for dots — `handler` reads `event.features?.[0]?.properties` (`id`, `name`, `probability`), calls `onSelectLot?.(id)`, opens one shared `Popup({ closeButton: false, offset: 12 })` at the feature's coordinates with `<b>${name}</b><span>${probability === null ? s.noData : Math.round(probability * 100) + "%"}</span>` (escape the name with a text node, not innerHTML: build the DOM with `document.createElement`), and calls `event.originalEvent.stopPropagation()`; and `map.on("click", mapHandler)` for empty map which, unless `event.defaultPrevented`, calls `onPickRef.current?.(...)` as today. Use `map.queryRenderedFeatures(event.point, { layers: [LOTS_LAYER] }).length === 0` inside `mapHandler` to decide it was empty map (this is what makes the two handlers not both fire).
- Destination pin ripple (§9 #8): on a destination change, when not reduced motion, add a `Marker`-free ripple by appending two `<div class="pin-ripple">`/`pin-ripple--late` elements positioned with `map.project([lon, lat])` inside the map container for 1.2 s, removed after; skip in jsdom (`typeof map.project !== "function"` in the fake → guard).
- Hover (desktop): `map.on("mouseenter", LOTS_LAYER, () => map.getCanvas().style.cursor = "pointer")` and `mouseleave` resets.

- [ ] **Step 4: Verify** — `npm test --prefix web -- lotSource mapSource mapChunk && npm run lint --prefix web`. (`mapLazy`/`app` tests are updated in Task 18.)
- [ ] **Step 5: Checkpoint** — `git add web/src/map/MapView.tsx web/src/map/lotSource.ts web/tests/mapSource.test.tsx web/tests/lotSource.test.ts`. Commit only if authorised: `feat(map): selection halo, popup, smooth recolour, padding`.

## Phase E — the app

### Task 18: Rewire `App.tsx`, update the app tests, bump the service worker (§3, §5, §8)

**Files:**
- Rewrite: `web/src/App.tsx`
- Modify: `web/src/i18n.ts` — replace `startPrompt` with `startPromptMap` ("Search a place, or tap the map where you're going" / "搜尋地點，或點選地圖上的目的地"); keep `startPrompt` removed; add `listLabel` ("Ranked car parks" / "排序後的停車場")
- Modify: `web/public/sw.js:44` (`VERSION = "v2"`)
- Modify: `web/tests/app.test.tsx`, `web/tests/mapLazy.test.tsx`, `web/tests/mapChunk.test.tsx` (only where they reference removed props/strings)

**What `App.tsx` keeps unchanged:** the artifact loading, refresh scheduling (`REFRESH_MS`, `MIN_REFETCH_MS`, visibility handling), `FUTURE_TOLERANCE_SEC`, `LIST_LIMIT`, `COVERAGE_RADIUS_M`, `ageMin`, `forecastExpired` (same rule), `mapLots`, `ranked`, `listed`, `outsideCoverage`, the single `pickDestination` path, the lazy `MapView`, the module comment's arguments (update the wording where the scrubber became the strip and the search became places). Export `GEO_WATCHDOG_MS` re-exported from `useGeolocation` so the tests' import keeps working.

**What changes:**
- `arrivalTs` state, `options = arrivalOptions(nowSec, grid)`, `clampArrival` applied in an effect whenever `options` change; `horizonFromReadingMin = horizonFromReading(arrivalTs, grid.baseDataTs)`; `nowSec = Math.floor(nowMs / 1000)`.
- `selectedLotId`, `centerRequest`, `snap` (initial `"peek"`) state. `selectLot(id)`: set selected, set `centerRequest` from the lot's coordinates with `nonce + 1`, and on the phone snap to `"half"` if at `"peek"`.
- Geolocation through `useGeolocation(pickDestination)`; `pickDestination` calls `abandon()` and `clearFailure()` then sets the destination and clears the selection.
- Place search: `onSelect(place)` → `pickDestination({ lat: place.lat, lon: place.lon })`; for a car park additionally `selectLot(place.lotId)`.
- `bestId = listed.find(r => r.probability !== null)?.id ?? null` when `!forecastExpired`, else `null`.
- Map padding: phone `{ bottom: sheetHeight, top: 60, left: 0, right: 0 }` where `sheetHeight = snapHeights(window.innerHeight, 60)[snap]` (recomputed with `useMediaQuery`/resize via the `Shell`'s `useIsDesktop`); desktop `{ left: 420, top: 0, right: 0, bottom: 0 }`.
- Layout: `Shell` with `map` = the Suspense'd `MapView` (placeholder `MapPlaceholder` now positioned absolutely by CSS), `overlay` = `<p class="map-hint glass anim-slide-down">{startPromptMap}</p>` when `artifacts && destination === null`, `topBar` = `TopBar` with `PlaceSearch`, `LocateButton`, `LangToggle`; `floatControls` = `LocateButton` + `LangToggle` (desktop); `header` = head row (`<h1 class="app-name">` + `FreshnessBadge`) + on desktop the `PlaceSearch` + the `ArrivalStrip` + geo status; `children` = notices, skeleton (loading), `<h2 class="list-head">` + `LotList`.
- `indexUrl = \`${import.meta.env.BASE_URL.replace(/\/+$/, "")}/places/taipei.json\``.

- [ ] **Step 1: Write the new `App.tsx`.** Skeleton with the essential wiring (fill in from today's file for the parts marked "as today"):

```tsx
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { arrivalOptions, clampArrival, defaultArrival, horizonFromReading } from "./arrival";
import { artifactsBase, horizonColumn, loadArtifacts, probabilityAt } from "./artifacts";
import { ArrivalStrip } from "./components/ArrivalStrip";
import { FreshnessBadge } from "./components/FreshnessBadge";
import { LangToggle } from "./components/LangToggle";
import { LocateButton } from "./components/LocateButton";
import { LotList } from "./components/LotList";
import { Notice } from "./components/Notice";
import { PlaceSearch } from "./components/PlaceSearch";
import { Skeleton } from "./components/Skeleton";
import { TopBar } from "./components/TopBar";
import type { LatLon } from "./geo";
import { detectLang, fillTemplate, t, type Lang } from "./i18n";
import { Shell, useIsDesktop } from "./layout/Shell";
import { snapHeights, type Snap } from "./layout/sheet";
import { toMapLot } from "./map/lotSource";
import type { Place } from "./places";
import { listRows, rankLots } from "./rank";
import type { Grid, Lot, LotsDoc } from "./types";
import { useGeolocation } from "./useGeolocation";

export { GEO_WATCHDOG_MS } from "./useGeolocation";
const MapView = lazy(() => import("./map/MapView"));
const ARTIFACTS_BASE = artifactsBase(import.meta.env.BASE_URL);
const PLACES_URL = `${import.meta.env.BASE_URL.replace(/\/+$/, "")}/places/taipei.json`;
export const LIST_LIMIT = 20;
export const COVERAGE_RADIUS_M = 10_000;
const CLOCK_TICK_MS = 30_000;
export const REFRESH_MS = 120_000;
export const MIN_REFETCH_MS = 30_000;
export const FUTURE_TOLERANCE_SEC = 600;
const TOP_BAR_PX = 60;
const PANEL_PX = 420;

interface Artifacts { grid: Grid; lots: LotsDoc }

function probabilityForLot(grid: Grid, lot: Lot | undefined, horizonMin: number): number | null { /* as today */ }
function MapPlaceholder({ lang }: { lang: Lang }) { return <p className="map-placeholder" role="status" data-testid="map-loading">{t(lang).mapLoading}</p>; }

export default function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [artifacts, setArtifacts] = useState<Artifacts | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [destination, setDestination] = useState<LatLon | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [arrivalTs, setArrivalTs] = useState(() => defaultArrival(Math.floor(Date.now() / 1000)));
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [centerRequest, setCenterRequest] = useState<{ lat: number; lon: number; nonce: number } | null>(null);
  const [snap, setSnap] = useState<Snap>("peek");
  const desktop = useIsDesktop();
  const s = t(lang);
  const loadedRef = useRef(false);
  const lastFetchRef = useRef(0);

  /* artifact load effect, clock effect, refresh effect, document.lang effect: as today */

  const grid = artifacts?.grid ?? null;
  const nowSec = Math.floor(nowMs / 1000);
  const ageMin = grid === null ? null : Math.max(0, Math.round((nowSec - grid.baseDataTs) / 60));
  const options = useMemo(() => (grid === null ? [] : arrivalOptions(nowSec, grid)), [grid, nowSec]);
  useEffect(() => { setArrivalTs((ts) => clampArrival(ts, options)); }, [options]);
  const horizonFromReadingMin = grid === null ? 0 : horizonFromReading(arrivalTs, grid.baseDataTs);
  const forecastExpired = grid !== null && ageMin !== null && horizonColumn(grid, grid.stepMin + ageMin) === grid.nHorizons - 1;

  const pickDestination = useCallback((at: LatLon) => {
    abandonRef.current?.();
    clearFailureRef.current?.();
    setSelectedLotId(null);
    setDestination(at);
  }, []);
  const { geo, request, abandon, clearFailure } = useGeolocation(pickDestination);
  const abandonRef = useRef(abandon); const clearFailureRef = useRef(clearFailure);
  useEffect(() => { abandonRef.current = abandon; clearFailureRef.current = clearFailure; }, [abandon, clearFailure]);

  const mapLots = useMemo(/* as today, with horizonFromReadingMin in place of gridHorizonMin */);
  const ranked = useMemo(/* as today, horizonMin: horizonFromReadingMin */);
  const listed = useMemo(() => listRows(ranked, LIST_LIMIT), [ranked]);
  const outsideCoverage = useMemo(/* as today */);
  const bestId = !forecastExpired ? (listed.find((r) => r.probability !== null)?.id ?? null) : null;

  function selectLot(id: string) {
    const lot = artifacts?.lots.lots.find((l) => l.id === id);
    setSelectedLotId(id);
    if (lot) setCenterRequest((c) => ({ lat: lot.y, lon: lot.x, nonce: (c?.nonce ?? 0) + 1 }));
    if (!desktop && snap === "peek") setSnap("half");
  }
  function onPlace(place: Place) {
    pickDestination({ lat: place.lat, lon: place.lon });
    if (place.kind === "carpark" && place.lotId) selectLot(place.lotId);
  }

  const sheetHeight = typeof window === "undefined" ? 300 : snapHeights(window.innerHeight, TOP_BAR_PX)[snap];
  const padding = desktop ? { left: PANEL_PX, top: 0, right: 0, bottom: 0 } : { left: 0, top: TOP_BAR_PX, right: 0, bottom: sheetHeight };

  const search = artifacts !== null ? <PlaceSearch lots={artifacts.lots.lots} indexUrl={PLACES_URL} onSelect={onPlace} lang={lang} /> : null;
  const locate = <LocateButton geo={geo} onClick={request} lang={lang} />;
  const langToggle = <LangToggle lang={lang} onChange={setLang} />;
  const header = (
    <>
      <div className="head-row"><h1 className="app-name">{s.appName}</h1><FreshnessBadge ageMin={ageMin} expired={forecastExpired} lang={lang} /></div>
      {desktop && search}
      {grid !== null && <ArrivalStrip options={options} value={arrivalTs} nowSec={nowSec} onChange={setArrivalTs} expired={forecastExpired} lang={lang} />}
      <p className="status visually-hidden" role="status">{geo === "unavailable" ? s.locationUnavailable : ""}</p>
    </>
  );
  const map = loadFailed ? null : (
    <Suspense fallback={<MapPlaceholder lang={lang} />}>
      <MapView lots={mapLots} destination={destination} onPick={pickDestination} lang={lang} selectedId={selectedLotId} bestId={bestId} onSelectLot={selectLot} centerRequest={centerRequest} padding={padding} />
    </Suspense>
  );
  return (
    <Shell map={map} topBar={<TopBar search={search} locate={locate} lang={langToggle} />} floatControls={<>{locate}{langToggle}</>}
      header={header} snap={snap} onSnapChange={setSnap} lang={lang}
      overlay={artifacts !== null && destination === null ? <p className="map-hint glass anim-slide-down">{s.startPromptMap}</p> : null}>
      {loadFailed && <Notice tone="error" role="alert">{s.loadFailed} <button type="button" onClick={() => { setLoadFailed(false); setAttempt((n) => n + 1); }}>{s.retry}</button></Notice>}
      {!loadFailed && artifacts === null && <Skeleton />}
      {geo === "unavailable" && <Notice tone="warn" testId="geo-unavailable">{s.locationUnavailable}</Notice>}
      {forecastExpired && <Notice tone="warn" testId="forecast-expired" role="status">{s.forecastTooOld}</Notice>}
      {outsideCoverage && <Notice tone="warn" testId="outside-coverage" role="status">{fillTemplate(s.outsideCoverage, { km: COVERAGE_RADIUS_M / 1000 })}</Notice>}
      {artifacts !== null && destination !== null && !outsideCoverage && (
        <>
          <h2 className="list-head">{forecastExpired ? s.nearbyCarParks : s.rankedForArrival}</h2>
          <LotList rows={listed} lang={lang} baseDataTs={artifacts.grid.baseDataTs} ageMin={ageMin ?? 0} arrivalTs={arrivalTs}
            horizonFromReadingMin={horizonFromReadingMin} bestId={bestId} selectedId={selectedLotId} onSelect={selectLot} />
        </>
      )}
    </Shell>
  );
}
```

(`useGeolocation` is called after `pickDestination` is defined, and `pickDestination` reaches `abandon` through refs so the two can reference each other without a stale closure. Keep every "as today" block's comments.)

- [ ] **Step 2: Update `web/tests/app.test.tsx`.** Keep every describe; change only what the structure changed. The exact edits:
  1. `stubFetch`: also answer `places/taipei.json` with `{ ok: true, status: 200, json: () => Promise.resolve({ v: 1, built: 1, source: "t", rows: [] }) }` and keep rejecting anything else.
  2. `renderLocated`: the locate button is now found by `screen.findByRole("button", { name: t("en").useMyLocation })` — unchanged; it still works.
  3. `describe("staleness")`: `expect(line.textContent).toContain("data from 4 min ago")` (the badge may add nothing else at 4 min).
  4. `describe("arrival time")` → replace the body with: renders the strip; `screen.findByRole("radiogroup", { name: t("en").arrivalGroupLabel })`; the radios' text equals `arrivalOptions(NOW_SEC, grid).map(formatClock)` where `NOW_SEC = NOW_MS / 1000` and `grid = { baseDataTs: BASE_DATA_TS, stepMin: STEP_MIN, nHorizons: N_HORIZONS }` (import `arrivalOptions`, `defaultArrival`, `formatClock`, `horizonFromReading` from `../src/arrival`); the checked radio's text is `formatClock(defaultArrival(NOW_SEC))`.
  5. `describe("staleness correction")`:
     - first test: `const column = horizonColumn(grid, horizonFromReading(defaultArrival(NOW_SEC + AGE_MIN*60), BASE_DATA_TS))` where the fixture ages via `ageArtifact(AGE_MIN)` (so NOW is `BASE + AGE_MIN` minutes; compute `NOW_SEC` from `Date.now()` after `ageArtifact`); expect `columnMark(column)` in the probability and not `columnMark(column - AGE_MIN / STEP_MIN)`.
     - second test: same idea at ages 0 and 20; the column read must move by 4 (20 min / 5) — assert the two marks differ by `columnMark(c + 4) − columnMark(c)`.
     - third test ("leaves the control offering the arrival times the user picks") → the checked radio shows `formatClock(defaultArrival(NOW_SEC))` regardless of age (the age is inside the horizon, not the label).
     - fourth test: click the last radio; the probability shows `columnMark(N_HORIZONS − 1)` and not `noData`.
  6. `describe("an artifact older than the grid")`: "disables the scrubber…" → "renders no arrival chips" (`expect(screen.queryAllByRole("radio")).toEqual([])`); the rest unchanged except `data-testid="staleness"` now also contains `t("en").expired`.
  7. `describe("searching for a destination")`: the combobox is found by `t("en").searchLabel`; results by `screen.findAllByTestId("search-option")`; the "makes no network request at all while searching" test becomes "makes no request beyond the one place-index fetch": after typing, `fetchMock` calls whose URL ends with `places/taipei.json` ≤ 1 and no other new URLs. Keep the 臺/台, keyboard, escape, no-match and language assertions; the district text is inside `.search__option-where`.
  8. `describe("geolocation")`: the unavailable string is now in `getByTestId("geo-unavailable")`.
  9. Everything else (price, probability, not-updating, language, refresh, document language, artifacts, list cap, coverage, separate chunk) is unchanged in intent; fix selectors only where a testid moved: the row is still `[data-testid="lot-row"]`, the probability `lot-probability`, walk `lot-walk`, price `lot-price`.
  10. `mapLazy.test.tsx` / `mapChunk.test.tsx`: update `MapView` props to the new interface where they render it directly (`selectedId={null} bestId={null} centerRequest={null} padding={{top:0,right:0,bottom:0,left:0}}`).

- [ ] **Step 3: `web/public/sw.js`** — `const VERSION = "v2";` with a one-line comment: the redesign changed every hashed asset and added `places/`; v2 drops the v1 cache on activate.

- [ ] **Step 4: Verify everything** — `npm test --prefix web && npm run typecheck --prefix web && npm run lint --prefix web && npm run build --prefix web`. Expected: green. Count the tests and record the number in the report.

- [ ] **Step 5: Checkpoint** — `git add web/src/App.tsx web/src/i18n.ts web/public/sw.js web/tests/app.test.tsx web/tests/mapLazy.test.tsx web/tests/mapChunk.test.tsx`. Commit only if authorised: `feat(web): map-first shell, place search, clock-time arrival`.

### Task 19: Browser verification and polish (§2 "both layouts", §11 browser check)

**Files:** whatever the checks require (CSS tweaks in `web/src/styles/*`, small component fixes). No new behaviour.

Run `npm run dev --prefix web` from PowerShell (the dev server serves `web/.dev-artifacts/`; refresh it first with `node scripts/sync-artifacts.mjs` if the collector is running, else `python scripts/refresh-demo-artifacts.py`), open `http://127.0.0.1:5173/` in the Browser pane and check each item; fix and re-check until all pass. Record a screenshot description per item in the report.

- [ ] **Phone, 390 × 844, light:** map fills the screen; top bar pill, locate and language buttons; sheet at `peek` shows the header row, the strip and the first card; drag to `half` and `full`; the list scrolls only at `full`; a downward drag at the top collapses it; the grip button toggles by keyboard (Tab to it, Enter).
- [ ] **Search:** type `台北101` → car parks first, then the landmark and the station, each with an icon; `忠孝東路四段216巷` → a street result with its locality; `西門町` → an area; choosing one sets the pin, the ranking appears, the sheet is at least `half`; recents appear on an empty focused box.
- [ ] **Arrival strip:** chips from now+5 to the grid's end; dragging across the strip sweeps the selection and the map dots recolour smoothly; the big time and "in N min" update; the card's arrival tile matches.
- [ ] **Cards:** best pick has the rail, ribbon and glowing ring; rings animate on first appearance and on a time change; the observed count reads "N / C free · n min ago" (only once the live `lots.json` has `f`; with demo artifacts the tile is absent — say so); confidence pill opens its note; tapping a card eases the map to it and highlights the dot; tapping a dot highlights the card and shows the popup; tapping empty map moves the pin with a ripple.
- [ ] **States:** no destination → the map hint; expired forecast (age the demo artifact by editing its header, or wait) → grey badge with "expired", no chips, "car parks nearby" heading, rings say "no data"; a not-updating lot shows "No change in n h"; unpriced shows words only.
- [ ] **Desktop, 1280 × 800:** side panel 420 px with search inside; float controls top-right; hover lifts a card and halos its dot; the map's padding keeps the pin centred in the visible map.
- [ ] **Dark mode** (Browser pane `colorScheme: dark`): tokens flip, glass is navy, text legible, ramp colours still distinct.
- [ ] **Reduced motion** (emulate via DevTools or `matchMedia` override in the console): no rise/stagger/pulse/ripple; rings and counts jump; the sheet snaps instantly.
- [ ] **Console clean** on every screen above (no errors, no MapLibre warnings about images).
- [ ] Checkpoint whatever changed; commit only if authorised: `style(web): polish from browser verification`.

### Task 20: Docs

**Files:** `README.md` (Status table: tests; the "Deployment"/"Basemap" sections mention the place index and the redesign), `docs/pwa.md` (the layout, the sheet, `places/` cache-first, `VERSION` v2), `docs/basemap.md` (already has the place index from Task 5; cross-link), `docs/state-of-play.md` (a "UI redesign — 2026-09-15" section: what shipped, the two open polish items if any, the deferred later-than-2h forecast and per-lot confidence), `CLAUDE.md` (the web file map under a "Web app structure (2026-09-15)" heading: shell/sheet/panel, pure modules, components; the three honesty rules restated for the card).

- [ ] Write them; keep every number real (test counts from Task 18's report, index size from Task 4).
- [ ] Checkpoint; commit only if authorised: `docs: describe the map-first redesign`.

### Task 21: Release — USER-GATED

- [ ] `npm run deploy:check --prefix worker` (no key in the shell) → green.
- [ ] The user runs `npm run deploy:release` from `worker/` with a fresh token (docs/deploy.md §5); expected: ~700 new assets, smoke test passed (including `/places/taipei.json`), preview URLs off.
- [ ] Verify live in the browser: the map draws, search finds `台北101`, cards show the observed count.
- [ ] Ledger: `Task 21: complete — version <id>`.

---

## Review

(Filled in by the controller at the end: what shipped, measured numbers, open items.)

