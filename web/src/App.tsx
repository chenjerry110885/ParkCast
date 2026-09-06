/**
 * The screen. One page: where you are, when you arrive, and what to do about it.
 *
 * The whole app is client-side. Two static files are fetched once, the ranking
 * runs in this component, and nothing is ever sent anywhere -- the driver's
 * location never leaves the phone, because there is no server to send it to.
 *
 * Four things here are load-bearing rather than cosmetic:
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
 *   - **Geolocation never leaves the user on a spinner.** Denial, failure, a
 *     browser without the API and a permission prompt closed without an answer
 *     all land in the same visible end state, with the rest of the page still
 *     working.
 *   - **`baseDataTs` and `generatedAt` stay distinct.** The age shown is the age
 *     of the *reading*, not of the file we wrote from it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { horizonColumn, loadArtifacts, probabilityAt } from "./artifacts";
import { LotList } from "./components/LotList";
import { LangToggle } from "./components/LangToggle";
import type { LatLon } from "./geo";
import { detectLang, fillTemplate, t, type Lang } from "./i18n";
import { rankLots } from "./rank";
import type { Grid, LotsDoc } from "./types";

/**
 * Where the two artifacts live. Relative to the deployment root so the app
 * works under a sub-path (GitHub Pages) without a rebuild-time absolute URL.
 */
const ARTIFACTS_BASE = `${import.meta.env.BASE_URL}artifacts`.replace(/\/{2,}/g, "/");

/**
 * How many ranked lots to render. A driver picks from the first handful; past
 * that the list is scroll for its own sake, and every extra row is DOM work on
 * a phone. All 1,088 are still *ranked* -- only the tail is not drawn.
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
   */
  const gridHorizonMin = activeHorizon + (ageMin ?? 0);

  const horizons = useMemo(
    () =>
      grid === null
        ? []
        : Array.from({ length: grid.nHorizons }, (_unused, i) => (i + 1) * grid.stepMin),
    [grid],
  );

  const ranked = useMemo(() => {
    if (artifacts === null || destination === null) return [];
    const { grid: g, lots } = artifacts;
    return rankLots({
      destination,
      horizonMin: gridHorizonMin,
      lots: lots.lots,
      // Guarded rather than raw: a roster longer than the grid would otherwise
      // throw mid-render and take the whole page down, when "no data" for the
      // extra rows is both true and survivable.
      probability: (i, h) => (i < g.nLots ? probabilityAt(g, i, h) : null),
    }).slice(0, LIST_LIMIT);
  }, [artifacts, destination, gridHorizonMin]);

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
      finish();
    };
    geoWatchdogRef.current = setTimeout(() => settle(() => setGeo("unavailable")), GEO_WATCHDOG_MS);

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

        {horizons.length > 0 && (
          <div className="horizon">
            <label htmlFor="horizon-select">{s.arrivingIn}</label>
            <select
              id="horizon-select"
              value={activeHorizon}
              onChange={(e) => setHorizonMin(Number(e.target.value))}
            >
              {horizons.map((min) => (
                <option key={min} value={min}>
                  {min} {s.minutesUnit}
                </option>
              ))}
            </select>
          </div>
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
        {!loadFailed && artifacts === null && <p className="notice">{s.loading}</p>}
        {artifacts !== null && destination === null && <p className="notice">{s.startPrompt}</p>}
        {artifacts !== null && destination !== null && (
          <>
            <h2 className="list-head">{s.rankedForArrival}</h2>
            <LotList rows={ranked} lang={lang} />
          </>
        )}
      </main>
    </div>
  );
}
