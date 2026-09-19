/**
 * The screen. One page: where you are, when you arrive, and what to do about it.
 *
 * The whole app is client-side. Two static files are fetched once -- a third,
 * `week.bin`, only if the driver ever asks about a time past the grid's own
 * horizon, and a fourth, the offline place index, only if they ever open the
 * search box -- the ranking runs in this component, and nothing is ever sent
 * anywhere: the driver's location never leaves the phone, because there is no
 * server to send it to.
 *
 * Twelve things here are load-bearing rather than cosmetic:
 *
 *   - **The staleness line.** The upstream feed publishes every five minutes
 *     with a ~3-minute lag, so the reading behind any forecast is already a few
 *     minutes old. Saying so, from the grid's own `baseDataTs`, is the honest
 *     version of the "live" badge every other parking app wears -- and it is
 *     this project's entire thesis in one line of text. It now rides in the
 *     header as `FreshnessBadge`, next to the app's name, which is the one
 *     place on either layout that is always on screen.
 *   - **The staleness *correction*.** Saying it is not enough: the grid's
 *     horizons are measured from `baseDataTs`, so reading column "15 min" for a
 *     driver arriving in 15 minutes answers for 15 minutes after a reading that
 *     already happened. The arrival strip deals in wall-clock times instead, and
 *     `horizonFromReading(arrivalTs, baseDataTs)` measures from the reading --
 *     so the age is *inside* the number the grid is read at, rather than being
 *     added back by a second conversion someone could forget. That correction is
 *     the whole reason a nowcast is a model rather than a lookup. See `ageMin`
 *     below, which is the same gap shown to the user.
 *   - **The staleness *limit*, and what it is a limit on.** The correction
 *     above has an end. Once even the nearest arrival time clamps to the last
 *     column, every later one does too and the forecast is no longer about the
 *     time the user asked for; `forecastExpired` says so and `withheld` drops
 *     the probability rather than dressing a clamp up as an answer. The rest of
 *     the page keeps working. But the limit belongs to the *reading*, so it
 *     binds only the arrivals a reading was ever going to answer: tomorrow
 *     evening is weeks of climatology carrying a persistence weight of 4e-19,
 *     as good during a paused collector as outside one, and withholding that
 *     too switched the seven-day picker off for exactly the hours this
 *     collector is deliberately paused -- `week.bin` was not even fetched.
 *     Past the grid's span measured from the clock the number is shown and
 *     labelled instead. See `withheld` and `fromHistory`.
 *   - **The *horizon* limit, and the second artifact that lifts it.** The same
 *     clamp is reached from the other direction by a driver asking about
 *     tomorrow evening, and the picker offers seven days of those: past +120
 *     min every arrival reads column 23, the +120-minute number, for a time it
 *     was not computed for. So past that point the number is not read from the
 *     grid at all -- `week.bin`'s climatology is blended against the same live
 *     reading, by the same formula the server used to build the grid, which is
 *     why the two agree where they meet. The table is fetched lazily, on the
 *     first arrival that needs it, and while it is missing the honest answer
 *     out there is "no data" rather than the clamp wearing the answer's
 *     clothes. See `probabilityForLot`.
 *   - **Geolocation never leaves the user on a spinner.** Denial, failure, a
 *     browser without the API and a permission prompt closed without an answer
 *     all land in the same visible end state, with the rest of the page still
 *     working. The state machine itself lives in `useGeolocation`; this file
 *     only decides what a fix *means*.
 *   - **`baseDataTs` and `generatedAt` stay distinct.** The age shown is the age
 *     of the *reading*, not of the file we wrote from it.
 *   - **The destination is an input, not a measurement.** Geolocation answers
 *     "where am I", which is the wrong question for a driver on their way
 *     somewhere else; a tap on the map, and a place chosen by name, answer
 *     the right one. All three feed the same single `destination` through the
 *     same `pickDestination`, and either deliberate answer wins over a location
 *     still in flight. Three ways in, one path: a second one would be a second
 *     place for a stale GPS fix to overwrite what the user just said.
 *   - **The map does not wait for the destination.** Nothing a dot needs -- id,
 *     name, district, position, probability -- comes from where the driver is
 *     going, so every one draws on first paint and only the *ranking* waits.
 *     Feeding the map the ranked array instead, as this did, left the whole
 *     city invisible until the user happened to tap: the project's own
 *     "silently absent lot" failure, at every lot in the roster.
 *   - **The list does not wait for the map.** MapLibre and its stylesheet are
 *     333 KB gzipped -- more than the rest of the app together -- and a static
 *     import made the ranked list, the thing that answers the user's question,
 *     wait for the picture that illustrates it. `MapView` is loaded lazily
 *     instead, behind a placeholder that fills the map's own stage so the sheet
 *     and the list sit exactly where they will still be sitting a moment later.
 *     `mapLots` is still computed here, above the boundary, so the map is full
 *     the moment it mounts -- the previous point is not weakened by this one.
 *   - **The ranking has an edge, and the app says where it is.** `rankLots` has
 *     no distance cutoff: from Kaohsiung it will rank Taipei car parks 291 km
 *     away, in order, with a confident probability on each. Every number would
 *     be true and the answer would be useless. `COVERAGE_RADIUS_M` is where the
 *     list stops pretending. The map keeps drawing the whole city either way --
 *     it is the *ranking* that is meaningless out there, not the data.
 *   - **A tap is answered where the tap was.** Every dot on the map is
 *     tappable, and tapping one used to move the map, draw a halo and answer
 *     nothing -- a dead end at 98% of the city, because the list draws twenty
 *     rows and the map draws the whole roster. The first fix put the missing
 *     card at the top of the *list*, which the owner reported as the thing
 *     that makes no sense: the detail appeared somewhere they then had to go
 *     and find, and on a phone had to scroll to. So the card is now drawn on
 *     the map itself, in `mapCard` -- the row the ranker already scored, in
 *     the same `LotCard` the list uses, so the two can never drift into two
 *     versions of "the same detail" -- floating in the band of map the top
 *     bar and the sheet leave, with the tapped dot centred in what is left of
 *     that band (see `mapCardDepthPx` and `padding`) so the card never covers the
 *     dot it describes. It takes the "Best pick" crown only when the lot the
 *     ranking crowned is the lot that was tapped; see `bestId` for why that
 *     badge is withheld even from lots the ranking *did* rank. With no
 *     destination there is no ranking, no row to find and no card: three of
 *     the card's four fact tiles measure a trip that does not exist yet, and
 *     inventing a walk of "0 min" from a destination nobody named would be the
 *     kind of manufactured number the rest of this file exists to refuse --
 *     and the same refusal bounds the card by distance, because a lot 16 km
 *     from the destination would fill that same tile with "206 min".
 *     `cardRowFor` stops at `COVERAGE_RADIUS_M`, the edge the list already
 *     stops at. The tap is still answered out there -- the map's own popup
 *     names the lot and its chance, on the same "never 0% for no data" rule --
 *     and `startPromptMap` says how to get the rest.
 *   - **A destination can be typed.** `PlaceSearch` looks up car parks in the
 *     roster already in memory and everything else -- stations, landmarks,
 *     streets, neighbourhoods -- in an offline index built from the same
 *     basemap tiles the map already ships (see `places.ts`). No geocoder, no
 *     key, no third-party origin, and the driver's destination never leaves the
 *     phone -- which is the same promise the rest of this file makes, and would
 *     have been the first thing an address search quietly broke.
 */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { answerable, exclusionFor, tallyHidden, toggleAmenity, type Amenity } from "./amenities";
import { MAX_LEAD_SEC, MIN_LEAD_SEC, ceilToStep, clampArrival, defaultArrival, horizonFromReading } from "./arrival";
import { artifactsBase, horizonColumn, loadArtifacts, loadWeek, probabilityAt } from "./artifacts";
import { AmenityFilters } from "./components/AmenityFilters";
import { ArrivalPicker } from "./components/ArrivalPicker";
import { FreshnessBadge } from "./components/FreshnessBadge";
import { LangToggle } from "./components/LangToggle";
import { LocateButton } from "./components/LocateButton";
import { LotCard } from "./components/LotCard";
import { LotList } from "./components/LotList";
import { Notice } from "./components/Notice";
import { PlaceSearch } from "./components/PlaceSearch";
import { PreferencePicker } from "./components/PreferencePicker";
import { Skeleton } from "./components/Skeleton";
import { TopBar } from "./components/TopBar";
import type { LatLon } from "./geo";
import { Cross } from "./icons";
import { detectLang, fillTemplate, t, type Lang } from "./i18n";
import { Shell, useIsDesktop } from "./layout/Shell";
import { snapHeights, type Snap } from "./layout/sheet";
import { toMapLot } from "./map/lotSource";
import type { Place } from "./places";
import { readPreference, writePreference } from "./preference";
import { listRows, notUpdating, rankLots, type Preference, type Ranked } from "./rank";
import type { Grid, Lot, LotsDoc, WeekTable } from "./types";
import { useGeolocation } from "./useGeolocation";
import { blend, probabilityAt as weekProbabilityAt } from "./week";

/**
 * The location watchdog's deadline, re-exported from the hook that now owns it.
 *
 * It is a fact about this screen's behaviour -- how long a permission prompt
 * that answers nothing may keep the button busy -- so it stays readable from
 * here, where the behaviour is assembled, rather than only from the hook.
 */
export { GEO_WATCHDOG_MS } from "./useGeolocation";

/**
 * The map, and everything it drags in: MapLibre, the Protomaps theme
 * and `maplibre-gl.css`. Split out of the entry chunk so the first paint costs
 * what the list costs and not what the map costs.
 *
 * `./map/MapView` must stay the *only* path to that module, and it must stay a
 * dynamic one -- a static `import` of anything inside `map/` from this file, or
 * from anything this file imports eagerly, silently merges the chunk back in.
 * `map/lotSource` above is deliberately not such a case: it is pure geometry
 * with no MapLibre import of its own.
 */
const MapView = lazy(() => import("./map/MapView"));

/**
 * Where the two artifacts live. Relative to the deployment root so the app
 * works under a sub-path (GitHub Pages) without a rebuild-time absolute URL --
 * and correct for an absolute base too, which is what `artifactsBase` is for.
 */
const ARTIFACTS_BASE = artifactsBase(import.meta.env.BASE_URL);

/**
 * The offline place index, which is not an artifact: it is a build output that
 * changes only when the basemap does, so it lives under `public/` rather than
 * next to the forecast. Same base-relative join, same reason.
 */
const PLACES_URL = `${import.meta.env.BASE_URL.replace(/\/+$/, "")}/places/taipei.json`;

/**
 * How many ranked lots the *list* renders. A driver picks from the first
 * handful; past that the list is scroll for its own sake, and every extra row
 * is DOM work on a phone.
 *
 * This is a limit on the list and on nothing else. The map draws every lot in
 * the roster and never goes through the ranking at all: slicing it there would
 * silently hide 98% of the city behind a map that looked like it was showing
 * all of it.
 *
 * It is also a *soft* limit, twice over. `listRows` grows it rather than let a
 * fixed cap drop the no-forecast lots the ranker deliberately kept -- and it is
 * no longer where the list *ends*: everything else within `NEARBY_RADIUS_M`
 * comes back in `ListRows.nearby`, behind the expander below. What this number
 * decides now is how much the page renders before the driver asks for more, not
 * how far the list reaches.
 */
export const LIST_LIMIT = 20;

/**
 * How far the nearest known car park may be before the ranking stops meaning
 * anything, in metres.
 *
 * `rankLots` deliberately has no distance cutoff -- it scores whatever roster it
 * is handed against whatever point it is handed -- so without a check here the
 * app answers "where should I park?" for a driver in Kaohsiung with a confident
 * 84% on a car park 291 km away and a walk of several days.
 *
 * Nearest published car park, measured 2026-09-07 against the 1,075-lot roster:
 *
 *   | Taipei City Hall     |   0.19 km |
 *   | Beitou, north edge   |   0.14 km |
 *   | Muzha, south edge    |   0.40 km |
 *   | Banqiao, New Taipei  |   2.70 km |  <- plausibly driving into Taipei
 *   | Taoyuan Airport      |  23.45 km |  <- not
 *   | Kaohsiung            | 290.86 km |
 *
 * 10 km sits between those two with a factor of ~4 of headroom on the inside
 * and ~2.3 on the outside, which is why the exact number does not need to be
 * argued over: no plausible destination lands near it. Deliberately generous
 * towards New Taipei, whose drivers park in Taipei every day.
 */
export const COVERAGE_RADIUS_M = 10_000;

/**
 * "No filters", as one frozen array rather than a fresh `[]` per render: it is
 * a `useMemo` dependency below, and a new empty array every render would
 * re-project the whole roster on every tick.
 */
const EMPTY_FILTERS: readonly Amenity[] = [];

/** How often the staleness badge re-reads the clock. */
const CLOCK_TICK_MS = 30_000;

/**
 * How often the artifacts are refetched.
 *
 * The horizon offset is only bounded if the age is: a tab left open answers for
 * an ever-older reading otherwise, and the grid's own far end drifts into the
 * past. Two minutes is well inside the feed's five-minute cadence and
 * costs almost nothing -- `rosterId` pairing means a routine refetch revalidates
 * the cached 186 KB `lots.json` and downloads only the 26 KB grid.
 */
export const REFRESH_MS = 120_000;

/**
 * The shortest gap allowed between two trips to the network.
 *
 * The interval above is self-limiting; `visibilitychange` is not. Every switch
 * back to the tab fired a refetch, so a user flipping between this app and a
 * map application issued one request per flip, unbounded -- and an app with no
 * server has no back end to absorb that, only a CDN bill it does not want to
 * discover.
 *
 * Thirty seconds is a sixth of the feed's five-minute cadence, so the floor can
 * never be the reason a driver is looking at an older grid than exists: the
 * interval decides freshness, and this only decides how often *impatience* can.
 * The worst case it permits is two requests a minute; the worst case without it
 * is however fast someone can switch apps.
 */
export const MIN_REFETCH_MS = 30_000;

/**
 * How far ahead of this device's clock a reading may claim to be before it is
 * refused. A reading from the future is a broken clock upstream or a forged
 * upload; shown as it is, it would read "0 min old" forever (spec §6.2).
 */
export const FUTURE_TOLERANCE_SEC = 600;

/**
 * The top bar's height, mirroring `--topbar-height`: the map's padding at the top.
 *
 * Exported because it is half of `snapHeights`'s input, and the sheet header's
 * own height budget is asserted against the result -- see
 * `tests/preferencePicker.test.tsx`. A test that hardcoded 60 beside this would
 * go on passing through the one change it exists to notice.
 */
export const TOP_BAR_PX = 60;

/** The side panel's width, mirroring `--panel-width`: the map's padding at the left. */
const PANEL_PX = 420;

/**
 * How deep into the map's own band the card reaches, measured off the card
 * that is on screen rather than declared beside it.
 *
 * **This was a constant, and the constant is what broke.** `MAP_CARD_PX = 288`
 * was measured once, against a card with a confidence pill and four fact
 * tiles. `c0ff877` then dropped the arrival tile and added two amenity ones:
 * the card became 289 px at 375 px wide, and 385 px at 360 px, where
 * `components.css` stacks the fact tiles into a single column. The number
 * beside the code and the box on the screen drifted apart in silence, and at
 * 360 px the eased dot landed *inside* the card that describes it -- the one
 * thing this geometry exists to prevent. Nothing could have caught it: jsdom
 * lays nothing out, so the test compared the offset against the same constant
 * the offset came from, and the two agreed with each other all the way down.
 *
 * So the card is asked instead. `offsetTop` and `offsetHeight` are layout
 * values: they ignore the entrance transform that `getBoundingClientRect`
 * would have included, and read in a layout effect one commit after the card
 * mounts they are the box the driver is about to look at. A tile added
 * tomorrow moves the dot tomorrow, with nothing to update and nothing to
 * remember.
 *
 * `bandTop` is `padding.top` -- where the strip of map the chrome leaves
 * begins -- so the answer is how much of that strip the card is sitting on.
 *
 * **Spent as half of itself**, as the `offset` on the centre request: without
 * one, `easeTo` puts the tapped lot in the middle of the band the top bar and
 * the sheet leave, which is inside the card. Displacing it by half of what the
 * card covers puts it in the middle of what the card leaves -- ~88 px clear of
 * each on a 375x812 phone at `peek`, ~64 px at 360x740.
 *
 * Which is also why this is not folded into `padding`. Padding decides where
 * on the canvas the map's centre is *drawn*, so adding the card's depth to it
 * and taking it away again moves the whole picture by half that depth twice,
 * and the second of those happens when the card is dismissed with no camera
 * movement to absorb it: the map lurching as a card closes. The offset rides
 * with the ease that is already happening instead.
 *
 * **The other half of the guarantee is in CSS.** Measuring puts the dot below
 * whatever the card turned out to be, but it cannot invent room that is not
 * there -- at 320x568 the card wants 309 px of a 268 px band, and no offset
 * fixes that. `.map-card`'s own `max-height` in `styles/components.css` is
 * what bounds it, so the gap this arithmetic centres the dot in is never empty
 * however many tiles the card grows.
 */
function mapCardDepthPx(card: HTMLElement | null, bandTop: number): number {
  if (card === null) return 0;
  return Math.max(0, card.offsetTop + card.offsetHeight - bandTop);
}

interface Artifacts {
  grid: Grid;
  lots: LotsDoc;
}

/** How far ahead of its own reading `grid.bin` forecasts, in minutes: 120 as built. */
function gridSpanMin(grid: Grid): number {
  return grid.stepMin * grid.nHorizons;
}

/**
 * P(at least one space) for one lot at one arrival time, from whichever
 * artifact actually covers that time.
 *
 * Read at the row the lot *declares*, never at its position in the array:
 * `fetchLots` drops a row it cannot place, and reading by position after that
 * hands every later lot its neighbour's forecast -- a silent, plausible-looking
 * wrong answer for most of the city. Both readers, the ranking and the map, go
 * through here, so the two cannot disagree about which row belongs to which car
 * park.
 *
 * Guarded rather than raw at every index: a roster longer than either artifact
 * would otherwise throw mid-render and take the whole page down, when "no data"
 * for the extra rows is both true and survivable.
 *
 * **Which artifact answers is the whole point of this function.**
 *
 *   - **Inside the grid's own window** (`horizonMin <= gridSpanMin`), the grid
 *     answers. It is a number the server computed and the backtests in
 *     `docs/state-of-play.md` actually measured, and it stays the source there
 *     even once `week` is in memory.
 *   - **Past it**, the grid has nothing left: `horizonColumn` clamps, and every
 *     arrival from +121 minutes to +7 days reads the same column 23 -- the
 *     +120-minute figure. That clamp is the right behaviour for an accessor
 *     asked a question off the end of its own data; presenting its output as an
 *     answer for tomorrow evening is not. Since the picker widened to seven
 *     days, about 98.8% of the range it offers lands there. So past the window
 *     the number comes from `week.bin` instead, through the same
 *     `blend(f, climatology, minutesFromReading)` the server computes its own
 *     grid with -- which is why the two agree at the seam (`seam.test.ts`)
 *     rather than jumping as a driver drags across the two-hour mark.
 *   - **With no week cell to read** -- the table was never fetched, is still in
 *     flight, came back 503 or failed, the lot sits off the end of its roster,
 *     or the cell carries `WEEK_UNKNOWN` -- the answer is
 *     `null`. "No data" is the honest thing to say about a time nothing we hold
 *     covers. A bucket nobody has *watched* is deliberately not one of these
 *     cases: it carries the citywide fallback with `support = 0`, so a number
 *     shows and the confidence pill reads "low - thin" beside it. See
 *     `week.ts`'s `WEEK_UNKNOWN` for why that sentinel is a defensive path
 *     rather than the routine one. There is deliberately no path from here back to the clamp, and no
 *     `p ?? 0`: zero is a claim ("reliably full at this hour"), and `week.ts`'s
 *     `blend` spells out at length why resolving that `null` is the caller's
 *     job and never a coercion.
 *
 * `blend`'s `minutesFromReading` is `horizonMin`, which `horizonFromReading`
 * measured from `baseDataTs` -- the reading -- and not from the wall clock. At
 * these horizons the persistence weight has decayed to nothing anyway, but the
 * two must not be allowed to drift apart at the seam, where it has not.
 */
function probabilityForLot(
  grid: Grid,
  week: WeekTable | null,
  lot: Lot | undefined,
  horizonMin: number,
  arrivalTs: number,
): number | null {
  if (lot === undefined) return null;
  const row = lot.i;
  if (horizonMin <= gridSpanMin(grid)) {
    return row >= grid.nLots ? null : probabilityAt(grid, row, horizonMin);
  }
  if (week === null || row >= week.nLots) return null;
  const { p } = weekProbabilityAt(week, row, arrivalTs);
  // `f` is absent when the lot was not observed at the reading and `null` when
  // it was observed reporting nothing; neither is a count, and `blend` falls
  // back to climatology alone for both.
  return p === null ? null : blend(lot.f ?? null, p, horizonMin);
}

/**
 * How many observations stand behind this lot's half-hour-of-week cell, which
 * is what `confidenceFor` grades a forecast on.
 *
 * Zero whenever the week table is not in hand -- "we have not watched this lot
 * at this hour often enough yet" is exactly what an unfetched table can honestly
 * claim, and `confidence.ts` reads 0 as its thinnest evidence rather than as a
 * missing input. Read at the *arrival's* time of week, the same bucket the
 * probability came from, so the grade and the number can never describe
 * different half-hours.
 *
 * Not gated on the grid's window: support is evidence about a time of week, not
 * about which artifact happened to answer. Once the table is in memory a lot
 * with four weeks of 21:20s behind it reads "high" whether the arrival is ninety
 * minutes away or a day and a half.
 *
 * **That makes an in-window grade path-dependent within a session, on purpose.**
 * A driver who picks 100 minutes out cold sees "low · thin"; one who went out to
 * tomorrow first and came back sees "high · 5 weeks" for the same lot at the
 * same arrival, because the table is now in hand. Both labels are true when they
 * are shown -- the second is simply better informed, and `confidenceThin`'s own
 * wording ("not watched at this time of week often enough **yet**") is the
 * honest thing to say while we are holding no history to point at. The number
 * beside it does not move: inside the window it is the grid's column either way.
 * Gating support on the window would trade that for the opposite fault -- a
 * grade decided by how far away the arrival is, which is exactly the behaviour
 * this whole stage exists to remove (see `confidence.ts`'s header). Pinned by
 * `tests/app.test.tsx`'s "upgrades an in-window grade once the week table has
 * landed", so gating it later is a decision somebody makes rather than a
 * regression nobody notices.
 */
function supportForLot(week: WeekTable | null, lot: Lot | undefined, arrivalTs: number): number {
  const row = lot?.i;
  if (week === null || row === undefined || row >= week.nLots) return 0;
  return weekProbabilityAt(week, row, arrivalTs).support;
}

/**
 * What stands where the map will be while its chunk is still downloading.
 *
 * Two things make this a placeholder rather than a gap:
 *
 *   - It **fills the map's stage** (`.map-placeholder` is positioned absolutely
 *     inside `.map-stage`, which is the whole viewport), so nothing above it
 *     moves when the chunk lands. A collapsing fallback would shove the sheet
 *     and the list around the instant the map arrived -- a worse bug than the
 *     slow first paint this split exists to fix.
 *   - It reads as **loading, not broken**. Nothing has failed here: the answer
 *     is already on screen and the illustration is on its way. `role="status"`
 *     rather than `role="alert"` says the same thing to a screen reader, and
 *     `mapUnavailable` remains the string for the case that really did fail.
 */
function MapPlaceholder({ lang }: { lang: Lang }) {
  return (
    <p className="map-placeholder" role="status" data-testid="map-loading">
      {t(lang).mapLoading}
    </p>
  );
}

/**
 * `window.localStorage`, or `null` when there is none or asking for it throws.
 *
 * The twin of `PlaceSearch`'s own `defaultStorage`, and deliberately a twin
 * rather than a shared import: `preference.ts` takes a `Storage` precisely so
 * that *the caller* owns the decision about where it comes from, which is what
 * makes the SSR case and the test case a `null` instead of a special case. The
 * getter itself is what throws when site data is blocked -- before any
 * `getItem` runs -- so the guard has to be here, on the way in.
 */
function deviceStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export default function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [artifacts, setArtifacts] = useState<Artifacts | null>(null);
  /**
   * `week.bin`, or `null` until an arrival past the grid's window has asked for
   * it. Never fetched on load: see the effect below.
   */
  const [weekTable, setWeekTable] = useState<WeekTable | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [destination, setDestination] = useState<LatLon | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  /**
   * When the driver expects to arrive, as an absolute unix second rather than
   * "minutes from now". The strip offers clock times because that is what a
   * driver actually knows, and an absolute time cannot silently mean something
   * different a minute later the way a relative one can.
   */
  const [arrivalTs, setArrivalTs] = useState(() => defaultArrival(Math.floor(Date.now() / 1000)));
  /**
   * The lot tapped on the map or in the list, and which of the two it was.
   * The map draws a halo; it does not own this.
   *
   * The source rides with the id rather than in a second piece of state, so
   * the two cannot drift: a selection made in the list must never leave a
   * `fromMap` flag behind from the tap before it, which is what would put a
   * card over the map for a row the driver is already looking at. See
   * `mapCard`, which is the only thing that reads it.
   */
  const [selected, setSelected] = useState<{ id: string; fromMap: boolean } | null>(null);
  const selectedLotId = selected?.id ?? null;
  /**
   * Which of 機車 / 充電 the driver is filtering the list on. Empty is the
   * unfiltered screen, and the one this app opens in.
   *
   * State rather than a URL parameter or storage on purpose: it is a question
   * about this trip ("I am on a scooter today"), not a preference, and a
   * filter silently restored from a previous session would shorten the list
   * for a reason nothing on screen explains.
   */
  const [pressedFilters, setPressedFilters] = useState<readonly Amenity[]>([]);
  /**
   * Which way the driver asked the ranking to lean, and the one piece of state
   * on this screen that outlives the visit.
   *
   * Storage on purpose, where `pressedFilters` above is deliberately not: "I
   * would rather walk less" is a standing preference about how this person
   * drives, not a fact about today's trip, and restoring it explains itself --
   * the control is on screen showing the choice that produced the order. A
   * filter restored from a previous session would instead be a shorter list
   * with nothing on screen to account for it.
   *
   * Read once, in the initialiser, so a reload is the only thing that consults
   * storage and a tab whose storage is blocked still ranks by
   * `DEFAULT_PREFERENCE` rather than failing to start. See `preference.ts`.
   */
  const [preference, setPreference] = useState<Preference>(() => readPreference(deviceStorage()));
  /**
   * The card the pointer is over, which the map answers with a faint ring on
   * that lot's dot (spec §5.6) -- the link between a row in the list and a point
   * in the city, without a tap. Desktop in practice; on the phone the sheet is
   * over the map and a tap selects outright.
   */
  const [hoverLotId, setHoverLotId] = useState<string | null>(null);
  /** Where to move the map, and when it was asked -- see `MapViewProps.centerRequest`. */
  const [centerRequest, setCenterRequest] = useState<{
    lat: number;
    lon: number;
    offsetY: number;
    nonce: number;
  } | null>(null);
  /**
   * The same move, before the card it has to clear has been measured.
   *
   * A tap does two things at once: it draws a card and it moves the map out
   * from under it. The second needs the first's height, and in the click
   * handler the card does not exist yet -- which is the hole the old constant
   * was filling. So a tap records *what* to centre here, and the layout effect
   * below turns it into a real `centerRequest` once the card is on the page.
   */
  const [centerPending, setCenterPending] = useState<{
    lat: number;
    lon: number;
    carded: boolean;
    nonce: number;
  } | null>(null);
  /** The card the map draws, so its rendered box can be asked about. See `mapCardDepthPx`. */
  const mapCardRef = useRef<HTMLElement | null>(null);
  const [snap, setSnap] = useState<Snap>("peek");
  /**
   * The viewport's height, because the sheet's is a fraction of it and the map
   * has to know how much of itself the sheet is covering. Kept in state rather
   * than read off `window` at render time: a phone rotated in place changes
   * this without changing anything else React would re-render for, and the map
   * would go on centring under a sheet that is no longer that tall.
   */
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 800 : window.innerHeight,
  );
  const desktop = useIsDesktop();

  const s = t(lang);

  // Whether a grid has ever landed, read from inside the fetch effect -- state
  // would make the effect re-run on the load it just did.
  const loadedRef = useRef(false);
  /** When the artifacts were last asked for, so `MIN_REFETCH_MS` has something to measure. */
  const lastFetchRef = useRef(0);
  /**
   * `useGeolocation`'s `abandon` and `clearFailure`, held in refs because
   * `pickDestination` is what the hook is *given* -- the two would otherwise
   * have to be declared in an order neither one allows. Refs also keep a
   * destination chosen by hand from being overwritten by a location request
   * started in an earlier render, which is the failure this abandon exists for.
   */
  const abandonRef = useRef<(() => void) | null>(null);
  const clearFailureRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Stamped here rather than at the call site that asked for the refetch, so
    // it records what actually happened -- a trip to the network -- and covers
    // the retry button and the first load as well as the two schedulers below.
    lastFetchRef.current = Date.now();
    loadArtifacts(ARTIFACTS_BASE).then(
      (loaded) => {
        if (cancelled) return;
        if (loaded.grid.baseDataTs > Date.now() / 1000 + FUTURE_TOLERANCE_SEC) {
          // Handled exactly like a failed load: keep the grid we have, or say we
          // could not load. Never present it as fresh.
          if (!loadedRef.current) setLoadFailed(true);
          return;
        }
        loadedRef.current = true;
        setArtifacts(loaded);
        setLoadFailed(false);
      },
      () => {
        // A failed *refresh* must not replace a working screen with an error:
        // the grid we hold is older than we wanted, not missing, and the
        // staleness badge already says so.
        if (!cancelled && !loadedRef.current) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, refresh]);

  // The staleness badge is only honest if it keeps counting.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // ...and the correction below is only bounded if the reading keeps arriving.
  useEffect(() => {
    const bump = () => setRefresh((n) => n + 1);
    const id = setInterval(() => {
      // Nobody is reading a hidden tab, and polling one is exactly the battery
      // cost an app with no server has no excuse for.
      if (document.visibilityState !== "hidden") bump();
    }, REFRESH_MS);
    const onVisibility = () => {
      // Coming back is the moment the age is largest and the user is looking...
      if (document.visibilityState !== "visible") return;
      // ...but only if we have not just been. See `MIN_REFETCH_MS`.
      if (Date.now() - lastFetchRef.current < MIN_REFETCH_MS) return;
      bump();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // A rotation, a desktop window dragged taller, a mobile URL bar sliding away:
  // all of them move the sheet without anything else on the page changing.
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The page's own language, for assistive tech, font fallback and line
  // breaking. `index.html` can only ship one guess; this is the real answer.
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-Hant" : "en";
  }, [lang]);

  const grid = artifacts?.grid ?? null;
  const nowSec = Math.floor(nowMs / 1000);

  /**
   * Whole minutes since the *reading*, not since the file was written.
   *
   * Shown in the freshness badge and folded into every horizon through
   * `horizonFromReading`: those are two uses of one gap, and they must not
   * drift apart.
   */
  const ageMin = grid === null ? null : Math.max(0, Math.round((nowSec - grid.baseDataTs) / 60));

  /**
   * The window `ArrivalPicker` may choose from: never earlier than the
   * nearest arrival the app will answer for, never later than what
   * `MAX_LEAD_SEC` bounds the picker to (see its own comment in
   * `arrival.ts`). Bounded by the *clock*, not the grid -- unlike the old
   * strip's `arrivalOptions`, this window has nothing to do with how far
   * `grid.bin` itself reaches, which is exactly the "why can't I pick
   * tomorrow" complaint `ArrivalPicker` exists to answer.
   */
  const arrivalBounds = useMemo(
    () => ({ min: ceilToStep(nowSec + MIN_LEAD_SEC), max: nowSec + MAX_LEAD_SEC }),
    [nowSec],
  );

  // The clock walks the near end of the window forward every tick. A chosen
  // time left behind by it is a selection nothing on screen still offers --
  // `ArrivalPicker` itself never produces one (every list it renders is
  // pre-filtered to the live window, see R10 in its own file comment), but a
  // `value` already passed can only be noticed here, one tick after the fact,
  // and corrected forward to the nearest still-selectable time.
  //
  // Written back into state rather than clamped on the way out at render
  // time, which is the same picture but not the same behaviour: a clamp
  // applied only on read would spring the selection back to the time the
  // user originally asked for the moment the window moved again, without
  // anybody touching it. React bails out when the clamp changes nothing, so
  // the extra render costs a tick only on the rare update that actually
  // moves the selection.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setArrivalTs((ts) => clampArrival(ts, arrivalBounds));
  }, [arrivalBounds]);

  /**
   * The horizon actually read out of the grid: the arrival time measured from
   * `baseDataTs` instead of from now.
   *
   * `grid.py` evaluates column `c` at `baseDataTs + (c + 1) * stepMin`, so a
   * grid five minutes old answers "in 15 min" with a forecast for now + 10.
   * Measuring from the reading is the staleness correction the design spec
   * calls the nowcast's whole job -- and, because the strip deals in absolute
   * times, it is a subtraction rather than an age added back.
   *
   * At the far end this can still run off the grid, and `probabilityAt` clamps
   * to the last column. That is the right trade: a few minutes short at the end
   * of the strip is a far smaller lie than being minutes wrong at +5.
   *
   * It stops being a trade once the *age alone* runs off the grid -- see
   * `forecastExpired`.
   */
  const horizonFromReadingMin = grid === null ? 0 : horizonFromReading(arrivalTs, grid.baseDataTs);

  /**
   * The reading is old enough that no arrival time the user can pick is still
   * answerable, so there is no forecast left.
   *
   * The test is the *nearest* arrival time: once even `stepMin` from now lands
   * on the last column, every later one clamps to it too, the strip cannot
   * change the answer, and every chip on it would show one identical answer for
   * a time nobody asked for. Observed with a 383-minute-old artifact, and
   * certain to recur -- the collector stops whenever the machine it runs on
   * sleeps, while the published copy stays up and goes on ageing.
   *
   * Comparing the age against the grid's whole span (`stepMin * nHorizons`,
   * 120 as built) is the obvious version of this and trips one window late: at
   * the shipped geometry the answer goes inert at an age of 113 minutes --
   * `round((5 + 113) / 5) - 1` is already column 23 -- while `age > 120` waits
   * until 121. For those eight minutes the control was live, the heading claimed
   * an order, and every position rendered the same clamped column.
   *
   * The clamp is right; presenting its output as an answer is not. So the
   * probability is dropped at its source below: one `null` per lot, which puts
   * every row on the "no data" path the UI already has for a missing cell and
   * the map on the grey it already has for an unknown one. Names, distances and
   * prices never came from the grid and are untouched -- it is the forecast that
   * expired, not the page.
   *
   * This is a fact about the *reading*, and it is used as one: the freshness
   * badge reports it whatever arrival is chosen. Which probabilities it drops
   * is `withheld`'s question, not this one's.
   */
  const forecastExpired =
    grid !== null &&
    ageMin !== null &&
    horizonColumn(grid, grid.stepMin + ageMin) === grid.nHorizons - 1;

  /**
   * The chosen arrival is past everything `grid.bin` covers, so the number can
   * only come from `week.bin`.
   *
   * **The order of the three predicates below matters, and this is the reason.**
   * `needsWeek = beyondGrid && !withheld` only says what it means because
   * `distantArrival` implies this -- and that implication holds only while
   * `baseDataTs <= nowSec`, since `beyondGrid` measures from the reading and
   * `distantArrival` from the clock. Under a device clock running behind the
   * server an arrival could be distant (so not withheld) without being past the
   * grid, and `probabilityForLot` would then take the grid path and hand back
   * the clamped last column for a time past its span. It needs a wrong client
   * clock to happen, `ageMin`'s own `Math.max(0, ...)` already keeps
   * `forecastExpired` false in that state, and the pre-10b code clamped the
   * same way -- but a future reader rearranging these three has nothing else
   * telling them the order is load-bearing.
   */
  const beyondGrid = grid !== null && horizonFromReadingMin > gridSpanMin(grid);

  /**
   * The arrival is further ahead than the grid's own span *measured from the
   * clock*, so no reading -- however fresh -- was ever going to cover it.
   *
   * Measured from now rather than from `baseDataTs`, which is the one place in
   * this file that deliberately does not apply the staleness correction, and
   * the reason is the correction itself: `horizonFromReadingMin` folds the
   * reading's age in, so with a 383-minute-old artifact *every* arrival --
   * "in 20 minutes" included -- sits past the grid's window. Using it here
   * would hand the near term to climatology the moment the collector paused,
   * which is exactly the claim `forecastExpired` exists to refuse. From the
   * clock, "further ahead than a reading reaches" means the same thing at
   * every reading age, and with a fresh reading the two measures agree to
   * within its own few minutes.
   */
  const distantArrival = grid !== null && arrivalTs - nowSec > gridSpanMin(grid) * 60;

  /**
   * Nothing this app holds can answer the arrival the user chose, so no
   * probability is shown for it.
   *
   * This is `forecastExpired` narrowed to the arrivals it is actually a
   * statement about. The reading has aged off the end of the grid, so for a
   * time in the next couple of hours -- the times only a reading can answer --
   * there is no forecast left and the clamp must not be dressed up as one.
   * For tomorrow evening there never was a reading in the answer: at 1,832
   * minutes out `blend`'s persistence weight is 4e-19, the number is weeks of
   * accumulated climatology, and climatology does not go stale because the
   * collector was paused for an afternoon. Withholding it too switched the
   * seven-day picker off entirely in the state where it is most useful, and
   * the operator of this app pauses the collector deliberately, for hours.
   *
   * What is withheld is unchanged; what is no longer withheld is labelled --
   * see `fromHistory` below, which is the other half of the bargain: a number
   * that appears here must say it came from history rather than from a
   * reading, or the freshness badge beside it becomes a dateline for a claim
   * it was never making.
   */
  const withheld = forecastExpired && !distantArrival;

  /**
   * Fetch the week table exactly when it will be read.
   *
   * `beyondGrid` alone would download 715 KB during a stale period for every
   * near arrival whose probability `withheld` then drops -- the table pulled
   * only to be thrown away, on a phone, on a metered connection. The fetch
   * follows the read, as it always has; it is only the *read* that widened.
   */
  const needsWeek = beyondGrid && !withheld;

  /**
   * `week.bin`, on the first arrival chosen outside the grid's window and never
   * before it.
   *
   * 715 KB for a table most sessions never consult: a driver asking about the
   * next half hour is answered entirely from the 26 KB grid, and paying for the
   * climatology up front would be a worse first paint for the common case in
   * exchange for nothing. Same bargain `PlaceSearch` strikes with the offline
   * place index on its first focus.
   *
   * **`loadWeek`'s promise cache is what makes "once" true, and it is the only
   * thing that does.** There is deliberately no in-flight flag here. This effect
   * re-runs on every new far arrival, so it can call `loadWeek` several times
   * over; each call while a request is in the air hands back the *same* promise,
   * so the extra runs re-subscribe rather than re-download, and the callbacks
   * they attach are gated by their own `cancelled`. `PlaceSearch` does hold such
   * a flag, and an earlier draft of this effect copied it -- which is how this
   * task rediscovered the bug that flag is famous for, in a nastier form: the
   * dependency that re-runs *this* effect (`arrivalTs`) changes in the same
   * commit as the cleanup that lowers the flag, so a `useState` version still
   * read `true` from the render being cleaned up, refused the very run meant to
   * take over, and left the screen saying "no data" for the rest of the session.
   * A ref fixed the instance; deleting the flag removes the failure mode, and
   * costs nothing, because it was never what prevented the second download.
   * `tests/app.test.tsx`'s "does not strand the request when the arrival moves
   * while it is still in the air" is what holds that line.
   *
   * Retrying is `loadWeek`'s half of the bargain too: a failed attempt drops
   * itself from its cache, so the next far arrival genuinely goes back to the
   * network instead of inheriting the first answer forever. Between the two, a
   * 503 from a Worker whose collector has not uploaded a table yet costs one
   * request and nothing else.
   */
  useEffect(() => {
    if (!needsWeek || weekTable !== null) return;
    let cancelled = false;
    void loadWeek(ARTIFACTS_BASE).then((table) => {
      if (cancelled) return;
      // `null` is a failed or refused load, which must not be committed as
      // "loaded": that is what leaves the next attempt free to try again.
      if (table !== null) setWeekTable(table);
    });
    return () => {
      cancelled = true;
    };
    // `weekTable` is set BY this effect; listing it would rerun the effect on
    // its own state change, calling the cleanup above and cancelling the
    // fetch's own callback before the response ever arrives.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [needsWeek, arrivalTs]);

  /**
   * The week table, but only while it describes the same roster the grid does.
   *
   * `week.bin` is indexed by grid row, so a table built against a different
   * ordering answers every lot with some other car park's history -- silently,
   * and plausibly. It is the same `rosterId` check `loadArtifacts` makes across
   * the grid/lots pair, applied here rather than at fetch time so that the
   * refreshed grid two minutes later can heal a table fetched across a
   * republish without anything being re-downloaded. Until it matches, the
   * honest answer past the grid's window is "no data".
   */
  const week = weekTable !== null && grid !== null && weekTable.rosterId === grid.rosterId ? weekTable : null;

  /**
   * A destination, from whichever of the three ways the user said it.
   *
   * Whatever the pending location request was about to say, it is answering a
   * question the user has now answered better -- and a position that landed a
   * second later would silently move the destination off the chosen point. A
   * failure the user has routed around stops being worth reporting, and the
   * selection belongs to the old destination, not this one.
   */
  const pickDestination = useCallback((at: LatLon) => {
    abandonRef.current?.();
    clearFailureRef.current?.();
    setSelected(null);
    setDestination(at);
  }, []);

  const { geo, request, abandon, clearFailure } = useGeolocation(pickDestination);
  useEffect(() => {
    abandonRef.current = abandon;
    clearFailureRef.current = clearFailure;
  }, [abandon, clearFailure]);

  /**
   * Which of the two filters the roster on hand can actually answer.
   *
   * **A control whose only possible outcome is an empty list is not a
   * control.** `lots.json` carries `m` and `e` only from a collector built
   * after `edc980b`, and the roster live today has 1,089 lots and neither key
   * on any of them. Pressing 機車 against that roster is honest at every word
   * -- the notice says "does not mention it at all, which is not the same as
   * having none" -- and completely useless: no rows, every dot in the city
   * dimmed, and a hidden count of twenty standing for 1,089. So the chip is
   * not offered until some car park in the roster has answered the question it
   * asks.
   *
   * This says something about the data on hand, never about a car park, so it
   * breaks nothing the rest of this feature promises: a lot that reports zero
   * scooter bays still keeps the chip on screen and is still hidden by it,
   * because a reported zero is an answer. It is the same guard `listFilters`
   * already applies one layer down -- refusing to act on a filter when there
   * is no list for it to be a statement about -- and it covers the five cities
   * still to come online as well as the window between the collector's rebuild
   * and the web app's release.
   */
  const availableFilters = useMemo(
    () => (artifacts === null ? EMPTY_FILTERS : answerable(artifacts.lots.lots)),
    [artifacts],
  );

  /**
   * The filters as the list may act on them: what the driver pressed, narrowed
   * to what the roster can answer.
   *
   * Derived rather than pruned in place, because a roster can change under a
   * pressed chip -- the app refetches `lots.json` and the collector's rebuild
   * lands mid-session -- and a filter left active with no chip to unpress it
   * would be a shorter list the driver has no way to lengthen again.
   */
  const filters = useMemo(
    () => pressedFilters.filter((a) => availableFilters.includes(a)),
    [pressedFilters, availableFilters],
  );

  /**
   * Every lot, ranked. Not sliced: `listRows` decides what the list shows.
   *
   * Recomputed when the arrival time moves: a new column out of a grid already
   * in memory, no request, no refetch. The same is true of the preference,
   * which changes two prices inside `rankLots` and nothing else -- so choosing
   * one re-orders the cards already on screen and asks the network for nothing.
   */
  const ranked = useMemo(() => {
    if (artifacts === null || destination === null) return [];
    const { grid: g, lots } = artifacts;
    const rows = lots.lots;
    return rankLots({
      destination,
      horizonMin: horizonFromReadingMin,
      lots: rows,
      // `rows[i]`, resolved through `Lot.i` inside: `rankLots` reports the array
      // position it scored, and the grid row is the lot's own business.
      probability: (i, h) => (withheld ? null : probabilityForLot(g, week, rows[i], h, arrivalTs)),
      preference,
    });
  }, [artifacts, week, destination, horizonFromReadingMin, arrivalTs, withheld, preference]);

  /**
   * The ranking, narrowed to the lots that have what the driver asked for.
   *
   * **Applied to the whole ranking and not to the list's own head**, which is
   * the difference between a filter and a blindfold: 395 of Taipei's 1,773
   * car parks have scooter bays, so filtering the twenty rows the list already
   * shows would usually leave two or three and stop there, while the ranking
   * has plenty more a little further down. Narrowing first and slicing after
   * lets the list refill from the same ordering.
   *
   * It narrows and never reorders: `Array#filter` preserves order, so row 40's
   * promotion to row 3 is the ranker's own verdict on the lots that remain,
   * not a second opinion about them.
   */
  const matching = useMemo(
    () => (filters.length === 0 ? ranked : ranked.filter((row) => exclusionFor(row.lot, filters) === null)),
    [ranked, filters],
  );

  /**
   * What the list draws, in two parts: the head of the ranking -- grown if the
   * cap would otherwise drop a nearby lot the ranker kept on purpose -- and
   * every other car park within walking distance, for the expander. See
   * `listRows`.
   */
  const listed = useMemo(() => listRows(matching, LIST_LIMIT), [matching]);

  /**
   * Whether the driver has asked for the rest of the neighbourhood.
   *
   * The whole reason the tail is behind a control rather than simply appended:
   * at 1.5 km a Taipei destination has a median of 74 car parks around it and
   * up to 156, and laying 156 cards out on a phone is a cost this project has
   * already been told about once. Closed, the page renders exactly the twenty
   * rows it rendered before; open, it renders what was asked for.
   *
   * **Not reset when the destination or the filters move.** It is a standing
   * answer to "how much of the neighbourhood do you want to see?", not a fact
   * about one search, and a driver who wants the wide view at every destination
   * should not have to ask again at each one. The cost of the other choice is
   * the more visible one: re-collapsing the list under a driver who opened it
   * is the app taking a decision back. What a new destination *does* change is
   * the count on the control, which is recomputed with everything else.
   */
  const [nearbyOpen, setNearbyOpen] = useState(false);

  /**
   * How many car parks the filter took out of the list, split by why.
   *
   * **The scope is the rows the list would have shown with no filter on** --
   * `listRows(ranked, LIST_LIMIT).head`, normally twenty. Not the whole roster:
   * a tally of "1,050 hidden" is arithmetic about a city, and what a driver
   * needs explained is the list in front of them that just got shorter. Not
   * the filtered list either, which by construction has nothing hidden in it.
   *
   * **And not the nearby tail**, open or closed, for the same reason: at 1.5 km
   * the tail is a neighbourhood of up to 156 car parks, so counting it here
   * would turn a sentence about a list back into arithmetic about a city --
   * which is the one thing this scope was chosen to avoid. The tail narrows
   * with the same filter (it is cut from `matching`, like the head), and the
   * expander's own count says how many rows survived it.
   *
   * **And it is two numbers, never one.** That is the whole reason this
   * exists. "No car park near here takes scooters" and "the data doesn't say"
   * are different answers, and a single hidden count would fuse them into the
   * pessimistic one -- which is the same lie as rendering an absent `m` as
   * `0`, just arrived at by subtraction. `exclusionFor` keeps them apart and
   * the notice below prints both.
   */
  const hidden = useMemo(
    () => tallyHidden(listRows(ranked, LIST_LIMIT).head.map((row) => row.lot), filters),
    [ranked, filters],
  );

  /** Turn one filter chip on or off. Stable, so `AmenityFilters` never re-renders for a hover. */
  const toggleFilter = useCallback((amenity: Amenity) => {
    setPressedFilters((active) => toggleAmenity(active, amenity));
  }, []);

  /**
   * The driver chose a way for the ranking to lean.
   *
   * Two effects and no third: the ranking re-runs (`ranked` below reads
   * `preference`), and the choice is written down for next time. Nothing here
   * scrolls the list, moves the map or touches the arrival -- the same
   * restraint `ArrivalPicker`'s own `onChange` observes, and the reason this is
   * two lines rather than a handler with opinions. Re-ranking is visible on its
   * own: the cards slide to their new places (`LotList`'s FLIP) and the map's
   * best-pick halo follows `bestId`.
   *
   * Written on the change rather than in an effect on `preference`, so the one
   * thing that reaches storage is a choice the driver actually made -- never a
   * default echoed back over a value some other tab has just written.
   */
  const choosePreference = useCallback((next: Preference) => {
    setPreference(next);
    writePreference(deviceStorage(), next);
  }, []);

  /**
   * The ranked row a dot on the map would be carded from, or `null`.
   *
   * Every dot is tappable and the ranking has a row for every lot, so this is
   * a lookup rather than a second scoring path: `ranked` is every lot, against
   * the same destination, at the same arrival, through the same ranker, so the
   * card the map draws is exactly the card the list would have drawn for that
   * car park. A second path would be a second thing to keep in step.
   *
   * `null` when no destination has been chosen, because `ranked` is empty then
   * and there is no row to find. Three of the card's four fact tiles measure a
   * trip that does not exist yet, and inventing a walk of "0 min" from a
   * destination nobody named would be the kind of manufactured number the rest
   * of this file exists to refuse. See the module comment.
   *
   * `null` too when the tapped lot is further than `COVERAGE_RADIUS_M` from the
   * destination, which is the same edge the list stops at. `ranked` has no
   * distance cutoff, so it scores a car park 16 km away as readily as one
   * 200 m away, and the card would fill its walk tile with "206 min" -- every
   * number of it true, and none of it a trip anybody is going to make. 100 of
   * the roster's 1,090 lots are more than 10 km from Taipei 101, and the map
   * draws and answers every one of them.
   *
   * Per row, not per destination. `outsideCoverage` below asks whether the
   * *destination* has any car park near it, which says nothing about how far
   * the *tapped* one is, so gating the card on it left the case above wide
   * open. The per-row bound subsumes it in the other direction -- if nothing in
   * `ranked` is within the radius then this row is not either.
   *
   * Either way the tap is still answered: `MapView` falls back to the popup it
   * has always drawn -- the lot's name and its chance, on the same "never 0%
   * for no data" rule -- for exactly the dots this returns `null` for, which is
   * what `hasCard` below tells it, at the moment of the tap. `startPromptMap`
   * and `outsideCoverage`'s notice say in words how to get the rest.
   */
  const cardRowFor = useCallback(
    (id: string): Ranked | null => {
      const row = ranked.find((r) => r.id === id) ?? null;
      return row === null || row.meters > COVERAGE_RADIUS_M ? null : row;
    },
    [ranked],
  );

  /**
   * The card the map is drawing, or `null`.
   *
   * **Where a tap is answered is where the tap was.** A dot tapped on the map
   * gets its card on the map, over the dot's own surroundings; a row tapped in
   * the list is already a card under the driver's finger and gets nothing new.
   * The version this replaces put the card for a tapped dot at the top of the
   * *list* instead, which the owner reported as the thing that makes no sense:
   * "when user clicks something [it] does appear on the list but still has to
   * scroll to see its detail". A card you have to go and find is not an answer
   * to a tap, and on a phone at `half` the sheet's body is 224 px against a
   * 255 px card, so finding it meant scrolling too.
   *
   * It is drawn for *every* dot, including one the list is already showing.
   * Restricting it to lots outside the list -- which is what `pinned` did --
   * rebuilds a smaller version of the same dead end: the twentieth row of a
   * scrolled list is exactly as far from the driver's finger as no row at all.
   * The row still highlights where it is, so the list keeps saying where the
   * lot ranks; the map says what it is.
   *
   * `fromMap` is what keeps that rule honest in one place. Without it the card
   * would also appear for a list tap, fighting the sheet for the same band of
   * screen -- and at `full` there is no band to fight over.
   */
  const mapCard = useMemo(
    () => (selected === null || !selected.fromMap ? null : cardRowFor(selected.id)),
    [selected, cardRowFor],
  );

  /**
   * Whether a tapped dot will be answered by the card above, asked at the
   * moment of the tap.
   *
   * `MapView` builds its popup inside a MapLibre event handler, which runs
   * before React has re-rendered anything -- so "is this dot carded?" cannot be
   * read off a prop without being one selection out of date, and a dot whose
   * card is about to open would flash a name-and-chance bubble first. A
   * predicate is the same question asked at the only moment it can be answered.
   */
  const hasCard = useCallback((id: string) => cardRowFor(id) !== null, [cardRowFor]);

  /** Dismiss the map card, and the selection it is about, together. */
  const dismissMapCard = useCallback(() => setSelected(null), []);

  /**
   * How much history stands behind each rendered card's arrival hour, by lot id.
   *
   * A map rather than a callback because `LotList` is memoised: a fresh closure
   * every render would defeat that memo on every mouse move across the list,
   * which is the exact cost the memo was added to avoid. Built over the rows
   * that actually render a card -- the head, the nearby tail once it is open,
   * plus the pinned lot when there is one -- and not the whole 1,075-lot
   * roster, because a card is the only thing that shows a confidence grade.
   *
   * The tail is in here **only while it is open**, which is the same bargain
   * the expander itself is: a closed tail draws no cards, so paying for up to
   * 156 `supportForLot` lookups to describe them would be work for nothing. It
   * has to be in here when it *is* open, though, for the reason the map card is
   * below -- a tail card left to the `?? 0` default would read "Low - thin"
   * beside a head card reading "High - 5 weeks" for the same arrival, which is
   * the list quietly knowing less about a lot the further down it sits.
   *
   * The map card's row belongs in here rather than being left to the `?? 0`
   * default: `0` is `confidence.ts`'s thinnest evidence ("not watched at this
   * time of week often enough yet"), so a map card missing from this map
   * would read "Low · thin" beside list cards reading "High · 5 weeks" for the
   * same arrival -- the card quietly *less* informative than the list's, which
   * is the one thing it was added not to be. A card for a lot the list is also
   * showing lands on the same key with the same value, so the duplicate costs
   * nothing and the gate stays one line.
   */
  const supportById = useMemo(() => {
    const carded = [
      ...listed.head,
      ...(nearbyOpen ? listed.nearby : []),
      ...(mapCard === null ? [] : [mapCard]),
    ];
    return new Map(carded.map((r) => [r.id, supportForLot(week, r.lot, arrivalTs)]));
  }, [listed, nearbyOpen, mapCard, week, arrivalTs]);

  /**
   * The destination is somewhere this app cannot answer for.
   *
   * Read off the *nearest* lot rather than the best-ranked one: `ranked` is
   * sorted by expected cost, so its first row is whichever car park won the
   * trade between probability, walk and price -- which at 290 km is a lottery
   * between a thousand equally hopeless candidates. Distance is the question
   * being asked, so distance is what gets minimised.
   *
   * An empty ranking lands here too, and truthfully: with no car park in the
   * roster, none is within `COVERAGE_RADIUS_M` of anywhere.
   */
  const outsideCoverage = useMemo(() => {
    if (destination === null || artifacts === null) return false;
    return ranked.every((row) => row.meters > COVERAGE_RADIUS_M);
  }, [artifacts, destination, ranked]);

  /**
   * The filters, as the *map* is allowed to act on them: only while the ranked
   * list they belong to is actually on screen. See `mapLots` below.
   */
  const listFilters = destination !== null && !outsideCoverage ? filters : EMPTY_FILTERS;

  /**
   * Moved below `ranked` and `outsideCoverage` for one reason, and it is the
   * `filteredOut` flag below: the dimming is a statement about a list, so it
   * has to know whether there is a list. **The dots themselves still wait for
   * nothing** -- every lot is projected here whatever the destination is, which
   * is the eighth point in the module comment and is not weakened by the move.
   */
  /**
   * Every lot the map draws, projected straight from the artifacts.
   *
   * Deliberately not derived from `ranked`: the ranking needs a destination and
   * this does not, so hanging the map off it drew an empty city until the user
   * happened to tap -- see the seventh point in the module comment. The list
   * ordering and the destination pin are all `ranked` is for.
   *
   * Recomputed when the arrival time moves: a new column out of a grid already
   * in memory, no request, no refetch, and a `setData` on one GeoJSON source at
   * the other end.
   */
  const mapLots = useMemo(() => {
    if (artifacts === null) return [];
    const { grid: g, lots } = artifacts;
    return lots.lots.map((lot) =>
      // Nothing we hold answers this arrival, and the dot goes grey -- the same
      // "no data" the map already draws for an unknown cell.
      toMapLot(
        lot,
        withheld ? null : probabilityForLot(g, week, lot, horizonFromReadingMin, arrivalTs),
        // **Every lot still gets a dot.** The filter dims the ones it took out
        // of the list; it never deletes them from the map. The map is the city
        // and the list is the recommendation, and a car park that vanished
        // from a map of car parks would be this project's own "silently absent
        // lot" failure, dressed up as a feature -- which is also exactly what
        // the owner's rule for this ("filter narrows, never hides silently")
        // rules out. So the flag says one thing and one thing only: *the list
        // you are looking at left this out*. It is not a claim about the car
        // park -- a lot that reported no scooter bays and a lot that said
        // nothing about them are both simply not in the list, and tapping
        // either still opens the full card, which then tells the truth about
        // that field per `AmenityTile`.
        //
        // Which is also why it is `listFilters` and not `filters`: with no
        // destination, or one the ranking has no answer for, there is no list
        // on screen for anything to have been left out of, and the chips that
        // would explain the dimming are not rendered either. A filter left on
        // from an earlier destination would otherwise fade half the city with
        // nothing on screen saying why, or how to stop it.
        exclusionFor(lot, listFilters) !== null,
      ),
    );
    // `withheld` rather than `nowSec`: a boolean that flips at most once as the
    // clock walks, so this does not re-project 1,075 lots on every tick.
  }, [artifacts, week, horizonFromReadingMin, arrivalTs, withheld, listFilters]);

  /**
   * Every probability on screen was read out of `week.bin` rather than out of
   * `grid.bin`, and the page says so.
   *
   * Gated on a probability having actually come back, not merely on the
   * arrival being far or the table being in hand: a line explaining where
   * "these chances" came from, over a screen where every cell reads "no data",
   * would be vouching for numbers that are not there. That is the same rule
   * the confidence pill follows one layer down -- no grade over an absent
   * number -- and it is why the check is `some`, off the projection the map is
   * already given, rather than `week !== null`: a table can be loaded, the
   * right roster, and still hold nothing for a bucket nobody has watched.
   *
   * Deliberately **not** gated on `forecastExpired`. What this states is the
   * *source* of the figure, which does not change when the collector resumes;
   * a label that appeared only during a stale period would flicker off while
   * the number under it stayed exactly the same climatology, and its absence
   * would then read as "this one is backed by a live reading". The routing in
   * `probabilityForLot` is per-arrival, not per-lot, so when this is true it
   * is true of every row.
   */
  const fromHistory = useMemo(
    () => needsWeek && mapLots.some((lot) => lot.probability !== null),
    [needsWeek, mapLots],
  );


  /**
   * The one lot the list crowns, and the only dot that pulses.
   *
   * The first row with a forecast, never simply the first row: `listRows` can
   * append a no-forecast lot the cap would have dropped, and a "best pick" star
   * over "no data" would be the ranking claiming something it does not know.
   * With the arrival withheld there is no pick to make at all, and the heading
   * above the list says the same thing one layer up.
   *
   * A car park whose feed has stopped is skipped too, even though it has a
   * number. Past the grid's window that number comes from `week.bin`, which
   * carries no liveness wrapper, so it is a real answer about what this lot
   * usually has free at this hour -- and we keep showing it. But a lot nobody
   * has heard from in thirty hours may be closed, and crowning it "Best pick"
   * (and pulsing its dot) is advice we cannot support. `rank.ts`'s `group`
   * demotes the same rows in the ordering for the same reason and argues it at
   * length; this is the badge half of that, and `notUpdating` is shared so the
   * two can never disagree about which lots they mean.
   *
   * Read off the head alone, and not off the head plus the nearby tail. That is
   * not a judgment call: `rankLots` sorts every row with a forecast above every
   * row without one, and the tail is the ranking continued past the head, so a
   * tail row can only carry a forecast if some head row already does. The two
   * spellings pick the same lot in every reachable state, and the shorter one
   * says what the badge means -- the crown belongs to the list, and cannot
   * appear on a row that is off screen until the driver opens the expander.
   */
  const bestId = withheld
    ? null
    : (listed.head.find((r) => r.probability !== null && !notUpdating(r.lot))?.id ?? null);

  /**
   * A lot was chosen, in the list or on the map. One path for both, so the
   * halo, the centred view and the card's selected state can never disagree
   * about which lot is current.
   *
   * `fromMap` is the one thing the two ends do not share, and it decides two
   * things: whether the card is drawn over the map (see `mapCard`), and which
   * way the sheet moves on a phone.
   */
  const selectLot = useCallback((id: string, fromMap = false) => {
    const lot = artifacts?.lots.lots.find((l) => l.id === id);
    // Whether this selection is about to put a card over the top of the map
    // band, which is the only reason the lot is not centred in the middle of
    // that band. See `mapCardDepthPx`.
    const carded = fromMap && cardRowFor(id) !== null;
    setSelected({ id, fromMap });
    // The nonce, not the coordinates, is what makes the map move: tapping the
    // same card twice is two requests, and the map must honour both. How far
    // below centre the lot has to land is not decided here -- the card whose
    // height decides it has not been drawn yet.
    if (lot) {
      setCenterPending((c) => ({
        lat: lot.y,
        lon: lot.x,
        carded,
        nonce: (c?.nonce ?? 0) + 1,
      }));
    }
    if (desktop) return;
    // A dot tapped on the map is answered on the map, and the card needs the
    // band the sheet is sitting in: at `half` the sheet leaves 305 px between
    // the top bar and its own top edge, and the card's slot alone is 288 of
    // them. So the sheet steps *down*, which is the opposite of what this did
    // when the answer was in the sheet -- and it is the same reason both
    // times. Only when there is a card to make room for: a dot outside
    // coverage is answered by the map's popup, and moving the list for a
    // popup would be a surprise with nothing behind it.
    if (fromMap) {
      if (carded) setSnap("peek");
      return;
    }
    // A row tapped in the list at `peek`: 53 px of body is a hint that there
    // is a list, not enough of one to read the card that was just tapped.
    if (snap === "peek") setSnap("half");
    // Stable across a hover-only render, which is what lets `LotList`'s memo
    // hold: a fresh closure here would defeat it on every mouse move.
  }, [artifacts, desktop, snap, cardRowFor]);

  /**
   * The pending move, once the card it has to clear can be measured.
   *
   * A layout effect and not an ordinary one: it runs in the same commit that
   * put the card in the document, before the browser has painted, so the ease
   * begins on the frame the tap did rather than one after it. Two renders,
   * still exactly one `easeTo` -- `MapView` keys the camera on the nonce
   * alone, and the nonce is carried through unchanged from the tap.
   *
   * `desktop` is a dependency because it moves the band's top edge (the side
   * panel pads the left, the top bar the top). A layout flip while a card is
   * open re-runs this with the same nonce, which recomputes the offset for the
   * next tap and moves nothing now.
   */
  useLayoutEffect(() => {
    if (centerPending === null) return;
    const { lat, lon, carded, nonce } = centerPending;
    const depth = carded ? mapCardDepthPx(mapCardRef.current, desktop ? 0 : TOP_BAR_PX) : 0;
    setCenterRequest({ lat, lon, offsetY: depth / 2, nonce });
  }, [centerPending, desktop]);

  /**
   * The same selection, made by a tap on a dot.
   *
   * `MapView`'s `onSelectLot` is `(id) => void` on purpose -- the map reports a
   * lot, it does not know or care what the app does about it -- so the source
   * of the tap is bound here rather than becoming a second argument the map
   * would have to be trusted to pass.
   */
  const selectLotOnMap = useCallback((id: string) => selectLot(id, true), [selectLot]);

  /**
   * A place chosen by name. Straight into the one destination path a map tap
   * uses -- a search result is a deliberate answer to "where are you going",
   * exactly as a tap is, so it abandons a location request still in flight for
   * free. A car park is also a *lot*, so it is selected as well as arrived at:
   * the driver named the place they intend to park in.
   */
  function onPlace(place: Place) {
    pickDestination({ lat: place.lat, lon: place.lon });
    if (place.kind === "carpark" && place.lotId !== undefined) selectLot(place.lotId);
  }

  /**
   * What the sheet or the panel covers, in pixels. MapLibre centres on the
   * middle of the *unpadded* canvas, so without this a lot the driver just
   * tapped arrives underneath the sheet that is showing it.
   *
   * The map card is deliberately *not* in here -- see `mapCardDepthPx`, half of
   * whose answer is spent on the centre request's offset instead. This stays what
   * it has always been: the chrome that is always there.
   */
  const snaps = snapHeights(viewportHeight, TOP_BAR_PX);
  const sheetHeight = snaps[snap];
  const padding = desktop
    ? { left: PANEL_PX, top: 0, right: 0, bottom: 0 }
    : { left: 0, top: TOP_BAR_PX, right: 0, bottom: sheetHeight };

  // Built once and placed twice: the phone puts the search in the top bar and
  // the buttons beside it, the desktop puts the search in the panel header and
  // floats the buttons over the map. Same elements, same state, two positions.
  const search =
    artifacts !== null ? (
      <PlaceSearch
        lots={artifacts.lots.lots}
        indexUrl={PLACES_URL}
        onSelect={onPlace}
        lang={lang}
      />
    ) : null;
  const locate = <LocateButton geo={geo} onClick={request} lang={lang} />;
  const langToggle = <LangToggle lang={lang} onChange={setLang} />;

  /**
   * Whether the sheet header has room for the preference row -- everywhere
   * except the phone's `peek`.
   *
   * `peek` is the glance state: `sheet.ts` calls it "just the search bar and a
   * hint of the list", and derives it from the viewport so that "a short phone
   * in landscape still gets a usable peek instead of a sheet that swallows the
   * map". The arithmetic is unforgiving. The grip is 44 px and the rest of this
   * header is 178, which left about 64 px of list at `peek` -- the hint. A
   * fourth row takes the header to 232 and the body to 8-12 px, which is a hint
   * of nothing; at 375x812 it fits exactly, and at 375x667 and on notched
   * phones (where `--safe-bottom` is padding inside the sheet's own height) the
   * row falls off the bottom of the screen.
   *
   * The two obvious fixes both defeat something. Growing `peek` to fit spends
   * the map's share, which is the one thing that constant exists to protect.
   * Moving the row into the body puts an "what am I asking for" control on the
   * "here is what we found" side of a line this app draws deliberately -- it
   * belongs beside the arrival picker, which is where it is.
   *
   * So the row keeps its place and skips the one state with no room for it. The
   * cost is real and accepted: at `peek` a driver cannot see which preference
   * is in force. `peek` is a glance at the map, and changing what you are
   * asking for is a deliberate act that can fairly require opening the sheet.
   * **Not** compensated for by naming the preference in the list heading --
   * that would re-spend the pixels this saves, and put a lean into the one line
   * whose job is saying whether a forecast stands behind the order at all.
   *
   * Rendered rather than hidden in CSS, so at `peek` the control is absent from
   * the accessibility tree as well as from the layout -- and so the header's
   * budget can be asserted against `snapHeights` from the rows actually in it.
   * See `tests/preferencePicker.test.tsx`, which pins the geometry at 375x667,
   * 375x812 and 390x844 rather than pinning which component rendered.
   */
  const roomForPreference = desktop || snap !== "peek";

  const header = (
    <>
      <div className="head-row">
        <h1 className="app-name">{s.appName}</h1>
        {/* Always on screen, on both layouts: the age of the reading is the
            one number this app may never quietly drop. */}
        <FreshnessBadge ageMin={ageMin} expired={forecastExpired} lang={lang} />
      </div>
      {desktop && search}
      {/* The two halves of "what am I asking for", in the order a driver asks
          them: when I get there, and what I would rather trade. Both sit in the
          header, above the list, because the list is the answer to them --
          which is also why they share the arrival picker's own guard. With no
          forecast in hand there is nothing to rank and nothing to lean.
          The second one also waits for the sheet to be open past `peek`, which
          is a question of pixels rather than of meaning -- see
          `roomForPreference`. */}
      {grid !== null && (
        <>
          <ArrivalPicker
            value={arrivalTs}
            nowSec={nowSec}
            onChange={setArrivalTs}
            lang={lang}
          />
          {roomForPreference && (
            <PreferencePicker value={preference} onChange={choosePreference} lang={lang} />
          )}
        </>
      )}
      {/* The locate button is an icon, so its state has to be said somewhere a
          screen reader will announce it. The visible copy is the notice below. */}
      <p className="status visually-hidden" role="status">
        {geo === "unavailable" ? s.locationUnavailable : ""}
      </p>
    </>
  );

  const map = loadFailed ? null : (
    // The boundary is around the map alone, so only the map waits for the
    // map's chunk: everything else -- the list, the freshness badge, the
    // expiry notice -- renders on the first paint either way.
    <Suspense fallback={<MapPlaceholder lang={lang} />}>
      {/* Every lot in the roster, never `listed` and never `ranked`: the list
          is capped at 20 rows, the ranking waits for a destination, and the map
          is the city either way. `mapLots` is computed above this boundary, so
          the roster is ready before the chunk is and the map is never mounted
          empty. */}
      <MapView
        lots={mapLots}
        destination={destination}
        onPick={pickDestination}
        lang={lang}
        selectedId={selectedLotId}
        bestId={bestId}
        hoverId={hoverLotId}
        onSelectLot={selectLotOnMap}
        hasCard={hasCard}
        centerRequest={centerRequest}
        padding={padding}
      />
    </Suspense>
  );

  return (
    <Shell
      map={map}
      topBar={<TopBar search={search} locate={locate} lang={langToggle} />}
      floatControls={
        <>
          {locate}
          {langToggle}
        </>
      }
      header={header}
      snap={snap}
      onSnapChange={setSnap}
      lang={lang}
      overlay={
        <>
          {artifacts !== null && destination === null && (
            <p className="map-hint glass anim-slide-down">{s.startPromptMap}</p>
          )}
          {/* The card for the car park the driver tapped, drawn *on the map*.
              It sits in the overlay slot rather than in the sheet or the panel
              because that is the whole of the change: a tap on a dot is
              answered over the dot's own surroundings, not in the surface the
              ranked list lives in. `padding` above has already told MapLibre
              that this band is covered, so the dot the card is about is
              centred below it rather than under it.

              `best` is compared against `bestId` rather than hard-wired: the
              card is now drawn for listed lots too, and the lot the ranking
              crowned is allowed to wear its crown here. Every other lot is
              `false` by the same comparison -- `bestId` only ever names a row
              in `listed` with a forecast and a live feed (see `bestId`), so a
              lot the ranking could not vouch for cannot match it, and a car
              park the cap never reached cannot either.

              The hint above and this are mutually exclusive by construction:
              the hint needs no destination, and `mapCard` needs one. */}
          {artifacts !== null && mapCard !== null && (
            <section
              className="map-card"
              data-testid="map-card"
              aria-label={s.selectedCarPark}
              ref={mapCardRef}
              // Where the sheet rests while a card is open -- opening one
              // steps the sheet down to `peek` -- so `.map-card`'s own
              // `max-height` can be written against the band the card and its
              // dot have to share. From `snapHeights`, which is the one place
              // that knows how tall a peeking sheet is; a second copy of that
              // arithmetic in CSS would be the drift this whole change is
              // about, one layer over.
              style={{ "--sheet-peek": `${snaps.peek}px` } as CSSProperties}
            >
              <button
                type="button"
                className="map-card__dismiss"
                aria-label={s.dismissCard}
                onClick={dismissMapCard}
              >
                <Cross />
              </button>
              {/* A list of one, because `LotCard` is an `<li>` and an `<li>`
                  with no list around it is invalid markup. Unordered: one card
                  has no order to announce, and `.lots` is only carrying the
                  card's own spacing here. */}
              <ul className="lots">
                <LotCard
                  // Keyed by lot, exactly as `LotList` keys its rows: without
                  // it React reuses one card across two car parks, and
                  // `ProbabilityRing`'s tween animates the first lot's
                  // percentage into the second's -- a number that belongs to
                  // neither of them while it is on screen.
                  key={mapCard.id}
                  row={mapCard}
                  lang={lang}
                  baseDataTs={artifacts.grid.baseDataTs}
                  ageMin={ageMin ?? 0}
                  horizonFromReadingMin={horizonFromReadingMin}
                  support={supportById.get(mapCard.id) ?? 0}
                  fromHistory={fromHistory}
                  best={mapCard.id === bestId}
                  selected
                  // Tapping the card itself re-centres the map on its lot and
                  // keeps the card: routing this through the list's own
                  // `selectLot` would clear `fromMap` and close the card the
                  // tap landed on.
                  onSelect={selectLotOnMap}
                  onHover={setHoverLotId}
                  index={0}
                />
              </ul>
            </section>
          )}
        </>
      }
    >
      {loadFailed && (
        <Notice tone="error" role="alert">
          {s.loadFailed}{" "}
          <button
            type="button"
            onClick={() => {
              // Clearing the failure here, in the event that caused it, rather
              // than in the fetch effect: the effect exists to talk to the
              // network, not to re-render the page it just rendered.
              setLoadFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            {s.retry}
          </button>
        </Notice>
      )}
      {!loadFailed && artifacts === null && (
        <>
          {/* The cards are `aria-hidden` shimmer, so the state has to be said
              in words as well -- a screen reader gets silence otherwise. */}
          <p className="visually-hidden" role="status">
            {s.loading}
          </p>
          <Skeleton />
        </>
      )}
      {geo === "unavailable" && (
        <Notice tone="warn" testId="geo-unavailable">
          {s.locationUnavailable}
        </Notice>
      )}
      {/* Until climatology answers, the reading is the only source there was
          and it has expired -- which stays the true explanation for an empty
          cell whether the arrival is near (nothing could answer it) or far
          with the table still in flight, refused or 503. The two are mutually
          exclusive by construction, so the page never carries both. */}
      {forecastExpired && !fromHistory && (
        <Notice tone="warn" testId="forecast-expired" role="status">
          {s.forecastTooOld}
        </Notice>
      )}
      {/* The freshness badge dates the *reading*; nothing else on the page
          dates the number. Out here they are not the same thing, and this is
          the line that says which one the percentages belong to. */}
      {fromHistory && (
        <Notice tone="info" testId="from-history" role="status">
          {s.basedOnHistory}
        </Notice>
      )}
      {/* No heading above this one: "Ranked for your arrival" over an
          explanation that nothing here is worth ranking would be the same false
          claim the expiry heading exists to avoid. */}
      {outsideCoverage && (
        <Notice tone="warn" testId="outside-coverage" role="status">
          {fillTemplate(s.outsideCoverage, { km: COVERAGE_RADIUS_M / 1000 })}
        </Notice>
      )}
      {artifacts !== null && destination !== null && !outsideCoverage && (
        <>
          {/* The heading follows what the order actually means: with no forecast
              behind it, the list is sorted by walk and price, and claiming it is
              "ranked for your arrival" would be the same lie one layer up. A
              week-sourced probability *is* a forecast for the chosen arrival,
              and the ranking really was computed from it, so the same test
              governs both -- the heading and the sentence above it can never
              disagree about whether anything was ranked.

              **It does not name the preference, now that the ordering has a
              second input.** The two say different things: this heading is the
              honesty guard over whether a *forecast* stands behind the order at
              all (against `nearbyCarParks`, which is what the list is when the
              reading has expired), while the preference is a lean, and the
              control naming it is a few lines above in the same surface. Adding
              it here would put the same word in two places, need a variant for
              each branch, and blunt the one distinction the heading exists to
              draw. */}
          <h2 className="list-head">
            {forecastExpired && !fromHistory ? s.nearbyCarParks : s.rankedForArrival}
          </h2>
          <AmenityFilters active={filters} available={availableFilters} onToggle={toggleFilter} lang={lang} />
          {/* "Filter narrows, never hides silently." A shorter list with no
              explanation reads as a city with nothing in it, so what the
              filter removed is reported here -- as two counts, because a car
              park that reported none and one that reported nothing are
              different facts and only the first is a reason to stop looking.
              Each line appears only when its own count is non-zero, so a
              filter that hid nothing says nothing.

              Both templates come in a singular and a plural, chosen on the
              count the way `ConfidencePill` chooses between
              `confidenceWeekTemplate` and `confidenceWeeksTemplate`; zh's two
              are the same text, so the branch is a no-op there. "1 car parks
              are hidden" is common on the unknown line especially. */}
          {(listed.head.length === 0 || hidden.none > 0 || hidden.unknown > 0) && filters.length > 0 && (
            <Notice tone="info" testId="filter-hidden" role="status">
              {listed.head.length === 0 && <>{s.filterNoMatch} </>}
              {hidden.none > 0 && (
                <span data-testid="filter-hidden-none">
                  {fillTemplate(
                    hidden.none === 1 ? s.filterHiddenNoneOneTemplate : s.filterHiddenNoneTemplate,
                    { n: hidden.none },
                  )}{" "}
                </span>
              )}
              {hidden.unknown > 0 && (
                <span data-testid="filter-hidden-unknown">
                  {fillTemplate(
                    hidden.unknown === 1 ? s.filterHiddenUnknownOneTemplate : s.filterHiddenUnknownTemplate,
                    { n: hidden.unknown },
                  )}
                </span>
              )}
            </Notice>
          )}
          <LotList
            rows={listed.head}
            lang={lang}
            baseDataTs={artifacts.grid.baseDataTs}
            ageMin={ageMin ?? 0}
            horizonFromReadingMin={horizonFromReadingMin}
            supportById={supportById}
            fromHistory={fromHistory}
            bestId={bestId}
            selectedId={selectedLotId}
            onSelect={selectLot}
            onHover={setHoverLotId}
          />
          {/* The car park the owner could see on the map and could not open.
              The cap picks twenty rows by expected *cost*, so a lot two streets
              away and visibly free loses that race on price alone and simply is
              not there -- "I always see lots around that's green but didn't see
              it in the list if I'd like to know the detail about it."

              **In the body, under the list, and never in the header.** The
              header is the "what am I asking for" surface and has 13 px of
              slack at 375x667 (see `roomForPreference` and
              `tests/preferencePicker.test.tsx`); this is part of the answer,
              not part of the question, and it costs that budget nothing.

              Between the two lists rather than below both, which is a decision
              about the finger that opened it: expanded, the control stays where
              it was tapped, so collapsing 140 rows is a scroll back to a known
              place instead of a hunt past the bottom of them.

              The APG disclosure pattern: `aria-expanded` on the button and the
              revealed list immediately after it, with no `aria-controls` --
              which would have to name an id that does not exist while the tail
              is closed, and the tail is closed precisely so that nothing of it
              is built. */}
          {listed.nearby.length > 0 && (
            <>
              <button
                type="button"
                className="nearby-toggle"
                aria-expanded={nearbyOpen}
                data-testid="nearby-toggle"
                onClick={() => setNearbyOpen((open) => !open)}
              >
                {nearbyOpen
                  ? s.nearbyFewer
                  : fillTemplate(
                      listed.nearby.length === 1 ? s.nearbyMoreOneTemplate : s.nearbyMoreTemplate,
                      { n: listed.nearby.length },
                    )}
              </button>
              {/* Rendered only when open, which is the entire point: the tail
                  runs to 156 rows at a dense Taipei destination, and a phone
                  pays for what the driver opened and nothing else. Hiding it in
                  CSS instead would lay every one of those cards out anyway, and
                  leave a screen reader walking through a list the page says is
                  collapsed. */}
              {nearbyOpen && (
                <LotList
                  rows={listed.nearby}
                  lang={lang}
                  label={s.nearbyListLabel}
                  testId="nearby-list"
                  baseDataTs={artifacts.grid.baseDataTs}
                  ageMin={ageMin ?? 0}
                  horizonFromReadingMin={horizonFromReadingMin}
                  supportById={supportById}
                  fromHistory={fromHistory}
                  bestId={bestId}
                  selectedId={selectedLotId}
                  onSelect={selectLot}
                  onHover={setHoverLotId}
                />
              )}
            </>
          )}
        </>
      )}
    </Shell>
  );
}
