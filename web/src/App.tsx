/**
 * The screen. One page: where you are, when you arrive, and what to do about it.
 *
 * The whole app is client-side. Two static files are fetched once, the ranking
 * runs in this component, and nothing is ever sent anywhere -- the driver's
 * location never leaves the phone, because there is no server to send it to.
 *
 * Three things here are load-bearing rather than cosmetic:
 *
 *   - **The staleness line.** The upstream feed publishes every five minutes
 *     with a ~3-minute lag, so the reading behind any forecast is already a few
 *     minutes old. Saying so, from the grid's own `baseDataTs`, is the honest
 *     version of the "live" badge every other parking app wears -- and it is
 *     this project's entire thesis in one line of text.
 *   - **Geolocation never leaves the user on a spinner.** Denial, failure and a
 *     browser without the API all land in the same visible end state, with the
 *     rest of the page still working.
 *   - **`baseDataTs` and `generatedAt` stay distinct.** The age shown is the age
 *     of the *reading*, not of the file we wrote from it.
 */
import { useEffect, useMemo, useState } from "react";
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
  const [destination, setDestination] = useState<LatLon | null>(null);
  const [geo, setGeo] = useState<GeoState>("idle");
  const [horizonMin, setHorizonMin] = useState(DEFAULT_HORIZON_MIN);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const s = t(lang);

  useEffect(() => {
    let cancelled = false;
    loadArtifacts(ARTIFACTS_BASE).then(
      (loaded) => {
        if (!cancelled) setArtifacts(loaded);
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // The staleness line is only honest if it keeps counting.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const grid = artifacts?.grid ?? null;

  /**
   * The horizon snapped to a column the grid actually has, so the number under
   * the control and the column read out of the grid are the same number.
   */
  const activeHorizon = grid ? (horizonColumn(grid, horizonMin) + 1) * grid.stepMin : horizonMin;

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
      horizonMin: activeHorizon,
      lots: lots.lots,
      // Guarded rather than raw: a roster longer than the grid would otherwise
      // throw mid-render and take the whole page down, when "no data" for the
      // extra rows is both true and survivable.
      probability: (i, h) => (i < g.nLots ? probabilityAt(g, i, h) : null),
    }).slice(0, LIST_LIMIT);
  }, [artifacts, destination, activeHorizon]);

  function requestLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeo("unavailable");
      return;
    }
    setGeo("locating");
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setDestination({ lat: pos.coords.latitude, lon: pos.coords.longitude });
          setGeo("ready");
        },
        // Denied, timed out, or position unavailable: one visible end state.
        () => setGeo("unavailable"),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
      );
    } catch {
      setGeo("unavailable");
    }
  }

  // Whole minutes since the *reading*, not since the file was written.
  const ageMin =
    grid === null ? null : Math.max(0, Math.round((nowMs / 1000 - grid.baseDataTs) / 60));

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
