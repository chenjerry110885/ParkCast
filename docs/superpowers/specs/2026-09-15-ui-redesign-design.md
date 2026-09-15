# ParkCast UI/UX redesign — design spec

**Date:** 2026-09-15 · **Status:** approved in conversation, awaiting written review
**Supersedes:** the layout and visual sections implied by `docs/pwa.md` and `web/src/index.css`; nothing in
`2026-09-04-parkcast-design.md` (the product) or `2026-09-14-deployment-design.md` (the deploy) changes.

## 1. Goal

Turn the working but plain ParkCast page into a map-first, polished "urban mobility" app — a full-screen
map with a frosted sheet of compact parking cards — without weakening anything the product is built on:
the staleness line, "no data" never shown as 0%, the three ranking inputs visible and never folded into
a score, no third-party origin, and the driver's destination never leaving the phone.

Three product changes ride along, each approved on 2026-09-15:

1. **Place search** — the search box finds landmarks, MRT stations, streets and lanes, and
   neighbourhoods as well as car parks, from an index built out of the basemap tiles. No geocoder.
2. **Arrival as a clock time** — "18:35", not "in 15 min", within the forecast's existing window.
3. **Two new card facts** — the observed free count at the reading (a new `lots.json` field) and a
   three-level confidence label derived from the model's own structure.

## 2. Constraints (binding on every task)

- **No new runtime dependency.** Animations are CSS transitions, the Web Animations API and pointer
  events. No motion library, no icon pack, no gesture library. Build-time scripts use Node built-ins and
  the web app's existing `node_modules` only.
- **No new origin, no key.** `connect-src 'self'` and the rest of `web/public/_headers` are unchanged.
  The place index is a static file on the app's own origin.
- **The honesty rules stand.** A missing probability renders as "no data" (grey, empty ring), never 0%;
  a not-updating lot says so; the observed count is labelled with its age and never presented as a
  forecast; P, walk and price stay three separate visible facts; the expected-cost score is never shown.
- **Accessibility floor:** every tap target ≥ 44 px; the search keeps the ARIA 1.2 combobox pattern;
  the list stays an ordered list; the sheet is reachable by keyboard (a button expands/collapses it);
  colour is never the only carrier of meaning (percentages and labels are always written).
- **Reduced motion:** every animation in §9 is disabled or reduced to an opacity fade under
  `prefers-reduced-motion: reduce`. One helper (`motion.ts`) answers the question; components never
  read the media query themselves.
- **Bundle discipline:** the map chunk stays lazy (`React.lazy`, the only path to `map/`); the place
  index is fetched only after the user focuses the search box; the entry chunk grows by no more than
  the new components and styles require.
- **Free tier:** nothing here adds a Worker request per interaction. Tiles, glyphs and the place index
  are static assets.
- **Both layouts are first-class:** a 390 px phone and a 1280 px desktop are both checked in the
  browser before the branch is finished.

## 3. Layout

### 3.1 Phone (viewport width < 768 px)

- The map fills the viewport (`100dvh`, safe-area aware).
- **Top bar**, floating over the map: the search pill (full width minus the buttons), a round locate
  button, a round language button. Frosted white, soft shadow.
- **Bottom sheet**, frosted, with a drag handle. Contents, top to bottom: freshness badge and app name
  on one row, the arrival-time strip, then the card list (an `<ol>`).
- **Snap points**, as fractions of the viewport height with pixel floors:
  - `peek`: the header row, the arrival strip and the first card visible — `max(240px, 34vh)`.
  - `half`: `55vh`.
  - `full`: viewport minus the top bar and safe areas.
- **Gestures:** dragging the handle or the sheet header moves the sheet; release snaps to the nearest
  point, biased by release velocity (a flick down of more than 0.5 px/ms goes one point down, up goes
  one up). The list scrolls only at `full`; a downward drag at the top of a `full` list collapses the
  sheet. A button in the handle (visually the handle, with an accessible name) toggles `peek` ↔ `full`
  for keyboard and screen-reader users. Snap arithmetic is a pure function (`layout/sheet.ts`).
- **Map taps:** a tap on a car-park dot selects it — its card scrolls into view and highlights, a small
  popup on the map shows the name and percentage. A tap on empty map sets the destination, as today.
  Tapping a card flies the map to that lot (`easeTo`, 600 ms) and selects it.
- The map keeps `padding` set so the destination pin is centred in the part of the map the sheet does
  not cover at the current snap point.

### 3.2 Desktop (viewport width ≥ 768 px)

- The map fills the window. A **side panel** 420 px wide sits on the left, frosted, full height, with
  the same contents as the sheet (header row, search inside the panel rather than floating, arrival
  strip, list). The list scrolls inside the panel.
- Locate and language buttons float top-right over the map. The map's `padding-left` is 420 px so
  centring and fitting account for the panel.
- Hovering a card highlights its dot on the map (halo); the hover state is a lift and shadow.

### 3.3 One shell, two arrangements

`layout/Shell.tsx` decides which arrangement to render from one media query hook
(`layout/useMediaQuery.ts`); the panel and sheet share the same child content component, so nothing is
implemented twice. Resizing across 768 px re-arranges without losing state.

## 4. Visual system

### 4.1 Tokens (`web/src/styles/tokens.css`)

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#F4F6F8` with a faint dot grid (`radial-gradient` 1 px dots, 18 px pitch, 6% navy) | `#0B1630` |
| `--surface` | `#FFFFFF` | `#13264A` |
| `--glass` | `rgba(255,255,255,.82)` + `backdrop-filter: blur(14px)`; fallback `rgba(255,255,255,.96)` where unsupported | `rgba(19,38,74,.80)` |
| `--text` | `#0F1F3D` | `#EEF2F8` |
| `--muted` | `#5B6B85` | `#A9B8D1` |
| `--border` | `#E3E8F0` | `#244579` |
| `--accent` | `#0FB5A5` (teal) | `#2EE6CF` |
| `--accent-2` | `#22C55E` (green; the best-pick gradient's far end only) | `#4ADE80` |
| `--gradient-best` | `linear-gradient(135deg, var(--accent), var(--accent-2))` | same |
| `--warn` | `#F59E0B` | `#FBBF24` |
| `--danger` | `#EF4444` | `#F87171` |
| `--unknown` | `#9AA3B2` | `#7C8AA5` |
| `--shadow-1` | `0 2px 8px rgba(15,31,61,.06)` | `0 2px 8px rgba(0,0,0,.35)` |
| `--shadow-2` | `0 8px 24px rgba(15,31,61,.12)` | `0 8px 24px rgba(0,0,0,.45)` |
| `--radius-card` / `--radius-sheet` / `--radius-pill` | 16 px / 22 px / 999 px | same |

Dark mode follows `prefers-color-scheme`, as today. `color-scheme: light dark` stays on `:root`.

### 4.2 Probability ramp

Map dots and card rings use one ramp, defined once in `map/colour.ts` and mirrored as CSS custom
properties for the ring:

| P | Colour |
|---|---|
| 0.00 | `#E5484D` coral red |
| 0.35 | `#F5A524` amber |
| 0.70 | `#12B5A6` teal |
| 1.00 | `#0E9384` deep teal |

Red → amber → teal, never green: the teal end carries blue, so the ramp stays readable under
red-green colour blindness, which the current RdYlBu ramp was chosen for. Green appears only in the
best-pick gradient, where the ribbon's text says "best pick" anyway. `UNKNOWN_COLOUR` becomes
`--unknown` (`#9AA3B2`) and remains off-ramp.

### 4.3 Type and icons

- Font stack: `system-ui, -apple-system, "Segoe UI", "Noto Sans TC", sans-serif`; `font-variant-numeric:
  tabular-nums` on every number.
- Scale: app name 15/700, card name 16/800, ring number 20/800, facts 13/600 with 11/500 captions,
  captions 12, pills 11/700.
- Icons: one file, `web/src/icons.tsx`, exporting inline SVG components (24 px viewBox, 2 px stroke,
  `currentColor`, `aria-hidden` unless given a label): `Search`, `Locate`, `Walk`, `Price`, `Spaces`,
  `Clock`, `Pin`, `Station`, `Landmark`, `Street`, `Area`, `CarPark`, `Info`, `Chevron`, `Globe`,
  `Cross`. No emoji anywhere in the UI.

## 5. Components

### 5.1 Top bar and buttons

- `TopBar.tsx` (phone only): search pill, locate button, language button. The pill is a button that
  opens the search; on desktop the search lives in the panel.
- `LocateButton`: idle / locating (radar sweep) / unavailable (crossed icon, with the existing status
  text in the sheet). Same state machine as today (`useGeolocation.ts`, extracted from `App.tsx`).
- `LangToggle`: round button with the `Globe` icon and "EN" / "中" text; crossfades on change.

### 5.2 Place search (`PlaceSearch.tsx`, `places.ts`)

Replaces `DestinationSearch.tsx` and `search.ts`.

- **Index file** `web/public/places/taipei.json`, generated by `scripts/build-place-index.mjs` from the
  basemap archive (§7.2), git-ignored like the tiles, required by the deploy gate. Loaded on the first
  focus of the search box (`fetch`, cached by the service worker cache-first), parsed once, kept in
  memory. Until it arrives the box searches the roster alone and shows a one-line "loading places…"
  under the results.
- **Result groups and tiers**, in order: car parks (the roster in memory, tier 0) · stations (tier 1) ·
  landmarks (tier 2) · streets and lanes (tier 3) · neighbourhoods (tier 4). Each result shows its
  kind icon, the name, and a grey qualifier: the district for a car park, the locality for a street or
  landmark, "捷運" for a station.
- **Matching:** substring on the folded name (`臺`→`台`, `toLowerCase`, spaces removed) and on the
  English name. Ordering is total: tier, then match position, then prominence rank, then name, then
  coordinates. Prominence, high to low: `station`; landmark kinds in this order — `aerodrome`,
  `bus_station`, `ferry_terminal`, `university`, `hospital`, `mall`, `department_store`, `stadium`,
  `museum`, `arts_centre`, `theatre`, `attraction`, `park`, `townhall`, `government`, `library`,
  `college`, `school`, `hotel`, `place_of_worship`, `marketplace`, `supermarket`, `cinema`,
  `sports_centre`, `swimming_pool`, `garden`, `viewpoint`, `monument`, `memorial`, `courthouse`,
  `police`, `fire_station`, `post_office`, `community_centre`, `clinic`, `parking`; then `highway`,
  `major_road`, `minor_road`; then `area`. Cap 10 results.
- **Recent searches:** the last 5 chosen places, in `localStorage`, shown when the box is focused and
  empty, with a clear button. On-device only; wrapped in try/catch.
- **Hint copy** (visible under the box, as today): what it finds — car parks, landmarks, MRT stations,
  streets down to the lane, neighbourhoods — and what it cannot: house numbers.
- Choosing a result sets the destination through `pickDestination`, the single existing path, and puts
  the chosen name in the box.

### 5.3 Arrival strip (`ArrivalStrip.tsx`, `arrival.ts`)

- **State:** `arrivalTs`, unix seconds, aligned to a 5-minute wall-clock boundary.
- **Options** (`arrival.ts`, pure): every 5 minutes from `ceilTo5min(now + 5 min)` through
  `baseDataTs + stepMin × nHorizons` (the grid's last column, 120 min after the reading as built).
  `forecastExpired` keeps today's rule unchanged; while it is true the strip renders no chips and the
  expired notice shows.
- **Default:** `ceilTo5min(now + 15 min)`. When the clock passes the selected time, the selection moves
  to the first option. The selected time is kept across artifact refreshes.
- **Horizon read from the grid:** `horizonMin = (arrivalTs − baseDataTs) / 60`, then the existing
  `horizonColumn` snap. This replaces `activeHorizon + ageMin`; it is the same correction expressed as
  a subtraction, and remains the only place the reading's age enters a horizon.
- **Rendering:** a horizontal scroller of chips (`18:25 18:30 18:35 …`), the selected one navy-gradient
  with the highlight sliding between chips; above it the selected time large ("18:35") with the relative
  time beside it ("15 分鐘後" / "in 15 min"); dragging along the strip sweeps the selection so the map
  recolours live, as the old slider did. Keyboard: the strip is a `role="radiogroup"` of chips;
  arrow keys move the selection. The final chip is followed by a muted "之後尚無預測 / no forecast
  beyond this yet" tail.

### 5.4 The card (`LotCard.tsx`, replaces `LotRow.tsx`)

Layout, phone width:

```
┌─────────────────────────────────────────────────┐
│ (ring 86%)  台北101停車場                          │
│  有車位     信義區 · 民營停車場                     │
│             [★ 最佳選擇] [信心 高]                  │
│ ┌────────────┐ ┌────────────┐                     │
│ │ 走 4 分鐘   │ │ $ NT$60    │                     │
│ │ 320 m      │ │ 每小時      │                     │
│ ├────────────┤ ├────────────┤                     │
│ │ ▦ 38 / 400 │ │ ◷ 18:35    │                     │
│ │ 現在空位·4分鐘前│ │ 預計抵達  │                     │
│ └────────────┘ └────────────┘                     │
└─────────────────────────────────────────────────┘
```

- **Ring** (`ProbabilityRing.tsx`): an SVG circle whose stroke-dashoffset is the probability; colour
  from the ramp; the number inside; caption "有車位" / "space". `null` probability: grey track, no arc,
  "無資料" / "no data" in small grey text — never a number. A not-updating lot: "未更新" with "n 小時無變化"
  beneath, as today's copy.
- **Best pick:** the first card of a ranking with at least one forecast gets the teal→green left rail,
  a faint teal tint, a glowing ring and the ribbon. Only one card, and none when the forecast has
  expired (the list is then ordered by walk and price, and the heading says so, as today).
- **Confidence pill** (`ConfidencePill.tsx`): High / Medium / Low, teal / amber / grey; tapping it
  opens a one-line popover: "based mostly on the live reading" / "a mix of the live reading and the
  usual pattern for this time" / "mostly the usual pattern for this time". Hidden when P is null.
- **Facts:** four tiles with icons. Walk uses today's `formatDistance`; price uses `formatPrice`
  (unknown → the words, no number; per-entry → per entry); the observed count reads `f / c` with the
  reading's age, `f` alone when capacity is null, and the tile is omitted when `f` is null; the arrival
  tile shows the selected clock time.
- **States:** default · best · selected (teal outline, from a map tap or card tap) · unknown · not
  updating · pressed (scale .98). Card tap selects and flies the map; the whole card is a button-like
  `<li>` with a real `<button>` inside for accessibility.

### 5.5 List, header, notices

- `LotList.tsx`: the `<ol>`; reorders with a FLIP transition when the ranking changes (§9).
- Header row in the sheet/panel: app name left, `FreshnessBadge` right — a breathing dot and "4 分鐘前的
  資料": teal under 10 min, amber from 10 min, grey with "已過期" once `forecastExpired`. The staleness
  line therefore stays on screen at every snap point.
- Notices (`Notice.tsx`): load failed + retry, forecast expired, outside coverage, "start" prompt
  (now a short instruction over the map when no destination is set: "搜尋地點，或點地圖"). Same copy as
  today where it exists; slide-in animation.
- Loading: three skeleton cards with shimmer while artifacts load; the map placeholder keeps its
  height, as today.

### 5.6 Map (`map/MapView.tsx`)

- Dots: radius by zoom as today; `circle-color-transition` 300 ms so a time change recolours smoothly.
- Selected lot: a second circle layer drawing a halo (`circle-stroke` in accent, animated radius via a
  short WAAPI-driven paint update). Best pick: a slow pulse (2 s) on its halo.
- Destination pin: a drop (translate + scale) and two expanding ripple rings on set.
- Popup: MapLibre's `Popup` with the name and percentage, styled to the tokens, closed on outside tap.
- Hover (desktop): halo on the hovered card's dot.
- `easeTo` on card tap; `padding` follows the sheet snap point and the desktop panel.

## 6. Confidence (`confidence.ts`)

```
confidence(horizonFromReadingMin, updating, probability):
  probability === null → null
  !updating           → null   (the ring already says "not updating")
  h ≤ 30              → "high"
  h ≤ 75              → "medium"
  else                → "low"
```

`h` is the horizon actually read from the grid (arrival minus the reading), so data age counts. The
thresholds follow the blend's persistence weight `0.5^(h/30)`: above one half, between a half and a
sixth, below. This is a statement about the model's structure, not a per-lot statistic; the pill's
popover says so in one line, and the function is the single seam to replace when the trained model
publishes per-lot uncertainty.

## 7. Data and build changes

### 7.1 `lots.json`: observed free count `f`

- `src/parkcast/artifacts.py` `build_lots_json` gains `free: Mapping[str, int | None]`; each row gets
  `"f": free.get(lot.id)` — the lot's `free_car` at exactly `base_data_ts`, `null` when that reading was
  absent or NULL. `scheduler.publish_artifacts` reads it from the hot store at `history.latest_ts`
  (one query, by `data_ts`). Schema stays `v: 1`: additive, and a client that ignores `f` shows no
  count, which is still true.
- `worker/src/validate.ts`: `f`, when present, must be `null` or an integer ≥ 0; otherwise the row is
  invalid. Tests for both.
- `web/src/types.ts`: `f?: number | null`. `artifacts.ts` passes it through untouched.
- Rollout: Python tests, image rebuild, recreate just after a tick (the `docker/README.md` procedure),
  confirm the next `uploaded: status=204`. Until the collector is rebuilt the live `lots.json` has no
  `f` and the card simply omits the tile.

### 7.2 Place index: `scripts/build-place-index.mjs`

- Input: the local archive (`web/basemap-src/taipei.pmtiles`, via `basemap-archive.mjs`); output
  `web/public/places/taipei.json`, git-ignored; `build-basemap.mjs` runs it after unpacking tiles.
- Rows from zoom 15 tiles: `places` (all named, kind → `area`); `roads` with kind `major_road`,
  `minor_road` or `highway` (→ `street`); `pois` whose `kind` is in a fixed landmark list (stations and
  entrances → `station`; the rest → `landmark`), excluding restaurants, shops, bus stops, bicycle
  rental and the like. Named `buildings` whose name matches a landmark kind are not included in v1.
- Same-name features are clustered: segments/points of one name within 1 km of each other become one
  entry at their centroid; separate clusters become separate entries. Every entry carries the nearest
  `places` locality as its qualifier, so "中正路 · 士林" and "中正路 · 板橋" are distinct.
- File format: `{ "v": 1, "built": <unix s>, "source": "<planet build date>", "rows": [[name, en, kind,
  lat, lon, qualifier], …] }` with `en` and `qualifier` as `""` when absent, coordinates to 5 decimals.
  Target ≤ 500 KB gzipped; the script prints the count per kind and the gzipped size, and fails if
  the file exceeds 600 KB gzipped or holds fewer than 15,000 rows.
- `check-deploy-bundle.mjs`: allow and require `places/taipei.json`; `smoke-live.mjs` HEADs it.
- `web/public/sw.js`: no rule change (`places/` is cache-first under rule 6); `VERSION` → `v2` in the
  release that ships this, so every visitor's shell and cache refresh.
- `docs/basemap.md` gains a "Place index" section; `docs/pwa.md` and `README.md` are updated.

## 8. State and files

`App.tsx` keeps: artifacts loading and refresh, `nowMs`, destination (`pickDestination`, the single
path), `arrivalTs`, `selectedLotId`, `lang`, the derived `forecastExpired`, `mapLots`, `ranked`,
`listed`, `outsideCoverage`. Geolocation moves to `useGeolocation.ts` unchanged in behaviour.

| Path | Role |
|---|---|
| `web/src/styles/{tokens,base,components,motion}.css` | replace `index.css` (imported from `main.tsx` in that order) |
| `web/src/icons.tsx` | inline SVG icon components |
| `web/src/motion.ts` | `prefersReducedMotion()`, `countUp()`, `flip()` helpers |
| `web/src/arrival.ts` · `confidence.ts` · `places.ts` | pure logic, each with its own test file |
| `web/src/useGeolocation.ts` | the existing geolocation state machine |
| `web/src/layout/{Shell,BottomSheet,SidePanel}.tsx`, `layout/sheet.ts`, `layout/useMediaQuery.ts` | the two arrangements |
| `web/src/components/{TopBar,PlaceSearch,ArrivalStrip,LotCard,LotList,ProbabilityRing,ConfidencePill,FreshnessBadge,Skeleton,Notice,LangToggle}.tsx` | UI |
| `web/src/map/{MapView.tsx,colour.ts,lotSource.ts}` | map changes |
| `scripts/build-place-index.mjs` (+ test) | index builder |
| `src/parkcast/artifacts.py`, `scheduler.py`, `store.py` (+ tests) | `f` |
| `worker/src/validate.ts` (+ test) | `f` validation |

Removed: `components/DestinationSearch.tsx`, `components/LotRow.tsx`, `components/Scrubber.tsx`,
`search.ts`, `index.css`, and their tests (replaced, not deleted without replacement).

## 9. Animations

Every entry lists its trigger, its motion, and its reduced-motion form. Durations are the defaults;
`motion.css` holds them as custom properties.

| # | Where | Motion | Reduced motion |
|---|---|---|---|
| 1 | Bottom sheet | Snap with a spring-like ease (`cubic-bezier(.2,.9,.3,1.1)`, 360 ms); handle glows while dragging | Instant position change |
| 2 | Card list, ranking appears | Cards fade in and rise 12 px, staggered 40 ms, first 8 cards only | Fade only |
| 3 | Card list, time changes | FLIP: cards slide to their new positions (260 ms), new cards fade in, removed fade out | Instant reorder |
| 4 | Ring | Arc tweens from the previous value (400 ms); the number counts to the new value in step | Value jumps, arc set instantly |
| 5 | Map dots | `circle-color-transition` 300 ms on every recolour | Same (imperceptible), allowed |
| 6 | Best pick dot | Halo pulses 1 → 1.6 radius over 2 s, looped | Static halo |
| 7 | Selected dot | Halo expands once on selection (300 ms) | Static halo |
| 8 | Destination pin | Drop from −16 px with a slight overshoot; two ripple rings expand and fade (900 ms) | Pin appears |
| 9 | Locate button | Radar sweep (a conic gradient rotating, 1.2 s loop) while locating; the map `easeTo` the fix | Static "locating" label |
| 10 | Arrival strip | Highlight slides between chips (200 ms); the big time's digits roll vertically (odometer) | Highlight jumps, digits swap |
| 11 | Search | Pill expands to full width on focus (phone); results pop in staggered 30 ms | Results appear |
| 12 | Loading | Skeleton shimmer on three placeholder cards; map placeholder gradient breathes | Static placeholders |
| 13 | Freshness badge | Dot breathes (2.4 s loop); on a new reading the badge flashes teal once and every ring re-tweens | Static dot; text updates |
| 14 | Card | Press scales to .98; desktop hover lifts 2 px with `--shadow-2` | Colour change only |
| 15 | Language toggle | Label crossfade 160 ms | Swap |
| 16 | Notices | Slide down 8 px + fade (220 ms) | Fade |
| 17 | Best-pick ribbon | One shimmer sweep on appearance (800 ms) | None |

Rule: no animation blocks input or delays data. A ring mid-tween still shows the correct target on
the next frame if interrupted; FLIP measures from live DOM, never from cached positions.

## 10. Copy and i18n

New `Strings` keys (both languages): `searchHintPlaces`, `recentSearches`, `clearRecent`,
`loadingPlaces`, `groupCarParks`, `groupStations`, `groupLandmarks`, `groupStreets`, `groupAreas`,
`arrivalLabel`, `inMinutesTemplate` (`{n}`), `noForecastBeyond`, `bestPick`, `confidence`,
`confidenceHigh/Medium/Low`, `confidenceWhyHigh/Medium/Low`, `spacesNowTemplate` (`{f}`, `{c}`,
`{n}` minutes), `spacesNowNoCapacityTemplate`, `arrivalTile`, `expandList`, `collapseList`,
`expired`, `startPromptMap`, `selectedOnMap`. Lot names stay Chinese under English, as ever.

## 11. Testing

- **Pure logic (vitest):** `arrival.ts` (options, default, expiry edge, clock passing the selection),
  `confidence.ts` (thresholds, null cases), `places.ts` (folding, tiers, ordering, cap, recent
  searches with storage failures), `layout/sheet.ts` (snap by position and velocity), `motion.ts`
  (reduced-motion gating), `map/colour.ts` (new ramp, unknown off-ramp).
- **Rendered (RTL):** `LotCard` in every state of §5.4 (numbers present, "no data" wording, no 0%,
  best pick only once, count tile omitted when `f` is null); `ArrivalStrip` keyboard and change events;
  `PlaceSearch` combobox semantics and grouping; `BottomSheet` toggle button; `FreshnessBadge`
  thresholds. `tests/app.test.tsx` updated for the new structure, keeping every existing behavioural
  assertion (staleness, expiry, coverage, geolocation end states, single destination path).
- **Scripts (`node --test`):** `build-place-index.mjs` clustering, qualifiers, kind mapping, size and
  count gates on a fixture; bundle allowlist with `places/taipei.json`; smoke HEAD.
- **Python:** `build_lots_json` with `f` present/null; the store query at a `data_ts`.
- **Worker:** `f` validation accept/reject.
- **Browser check** (before merging): 390 px and 1280 px, light and dark, reduced-motion on and off;
  console clean; the map recolours on a time change; sheet snaps; search finds "台北101",
  "忠孝東路四段216巷", "西門町".

## 12. Out of scope

Forecasts later than the grid's window; a forecast free-space count; per-lot statistical confidence;
dot clustering; routing; push notifications; house-number geocoding; any change to the ranker.

## 13. Rollout

1. Data change (§7.1) first, released and verified live, so the card's count tile has data when the
   UI lands.
2. The web redesign on its own branch; `deploy:check`, then `deploy:release` with the service worker
   `VERSION` bumped.
3. Docs updated in the same branch: `README.md` (status, screenshots later), `docs/pwa.md`,
   `docs/basemap.md`, `docs/state-of-play.md`, `CLAUDE.md` (the new file map).
