/**
 * The screen. One page: where you are, when you arrive, and what to do about it.
 *
 * The whole app is client-side. Two static files are fetched once, the ranking
 * runs in this component, and nothing is ever sent anywhere -- the driver's
 * location never leaves the phone, because there is no server to send it to.
 *
 * Eight things here are load-bearing rather than cosmetic:
 *
 *   - **The staleness line.** The upstream feed publishes every five minutes
 *     with a ~3-minute lag, so the reading behind any forecast is already a few
 *     minutes old. Saying so, from the grid's own `baseDataTs`, is the honest
 *     version of the "live" badge every other parking app wears -- and it is
 *     this project's entire thesis in one line of text.
 *   - **The staleness *correction*.** Saying it is not enough: the grid's
 *     horizons are measured from `baseDataTs`, so reading column "15 min" for a
 *     driver arriving in 15 minutes answers for 15 minutes after a reading that
 *     already happened. `gridHorizonMin` adds the age back, which is the whole
 *     reason a nowcast is a model rather than a lookup. See `ageMin` below.
 *   - **The staleness *limit*.** The correction above has an end. Once even the
 *     nearest arrival time clamps to the last column, every later one does too
 *     and the forecast is no longer about the time the user asked for;
 *     `forecastExpired` says so and withholds the probability rather than
 *     dressing a clamp up as an answer. The rest of the page keeps working.
 *   - **Geolocation never leaves the user on a spinner.** Denial, failure, a
 *     browser without the API and a permission prompt closed without an answer
 *     all land in the same visible end state, with the rest of the page still
 *     working.
 *   - **`baseDataTs` and `generatedAt` stay distinct.** The age shown is the age
 *     of the *reading*, not of the file we wrote from it.
 *   - **The destination is an input, not a measurement.** Geolocation answers
 *     "where am I", which is the wrong question for a driver on their way
 *     somewhere else; a tap on the map answers the right one. Both feed the same
 *     single `destination`, and a tap wins over a location still in flight.
 *   - **The map does not wait for the destination.** Nothing a dot needs -- id,
 *     name, district, position, probability -- comes from where the driver is
 *     going, so all 1,088 draw on first paint and only the *ranking* waits.
 *     Feeding the map the ranked array instead, as this did, left the whole
 *     city invisible until the user happened to tap: the project's own
 *     "silently absent lot" failure, at 1,088 out of 1,088.
 *   - **The list does not wait for the map.** MapLibre and its stylesheet are
 *     333 KB gzipped -- more than the rest of the app together -- and a static
 *     import made the ranked list, the thing that answers the user's question,
 *     wait for the picture that illustrates it. `MapView` is loaded lazily
 *     instead, behind a placeholder that reserves the map's exact height so the
 *     list does not jump down the page when the chunk lands. `mapLots` is still
 *     computed here, above the boundary, so the map is full the moment it
 *     mounts -- the previous point is not weakened by this one.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { artifactsBase, horizonColumn, loadArtifacts, probabilityAt } from "./artifacts";
import { LotList } from "./components/LotList";
import { LangToggle } from "./components/LangToggle";
import { Scrubber } from "./components/Scrubber";
import type { LatLon } from "./geo";
import { detectLang, fillTemplate, t, type Lang } from "./i18n";
import { toMapLot } from "./map/lotSource";
import { listRows, rankLots } from "./rank";
import type { Grid, Lot, LotsDoc } from "./types";

/**
 * The map, and everything it drags in: MapLibre, pmtiles, the Protomaps theme
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
 * How many ranked lots the *list* renders. A driver picks from the first
 * handful; past that the list is scroll for its own sake, and every extra row
 * is DOM work on a phone.
 *
 * This is a limit on the list and on nothing else. The map draws every lot in
 * the roster and never goes through the ranking at all: slicing it there would
 * silently hide 98% of the city behind a map that looked like it was showing
 * all of it.
 *
 * It is also a *soft* limit: `listRows` grows the list rather than let a fixed
 * cap drop the no-forecast lots the ranker deliberately kept.
 */
export const LIST_LIMIT = 20;

/** Minutes ahead the list opens on: long enough to matter, short enough to be a real trip. */
const DEFAULT_HORIZON_MIN = 15;

/** How often the staleness line re-reads the clock. */
const CLOCK_TICK_MS = 30_000;

/**
 * How often the artifacts are refetched.
 *
 * The horizon offset is only bounded if the age is: a tab left open answers for
 * an ever-older reading otherwise, and the far end of the horizon control drifts
 * into the past. Two minutes is well inside the feed's five-minute cadence and
 * costs almost nothing -- `rosterId` pairing means a routine refetch revalidates
 * the cached 186 KB `lots.json` and downloads only the 26 KB grid.
 */
export const REFRESH_MS = 120_000;

/** Passed to the Geolocation API, which starts it only after the permission decision. */
const GEO_TIMEOUT_MS = 10_000;

/**
 * Our own deadline on a location request, covering the case the API's `timeout`
 * does not: a permission prompt dismissed without an answer. The spec starts
 * `timeout` only once permission is decided, so a prompt the user closes (or
 * that the browser closes for them -- Firefox and several Android WebViews do)
 * fires neither callback, and the button would stay disabled until reload.
 */
export const GEO_WATCHDOG_MS = 12_000;

/** Geolocation is a permission prompt, so it is a state machine, not a value. */
type GeoState = "idle" | "locating" | "ready" | "unavailable";

interface Artifacts {
  grid: Grid;
  lots: LotsDoc;
}

/**
 * P(at least one space) for one lot at one arrival time.
 *
 * Read at the row the lot *declares*, never at its position in the array:
 * `fetchLots` drops a row it cannot place, and reading by position after that
 * hands every later lot its neighbour's forecast -- a silent, plausible-looking
 * wrong answer for most of the city. Both readers, the ranking and the map, go
 * through here, so the two cannot disagree about which row belongs to which car
 * park.
 *
 * Guarded rather than raw: a roster longer than the grid would otherwise throw
 * mid-render and take the whole page down, when "no data" for the extra rows is
 * both true and survivable.
 */
function probabilityForLot(grid: Grid, lot: Lot | undefined, horizonMin: number): number | null {
  const row = lot?.i;
  return row === undefined || row >= grid.nLots ? null : probabilityAt(grid, row, horizonMin);
}

/**
 * What stands where the map will be while its chunk is still downloading.
 *
 * Two things make this a placeholder rather than a gap:
 *
 *   - It **reserves the map's height** (`.map-placeholder` and `.map-canvas`
 *     share one `--map-height`), so the list sits where it will still be
 *     sitting a moment later. A collapsing fallback would shove the whole list
 *     down the page the instant the chunk landed -- a worse bug than the slow
 *     first paint this split exists to fix.
 *   - It reads as **loading, not broken**. Nothing has failed here: the answer
 *     is already on screen and the illustration is on its way. `role="status"`
 *     rather than `role="alert"` says the same thing to a screen reader, and
 *     `mapUnavailable` remains the string for the case that really did fail.
 */
function MapPlaceholder({ lang }: { lang: Lang }) {
  return (
    <div className="map">
      <p className="map-placeholder" role="status" data-testid="map-loading">
        {t(lang).mapLoading}
      </p>
    </div>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [artifacts, setArtifacts] = useState<Artifacts | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [destination, setDestination] = useState<LatLon | null>(null);
  const [geo, setGeo] = useState<GeoState>("idle");
  const [horizonMin, setHorizonMin] = useState(DEFAULT_HORIZON_MIN);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const s = t(lang);

  // Whether a grid has ever landed, read from inside the fetch effect -- state
  // would make the effect re-run on the load it just did.
  const loadedRef = useRef(false);
  const geoWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Abandons an in-flight location request. Held in a ref because the thing
   * that abandons it -- a tap on the map -- happens in a later render than the
   * one that started it, and a location arriving afterwards must not overwrite
   * the destination the user just chose by hand.
   */
  const abandonGeoRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadArtifacts(ARTIFACTS_BASE).then(
      (loaded) => {
        if (cancelled) return;
        loadedRef.current = true;
        setArtifacts(loaded);
        setLoadFailed(false);
      },
      () => {
        // A failed *refresh* must not replace a working screen with an error:
        // the grid we hold is older than we wanted, not missing, and the
        // staleness line already says so.
        if (!cancelled && !loadedRef.current) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, refresh]);

  // The staleness line is only honest if it keeps counting.
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
      // Coming back is the moment the age is largest and the user is looking.
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // A location request outlives the render that started it; nothing should
  // outlive the component.
  useEffect(
    () => () => {
      if (geoWatchdogRef.current !== null) clearTimeout(geoWatchdogRef.current);
    },
    [],
  );

  // The page's own language, for assistive tech, font fallback and line
  // breaking. `index.html` can only ship one guess; this is the real answer.
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-Hant" : "en";
  }, [lang]);

  const grid = artifacts?.grid ?? null;

  /**
   * Whole minutes since the *reading*, not since the file was written.
   *
   * Shown in the staleness line and added to every horizon: those are two uses
   * of one number, and they must not drift apart.
   */
  const ageMin =
    grid === null ? null : Math.max(0, Math.round((nowMs / 1000 - grid.baseDataTs) / 60));

  /**
   * The horizon snapped to a column the grid actually has, so the number under
   * the control and the number the user picked are the same number.
   */
  const activeHorizon = grid ? (horizonColumn(grid, horizonMin) + 1) * grid.stepMin : horizonMin;

  /**
   * The horizon actually read out of the grid: the user's arrival time measured
   * from `baseDataTs` instead of from now.
   *
   * `grid.py` evaluates column `c` at `baseDataTs + (c + 1) * stepMin`, so a
   * grid five minutes old answers "in 15 min" with a forecast for now + 10.
   * Adding the age back is the staleness correction the design spec calls the
   * nowcast's whole job.
   *
   * At the far end this can run off the grid, and `probabilityAt` clamps to the
   * last column. That is the right trade: a few minutes short at +120 min is a
   * far smaller lie than being minutes wrong at +5, and dropping the option
   * would take real arrival times off the control to flatter the model.
   *
   * It stops being a trade once the *age alone* runs off the grid -- see
   * `forecastExpired`.
   */
  const gridHorizonMin = activeHorizon + (ageMin ?? 0);

  /**
   * The reading is old enough that no arrival time the user can pick is still
   * answerable, so there is no forecast left.
   *
   * The test is the *nearest* arrival time: once even `stepMin` from now lands
   * on the last column, every later one clamps to it too, the scrubber does
   * nothing, and all 24 of its positions show one identical answer for a time
   * nobody asked for. Observed with a 383-minute-old artifact, and certain to
   * recur -- the collector stops whenever the machine it runs on sleeps, while
   * the published copy stays up and goes on ageing.
   *
   * Comparing the age against the grid's whole span (`stepMin * nHorizons`,
   * 120 as built) is the obvious version of this and trips one window late: at
   * the shipped geometry the scrubber goes inert at an age of 113 minutes --
   * `round((5 + 113) / 5) - 1` is already column 23 -- while `age > 120` waits
   * until 121. For those eight minutes the slider was live, the heading claimed
   * an order, and all 24 positions rendered the same clamped column.
   *
   * The clamp is right; presenting its output as an answer is not. So the
   * probability is dropped at its source below: one `null` per lot, which puts
   * every row on the "no data" path the UI already has for a missing cell and
   * the map on the grey it already has for an unknown one. Names, distances and
   * prices never came from the grid and are untouched -- it is the forecast that
   * expired, not the page.
   */
  const forecastExpired =
    grid !== null &&
    ageMin !== null &&
    horizonColumn(grid, grid.stepMin + ageMin) === grid.nHorizons - 1;

  /**
   * Every lot the map draws, projected straight from the artifacts.
   *
   * Deliberately not derived from `ranked`: the ranking needs a destination and
   * this does not, so hanging the map off it drew an empty city until the user
   * happened to tap -- see the seventh point in the module comment. The list
   * ordering and the destination pin are all `ranked` is for.
   *
   * Recomputed when the arrival time moves, which is the whole scrub: a new
   * column out of a grid already in memory, no request, no refetch, and a
   * `setData` on one GeoJSON source at the other end.
   */
  const mapLots = useMemo(() => {
    if (artifacts === null) return [];
    const { grid: g, lots } = artifacts;
    return lots.lots.map((lot) =>
      // No forecast survives an artifact this stale, and the dot goes grey --
      // the same "no data" the map already draws for an unknown cell.
      toMapLot(lot, forecastExpired ? null : probabilityForLot(g, lot, gridHorizonMin)),
    );
  }, [artifacts, gridHorizonMin, forecastExpired]);

  /**
   * Every lot, ranked. Not sliced: `listRows` decides what the list shows.
   *
   * Recomputed when the arrival time moves, which is the whole scrub: a new
   * column out of a grid already in memory, no request, no refetch.
   */
  const ranked = useMemo(() => {
    if (artifacts === null || destination === null) return [];
    const { grid: g, lots } = artifacts;
    const rows = lots.lots;
    return rankLots({
      destination,
      horizonMin: gridHorizonMin,
      lots: rows,
      // `rows[i]`, resolved through `Lot.i` inside: `rankLots` reports the array
      // position it scored, and the grid row is the lot's own business.
      probability: (i, h) => (forecastExpired ? null : probabilityForLot(g, rows[i], h)),
    });
  }, [artifacts, destination, gridHorizonMin, forecastExpired]);

  /**
   * What the list draws: the head of the ranking, grown if the cap would
   * otherwise drop a nearby lot the ranker kept on purpose. See `listRows`.
   */
  const listed = useMemo(() => listRows(ranked, LIST_LIMIT), [ranked]);

  function requestLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeo("unavailable");
      return;
    }
    setGeo("locating");

    // Whichever of the three finishes first wins, once: the success callback,
    // the error callback, or the watchdog that covers the prompt that answers
    // neither. Without the third, "定位中…" is a permanent state.
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (geoWatchdogRef.current !== null) clearTimeout(geoWatchdogRef.current);
      geoWatchdogRef.current = null;
      abandonGeoRef.current = null;
      finish();
    };
    geoWatchdogRef.current = setTimeout(() => settle(() => setGeo("unavailable")), GEO_WATCHDOG_MS);
    // A fourth way to finish: the user answered the question themselves.
    abandonGeoRef.current = () => settle(() => setGeo("idle"));

    try {
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          settle(() => {
            setDestination({ lat: pos.coords.latitude, lon: pos.coords.longitude });
            setGeo("ready");
          }),
        // Denied, timed out, or position unavailable: one visible end state.
        () => settle(() => setGeo("unavailable")),
        { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 60_000 },
      );
    } catch {
      settle(() => setGeo("unavailable"));
    }
  }

  /**
   * A tap on the map. This is what the map is *for*: geolocation answers "where
   * am I", and Plan 3b shipped with nothing else, so a driver heading somewhere
   * they were not standing had no way to say where.
   */
  function pickDestination(at: LatLon) {
    // Whatever the pending location request was about to say, it is answering a
    // question the user has now answered better -- and a position that landed a
    // second later would silently move the destination off the tapped point.
    abandonGeoRef.current?.();
    // A failure the user has routed around is no longer worth reporting.
    if (geo === "unavailable") setGeo("idle");
    setDestination(at);
  }

  return (
    <div className="app">
      <header className="app-head">
        <h1>{s.appName}</h1>
        <LangToggle lang={lang} onChange={setLang} />
      </header>

      <div className="controls">
        <button
          type="button"
          className="locate"
          onClick={requestLocation}
          disabled={geo === "locating"}
          aria-busy={geo === "locating"}
        >
          {geo === "locating" ? s.locating : s.useMyLocation}
        </button>

        {grid !== null && (
          <Scrubber
            value={activeHorizon}
            stepMin={grid.stepMin}
            count={grid.nHorizons}
            // Straight into the horizon state: the arrival time the user picked
            // is stored as they picked it, and `gridHorizonMin` above is the one
            // place the artifact's age is ever added to it.
            onChange={setHorizonMin}
            // A control that cannot change the answer should not look as though
            // it could: past the grid's span every position reads the same
            // clamped column, which is the silent no-op this whole state exists
            // to make visible.
            disabled={forecastExpired}
            lang={lang}
          />
        )}
      </div>

      <p className="status" role="status">
        {geo === "unavailable" ? s.locationUnavailable : ""}
      </p>

      {ageMin !== null && (
        <p className="staleness" data-testid="staleness">
          {fillTemplate(s.stalenessTemplate, { n: ageMin })}
        </p>
      )}

      <main>
        {loadFailed && (
          <p className="notice" role="alert">
            {s.loadFailed}{" "}
            <button
              type="button"
              onClick={() => {
                // Clearing the failure here, in the event that caused it,
                // rather than in the fetch effect: the effect exists to talk to
                // the network, not to re-render the page it just rendered.
                setLoadFailed(false);
                setAttempt((n) => n + 1);
              }}
            >
              {s.retry}
            </button>
          </p>
        )}
        {!loadFailed && (
          // The boundary is around the map alone, so only the map waits for the
          // map's chunk: everything below -- the list, the staleness line, the
          // expiry notice -- renders on the first paint either way.
          <Suspense fallback={<MapPlaceholder lang={lang} />}>
            {/* Every lot in the roster, never `listed` and never `ranked`: the
                list is capped at 20 rows, the ranking waits for a destination,
                and the map is the city either way. `mapLots` is computed above
                this boundary, so the roster is ready before the chunk is and
                the map is never mounted empty. */}
            <MapView lots={mapLots} destination={destination} onPick={pickDestination} lang={lang} />
          </Suspense>
        )}
        {!loadFailed && artifacts === null && <p className="notice">{s.loading}</p>}
        {forecastExpired && (
          <p className="notice notice-stale" data-testid="forecast-expired" role="status">
            {s.forecastTooOld}
          </p>
        )}
        {artifacts !== null && destination === null && <p className="notice">{s.startPrompt}</p>}
        {artifacts !== null && destination !== null && (
          <>
            {/* The heading follows what the order actually means: with no
                forecast behind it, the list is sorted by walk and price, and
                claiming it is "ranked for your arrival" would be the same lie
                one layer up. */}
            <h2 className="list-head">
              {forecastExpired ? s.nearbyCarParks : s.rankedForArrival}
            </h2>
            {listed.length === 0 ? (
              // A bare heading over nothing reads as a bug. Say what happened.
              <p className="notice" data-testid="no-lots">
                {s.noLotsNearby}
              </p>
            ) : (
              <LotList rows={listed} lang={lang} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
