/**
 * The screen's truthfulness tests.
 *
 * Every case here is a claim the UI must never make: a price it did not parse,
 * a 0% it does not mean, a bound of a range passed off as the range, an English
 * lot name that no sign in Taipei displays, or a spinner that never resolves.
 * They are written against rendered text rather than props, because the lie
 * these guard against is a rendering lie -- the data underneath is already
 * right, and was already tested.
 *
 * `fetch`, `navigator.geolocation` and the canvas's WebGL context are the only
 * stubs: the artifacts are built as real bytes and go through the real
 * `loadArtifacts`, so the parse, the roster pairing and the ranking are all
 * exercised as shipped -- and the real `MapView` mounts, down its real
 * no-WebGL path, on every one of these renders. It mounts a tick *late* now,
 * behind `React.lazy`, which is the subject of the last describe here: nothing
 * else in this file waits for it, because nothing else on the screen does.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, {
  COVERAGE_RADIUS_M,
  GEO_WATCHDOG_MS,
  LIST_LIMIT,
  MIN_REFETCH_MS,
  REFRESH_MS,
} from "../src/App";
import { HEADER_SIZE, UNKNOWN } from "../src/artifacts";
import { haversineMeters } from "../src/geo";
import { fillTemplate, t } from "../src/i18n";
import type { Lot, LotsDoc } from "../src/types";

const ROSTER_ID = 4242;
const N_HORIZONS = 24;
const STEP_MIN = 5;
/** Matches the fixture header below, so the staleness line is deterministic. */
const BASE_DATA_TS = 1788677280;
/** The frozen wall clock every test runs at: four minutes after the reading. */
const NOW_MS = (BASE_DATA_TS + 4 * 60) * 1000;

const HERE = { lat: 25.0375, lon: 121.5637 };

/**
 * Four lots covering the four fare shapes the parser produces. Coordinates are
 * ordered so the intended reading order is also roughly the ranked order, but
 * nothing here depends on that -- every assertion looks the row up by name.
 */
const LOTS: Lot[] = [
  {
    i: 0,
    id: "TPE_EXACT",
    n: "市府路一號停車場",
    a: "信義區",
    y: 25.0377,
    x: 121.5639,
    c: 120,
    t: "民營停車場",
    p: { k: "exact", lo: 60, hi: 60 },
  },
  {
    i: 1,
    id: "TPE_RANGE",
    n: "世貿一館站停車場",
    a: "信義區",
    y: 25.038,
    x: 121.5641,
    c: 335,
    t: "中央機關學校委外",
    p: { k: "range", lo: 20, hi: 40 },
  },
  {
    i: 2,
    id: "TPE_ENTRY",
    n: "至善公園平面停車場",
    a: "士林區",
    y: 25.0382,
    x: 121.5643,
    c: 13,
    t: "本處自營停車場",
    p: { k: "entry", lo: 50, hi: 50 },
  },
  {
    i: 3,
    id: "TPE_UNPRICED",
    n: "中山區行政中心停車場",
    a: "中山區",
    y: 25.0384,
    x: 121.5645,
    c: 63,
    t: "市屬機關學校自營",
    p: { k: "unknown" },
  },
];

/** Row-major cells: the unpriced lot is also the one with no forecast. */
function cells(): number[] {
  const out: number[] = [];
  const perLot = [88, 61, 45, UNKNOWN];
  for (const lot of LOTS) {
    const value = perLot[lot.i] ?? UNKNOWN;
    for (let h = 0; h < N_HORIZONS; h += 1) out.push(value);
  }
  return out;
}

/** `grid.bin` exactly as the Python encoder writes it: `<4sBIIHBBI`, no padding. */
function encodeGrid(body: number[], nLots: number): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + body.length);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode("PCG1"), 0);
  dv.setUint8(4, 1);
  dv.setUint32(5, BASE_DATA_TS + 213, true);
  dv.setUint32(9, BASE_DATA_TS, true);
  dv.setUint16(13, nLots, true);
  dv.setUint8(15, N_HORIZONS);
  dv.setUint8(16, STEP_MIN);
  dv.setUint32(17, ROSTER_ID, true);
  new Uint8Array(buf).set(body, HEADER_SIZE);
  return buf;
}

function makeGrid(): ArrayBuffer {
  return encodeGrid(cells(), LOTS.length);
}

function makeLotsDoc(): LotsDoc {
  return {
    v: 1,
    generated_at: BASE_DATA_TS + 213,
    base_data_ts: BASE_DATA_TS,
    n_lots: LOTS.length,
    roster_id: ROSTER_ID,
    lots: LOTS,
  };
}

/** The stubbed `fetch`, so a test can count how many times the grid was pulled. */
let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(grid: ArrayBuffer = makeGrid(), lots: LotsDoc = makeLotsDoc()) {
  fetchMock = vi.fn((url: string) => {
    if (url.endsWith("grid.bin")) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(grid) });
    }
    if (url.endsWith("lots.json")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(lots) });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** How many times `grid.bin` has been requested since the stub was installed. */
function gridFetchCount(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("grid.bin")).length;
}

/** Pretend the artifact's reading is `min` minutes old. */
function ageArtifact(min: number) {
  vi.spyOn(Date, "now").mockReturnValue((BASE_DATA_TS + min * 60) * 1000);
}

/**
 * Fake timers RTL can still make progress against.
 *
 * `waitFor` only knows how to drive *jest's* fake clock, so under vitest it
 * would block forever on a frozen one; `shouldAdvanceTime` keeps the clock
 * moving on its own. `Date` is left alone so `ageArtifact` still decides how
 * old the reading is.
 */
function useDrivableFakeTimers() {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
}

type PositionCallback = (pos: { coords: { latitude: number; longitude: number } }) => void;

/** Install a geolocation that succeeds at `HERE`, or one that denies. */
function stubGeolocation(mode: "granted" | "denied") {
  const getCurrentPosition = vi.fn((ok: PositionCallback, fail?: (e: unknown) => void) => {
    if (mode === "granted") ok({ coords: { latitude: HERE.lat, longitude: HERE.lon } });
    else fail?.({ code: 1, message: "User denied Geolocation" });
  });
  Object.defineProperty(navigator, "geolocation", {
    value: { getCurrentPosition },
    configurable: true,
  });
  return getCurrentPosition;
}

/** Render, wait for the artifacts, then take the location. */
async function renderLocated(): Promise<void> {
  stubGeolocation("granted");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
  await screen.findByTestId("lot-list");
}

/** Column `c` reads `(c + 1) * 4`%, so every column is a distinct percentage. */
const columnMark = (column: number) => (column + 1) * 4;

/** The single lot the column-marked fixture publishes. */
const MARKED = LOTS[0]!;

/**
 * One lot whose 24 columns are all different, so the row names its column.
 *
 * Shared by the two describes that need to see *which* column was read: the
 * staleness correction, and the expiry that fires when there is only one column
 * left to read.
 */
function stubColumnMarkedArtifacts() {
  const body = Array.from({ length: N_HORIZONS }, (_unused, c) => columnMark(c));
  stubFetch(encodeGrid(body, 1), {
    v: 1,
    generated_at: BASE_DATA_TS + 213,
    base_data_ts: BASE_DATA_TS,
    n_lots: 1,
    roster_id: ROSTER_ID,
    lots: [MARKED],
  });
}

/** The row whose lot name is `name`. Names are Chinese in both languages. */
function rowFor(name: string): HTMLElement {
  const heading = screen.getByText(name);
  const row = heading.closest("li");
  if (row === null) throw new Error(`no row rendered for ${name}`);
  return row;
}

beforeEach(() => {
  stubFetch();
  // The screen now mounts the map, and MapLibre asks the canvas for a WebGL
  // context on its way up. jsdom has none and says so -- loudly, once per
  // render. Answering `null` ourselves is the same answer without twenty lines
  // of noise per run, and it still sends `useMapLibre` down the real "this
  // device cannot draw the map" path these tests want it on.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // A fixed clock, so the staleness line is a fact rather than a race. Spying
  // on `Date.now` rather than faking timers: the component's clock interval is
  // not under test, and fake timers would put it in the way of every `findBy`.
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  // The default language must be a decision of the test, not of jsdom.
  Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "geolocation");
  Reflect.deleteProperty(document, "visibilityState");
  document.documentElement.lang = "en";
});

describe("price", () => {
  it("shows the words and no number at all for an unparseable fare", async () => {
    await renderLocated();
    const price = within(rowFor("中山區行政中心停車場")).getByTestId("lot-price");
    expect(price.textContent).toBe(t("en").priceUnknown);
    // The ranker charges this lot the median to score it. That number must
    // never reach the screen -- nor 0, nor "free".
    expect(price.textContent).not.toMatch(/\d/);
  });

  it("shows a per-entry fare as a per-visit price, not as unknown", async () => {
    await renderLocated();
    const price = within(rowFor("至善公園平面停車場")).getByTestId("lot-price");
    expect(price.textContent).toBe(`NT$50 ${t("en").perEntry}`);
    expect(price.textContent).not.toContain(t("en").priceUnknown);
    expect(price.textContent).not.toContain(t("en").perHour);
  });

  it("renders a range as the range, not as one of its bounds", async () => {
    await renderLocated();
    const price = within(rowFor("世貿一館站停車場")).getByTestId("lot-price");
    expect(price.textContent).toBe(`NT$20–40 ${t("en").perHour}`);
    // The ranker scores this lot at its NT$30 midpoint; the screen must not.
    expect(price.textContent).not.toContain("NT$30");
  });

  it("renders an exact hourly fare with its own number", async () => {
    await renderLocated();
    const price = within(rowFor("市府路一號停車場")).getByTestId("lot-price");
    expect(price.textContent).toBe(`NT$60 ${t("en").perHour}`);
  });
});

describe("probability", () => {
  it("says 'no data' for a lot with no forecast, and never 0%", async () => {
    await renderLocated();
    const chance = within(rowFor("中山區行政中心停車場")).getByTestId("lot-probability");
    expect(chance.textContent).toContain(t("en").noData);
    expect(chance.textContent).not.toContain("0%");
    expect(chance.textContent).not.toMatch(/\d+%/);
  });

  it("shows a known probability as a percentage", async () => {
    await renderLocated();
    const chance = within(rowFor("市府路一號停車場")).getByTestId("lot-probability");
    expect(chance.textContent).toContain("88%");
  });
});

describe("language", () => {
  it("switches the chrome but leaves lot names in Chinese", async () => {
    await renderLocated();
    // English chrome, English district, Chinese name -- all at once.
    expect(rowFor("市府路一號停車場").textContent).toContain("Xinyi District");
    expect(screen.getByText(t("en").rankedForArrival)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "切換為中文" }));

    await screen.findByRole("button", { name: t("zh").useMyLocation });
    // Chrome is Chinese...
    expect(screen.getByText(t("zh").rankedForArrival)).toBeDefined();
    // ...the district is too...
    expect(rowFor("市府路一號停車場").textContent).toContain("信義區");
    expect(rowFor("市府路一號停車場").textContent).not.toContain("Xinyi District");
    // ...and the lot names, which match the signage, are untouched.
    for (const lot of LOTS) expect(screen.getByText(lot.n)).toBeDefined();
  });
});

describe("geolocation", () => {
  it("shows the unavailable string on denial and leaves the page usable", async () => {
    stubGeolocation("denied");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));

    await screen.findByText(t("en").locationUnavailable);
    // No spinner left behind, and the user can try again.
    expect(screen.queryByText(t("en").locating)).toBeNull();
    const retry = screen.getByRole("button", { name: t("en").useMyLocation });
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("heading", { name: t("en").appName })).toBeDefined();
  });

  it("shows the unavailable string when the browser has no geolocation at all", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
    await screen.findByText(t("en").locationUnavailable);
  });

  it("gives up on a permission prompt that is closed without an answer", async () => {
    useDrivableFakeTimers();
    // The fourth case, and the only one the API cannot report: the spec starts
    // its own `timeout` only *after* the permission decision, so a prompt the
    // user (or the browser) closes without deciding fires neither callback.
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition: vi.fn() },
      configurable: true,
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
    expect(screen.getByRole("button", { name: t("en").locating }).hasAttribute("disabled")).toBe(
      true,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GEO_WATCHDOG_MS + 1_000);
    });

    await screen.findByText(t("en").locationUnavailable);
    const retry = screen.getByRole("button", { name: t("en").useMyLocation });
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(retry.getAttribute("aria-busy")).toBe("false");
  });

  it("does not take back a location it already found when the deadline passes", async () => {
    useDrivableFakeTimers();
    await renderLocated();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GEO_WATCHDOG_MS * 2);
    });

    expect(screen.queryByText(t("en").locationUnavailable)).toBeNull();
    expect(screen.getByTestId("lot-list")).toBeDefined();
  });
});

describe("staleness", () => {
  it("reports the age of the reading, from baseDataTs", async () => {
    render(<App />);
    const line = await screen.findByTestId("staleness");
    expect(line.textContent).toBe("data from 4 min ago");
  });
});

describe("arrival time", () => {
  it("offers every horizon the grid actually holds", async () => {
    render(<App />);
    // The scrubber's range is read off the grid's own header, so a grid built
    // at a different resolution moves the control instead of leaving its far
    // end pointing at a column that does not exist.
    const scrubber = await screen.findByLabelText(t("en").arrivingIn);
    expect(scrubber.getAttribute("min")).toBe(String(STEP_MIN));
    expect(scrubber.getAttribute("max")).toBe(String(N_HORIZONS * STEP_MIN));
    expect(scrubber.getAttribute("step")).toBe(String(STEP_MIN));
  });
});

/**
 * The app's headline claim, and the one thing a stale-count badge cannot do.
 *
 * `grid.py` evaluates column `c` at `base_data_ts + (c + 1) * stepMin`, so the
 * columns are anchored to the *reading*, not to the moment the user is looking.
 * Reading column "15 min" for a driver 15 minutes away therefore answers for 15
 * minutes after a reading that already happened -- a forecast for the past, once
 * the artifact is older than the trip. The age has to be added back.
 */
describe("staleness correction", () => {
  it("reads the column for the arrival time plus the artifact's age", async () => {
    const AGE_MIN = 10;
    const REQUESTED_MIN = 15; // the control's default
    stubColumnMarkedArtifacts();
    ageArtifact(AGE_MIN);

    await renderLocated();

    const chance = within(rowFor(MARKED.n)).getByTestId("lot-probability");
    // 15 minutes from now is 25 minutes from a reading 10 minutes old.
    const corrected = (REQUESTED_MIN + AGE_MIN) / STEP_MIN - 1;
    expect(chance.textContent).toContain(`${columnMark(corrected)}%`);
    // Not the uncorrected column, which forecasts five minutes before arrival.
    const uncorrected = REQUESTED_MIN / STEP_MIN - 1;
    expect(chance.textContent).not.toContain(`${columnMark(uncorrected)}%`);
  });

  it("moves the column it reads as the artifact ages, for one unchanged request", async () => {
    stubColumnMarkedArtifacts();
    ageArtifact(0);
    await renderLocated();
    const fresh = within(rowFor(MARKED.n)).getByTestId("lot-probability").textContent;

    cleanup();
    stubColumnMarkedArtifacts();
    ageArtifact(20);
    await renderLocated();
    const stale = within(rowFor(MARKED.n)).getByTestId("lot-probability").textContent;

    expect(fresh).toContain(`${columnMark(15 / STEP_MIN - 1)}%`);
    expect(stale).toContain(`${columnMark((15 + 20) / STEP_MIN - 1)}%`);
  });

  it("leaves the horizon control offering the arrival times the user picks", async () => {
    // The correction is applied to the grid read, never to the label: the user
    // still chooses a real number of minutes from now.
    ageArtifact(23);
    render(<App />);
    const scrubber = (await screen.findByLabelText(t("en").arrivingIn)) as HTMLInputElement;
    expect(scrubber.getAttribute("min")).toBe(String(STEP_MIN));
    expect(scrubber.getAttribute("max")).toBe(String(N_HORIZONS * STEP_MIN));
    // 15 minutes from now, not 38 -- the age belongs to the grid read alone.
    expect(scrubber.value).toBe("15");
  });

  it("keeps offering the far horizons even when the offset runs off the grid", async () => {
    // `probabilityAt` clamps to the last column. Being a few minutes short at
    // +120 is a far smaller lie than being wrong at +5, and dropping the option
    // would take a real arrival time off the control to flatter the model.
    stubColumnMarkedArtifacts();
    ageArtifact(30);
    await renderLocated();
    fireEvent.change(screen.getByLabelText(t("en").arrivingIn), {
      target: { value: String(N_HORIZONS * STEP_MIN) },
    });
    const chance = within(rowFor(MARKED.n)).getByTestId("lot-probability");
    expect(chance.textContent).toContain(`${columnMark(N_HORIZONS - 1)}%`);
    expect(chance.textContent).not.toContain(t("en").noData);
  });
});

/**
 * A tab left open must not drift: the correction above only stays bounded if
 * the artifact keeps arriving.
 */
describe("refresh", () => {
  it("refetches the grid on an interval", async () => {
    useDrivableFakeTimers();
    render(<App />);
    await screen.findByTestId("staleness");
    const before = gridFetchCount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 1_000);
    });

    expect(gridFetchCount()).toBeGreaterThan(before);
  });

  it("refetches when a hidden tab is looked at again", async () => {
    render(<App />);
    await screen.findByTestId("staleness");
    const before = gridFetchCount();
    // `Date.now` is frozen for these tests, so the floor would suppress this
    // refetch on a technicality. Move the clock past it: the behaviour under
    // test is "coming back refetches", not "coming back within a second does".
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS + MIN_REFETCH_MS + 1_000);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(gridFetchCount()).toBeGreaterThan(before);
  });

  /**
   * The interval is self-limiting; `visibilitychange` was not. Flipping between
   * this app and a map application fired one request per flip, unbounded, at an
   * app whose whole serving story is "it is only a CDN".
   */
  it("does not refetch again the instant the tab is flipped back", async () => {
    render(<App />);
    await screen.findByTestId("staleness");
    const before = gridFetchCount();

    await act(async () => {
      for (let i = 0; i < 5; i += 1) document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(gridFetchCount()).toBe(before);
  });

  it("refetches again once the floor has passed", async () => {
    render(<App />);
    await screen.findByTestId("staleness");
    const before = gridFetchCount();

    // One flip inside the floor buys nothing...
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(gridFetchCount()).toBe(before);

    // ...and the floor is a delay, not a lockout.
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS + MIN_REFETCH_MS + 1_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(gridFetchCount()).toBeGreaterThan(before);
  });

  it("does not poll a tab nobody is looking at", async () => {
    useDrivableFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    render(<App />);
    await screen.findByTestId("staleness");
    const before = gridFetchCount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });

    expect(gridFetchCount()).toBe(before);
  });

  it("keeps showing the forecast it has when a refresh fails", async () => {
    useDrivableFakeTimers();
    render(<App />);
    await screen.findByTestId("staleness");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 1_000);
    });

    // An older grid is not a missing one, and the staleness line already says so.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("staleness")).toBeDefined();
  });
});

describe("document language", () => {
  it("labels the document with the language it is actually written in", async () => {
    render(<App />);
    await screen.findByTestId("staleness");
    expect(document.documentElement.lang).toBe("en");

    fireEvent.click(screen.getByRole("button", { name: "切換為中文" }));
    await screen.findByRole("button", { name: t("zh").useMyLocation });

    // Not `zh`: the app is Traditional throughout, and the script is what
    // decides the voice, the font fallback and the line breaking.
    expect(document.documentElement.lang).toBe("zh-Hant");
  });

  it("defaults to Chinese, the same way the UI does", async () => {
    Object.defineProperty(navigator, "language", { value: "ja-JP", configurable: true });
    render(<App />);
    await screen.findByTestId("staleness");
    expect(document.documentElement.lang).toBe("zh-Hant");
  });
});

describe("artifacts", () => {
  it("says so when they cannot be loaded, instead of showing an empty list", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t("en").loadFailed);
    expect(screen.queryByTestId("lot-list")).toBeNull();
  });
});

/**
 * The forecast has an expiry, and the app has to say so.
 *
 * The staleness correction pushes every arrival time the user can pick towards
 * the end of the grid as the reading ages. Once even the *nearest* one clamps to
 * the last column, they all do: the scrubber becomes a control that changes
 * nothing while the screen shows one answer for a time nobody asked for. Found
 * with a 383-minute-old artifact, and guaranteed to recur: the collector stops
 * whenever its machine sleeps while the published copy stays up and goes on
 * ageing.
 *
 * The boundary is the point of the two tests at the bottom. It is *not* the
 * grid's span: at the shipped geometry the scrubber goes inert at an age of 113
 * minutes, eight before the span runs out at 121.
 */
describe("an artifact older than the grid it came from", () => {
  /** The 383 minutes actually observed while verifying the scrubber. */
  const OBSERVED_AGE_MIN = 383;
  /** `round((5 + 112) / 5) - 1` is column 22; one minute later it is 23. */
  const LAST_LIVE_AGE_MIN = 112;

  it("says the forecast is too old instead of showing a clamped column", async () => {
    ageArtifact(OBSERVED_AGE_MIN);
    await renderLocated();

    expect(screen.getByTestId("forecast-expired").textContent).toBe(t("en").forecastTooOld);
    // The lot whose every column reads 88 must not report 88%: that column is a
    // clamp, not an answer for the arrival time the user actually chose.
    const chance = within(rowFor("市府路一號停車場")).getByTestId("lot-probability");
    expect(chance.textContent).toContain(t("en").noData);
    for (const cell of screen.getAllByTestId("lot-probability")) {
      expect(cell.textContent).not.toMatch(/\d+%/);
    }
  });

  it("keeps the rest of the page usable, because only the probability expired", async () => {
    ageArtifact(OBSERVED_AGE_MIN);
    await renderLocated();

    // Names, districts, walking distances and prices never came from the grid.
    const row = rowFor("至善公園平面停車場");
    expect(within(row).getByTestId("lot-price").textContent).toBe(`NT$50 ${t("en").perEntry}`);
    expect(within(row).getByTestId("lot-walk").textContent).toContain(t("en").walk);
    expect(screen.getByTestId("lot-list")).toBeInTheDocument();
    // ...and the age is still reported, which is how the user can tell why.
    expect(screen.getByTestId("staleness")).toBeInTheDocument();
  });

  it("stops the heading claiming an order the forecast no longer supports", async () => {
    ageArtifact(OBSERVED_AGE_MIN);
    await renderLocated();
    expect(screen.getByText(t("en").nearbyCarParks)).toBeInTheDocument();
    expect(screen.queryByText(t("en").rankedForArrival)).toBeNull();
  });

  it("disables the scrubber rather than leave a control that does nothing", async () => {
    ageArtifact(OBSERVED_AGE_MIN);
    await renderLocated();
    expect(screen.getByLabelText(t("en").arrivingIn)).toBeDisabled();
  });

  it("says all of it in Chinese too", async () => {
    ageArtifact(OBSERVED_AGE_MIN);
    await renderLocated();
    fireEvent.click(screen.getByRole("button", { name: "切換為中文" }));
    await screen.findByRole("button", { name: t("zh").useMyLocation });

    expect(screen.getByTestId("forecast-expired").textContent).toBe(t("zh").forecastTooOld);
    expect(screen.getByText(t("zh").nearbyCarParks)).toBeInTheDocument();
  });

  it("expires as soon as the nearest arrival time clamps, not a window later", async () => {
    // 113 minutes: inside the grid's 120-minute span, and already inert. The
    // span test called this live, so the slider was enabled and the heading
    // claimed an order over 24 identical clamped columns.
    ageArtifact(LAST_LIVE_AGE_MIN + 1);
    await renderLocated();

    expect(screen.getByTestId("forecast-expired").textContent).toBe(t("en").forecastTooOld);
    expect(screen.getByLabelText(t("en").arrivingIn)).toBeDisabled();
    expect(screen.getByText(t("en").nearbyCarParks)).toBeInTheDocument();
    for (const cell of screen.getAllByTestId("lot-probability")) {
      expect(cell.textContent).not.toMatch(/\d+%/);
    }
  });

  it("leaves a grid alone while the scrubber can still change the answer", async () => {
    // One minute earlier, and the control is not a decoration: the nearest
    // arrival reads column 22 and the furthest reads 23, so the far horizons
    // clamp exactly as they always have -- the documented trade, not an expiry.
    stubColumnMarkedArtifacts();
    ageArtifact(LAST_LIVE_AGE_MIN);
    await renderLocated();

    expect(screen.queryByTestId("forecast-expired")).toBeNull();
    expect(screen.getByText(t("en").rankedForArrival)).toBeInTheDocument();
    const scrubber = screen.getByLabelText(t("en").arrivingIn);
    expect(scrubber).not.toBeDisabled();

    fireEvent.change(scrubber, { target: { value: String(STEP_MIN) } });
    const nearest = within(rowFor(MARKED.n)).getByTestId("lot-probability").textContent;
    fireEvent.change(scrubber, { target: { value: String(N_HORIZONS * STEP_MIN) } });
    const furthest = within(rowFor(MARKED.n)).getByTestId("lot-probability").textContent;

    expect(nearest).toContain(`${columnMark(N_HORIZONS - 2)}%`);
    expect(furthest).toContain(`${columnMark(N_HORIZONS - 1)}%`);
    expect(nearest).not.toBe(furthest);
  });
});

/**
 * The list cap, and the guarantee it silently undid.
 *
 * `rank.ts` keeps a lot with no forecast and ranks it last so that it is never
 * dropped; rendering a fixed 20 rows then dropped precisely those lots. This is
 * the wiring test -- `listRows` is unit-tested in `rank.test.ts`, but the bug
 * lived in the slice, not in the sort.
 */
describe("the list cap", () => {
  const NEARBY_UNKNOWN = "巷口臨時停車場";

  /** 25 lots, all priced alike so only distance and the forecast decide order. */
  function crowd(): Lot[] {
    const nearest: Lot = {
      i: 0,
      id: "TPE_NEAR_UNKNOWN",
      n: NEARBY_UNKNOWN,
      a: "信義區",
      y: HERE.lat + 0.00005,
      x: HERE.lon,
      c: 8,
      t: "民營停車場",
      p: { k: "exact", lo: 30, hi: 30 },
    };
    const rest = Array.from({ length: 24 }, (_unused, k): Lot => ({
      i: k + 1,
      id: `TPE_KNOWN_${k}`,
      n: `已知停車場${k}`,
      a: "信義區",
      y: HERE.lat + 0.002 * (k + 1),
      x: HERE.lon,
      c: 50,
      t: "民營停車場",
      p: { k: "exact", lo: 30, hi: 30 },
    }));
    return [nearest, ...rest];
  }

  /** Row 0 -- the nearest lot of the 25 -- is the one with no forecast. */
  function stubCrowded(withUnknown: boolean) {
    const lots = crowd();
    const body: number[] = [];
    for (const row of lots) {
      const value = withUnknown && row.i === 0 ? UNKNOWN : 70;
      for (let h = 0; h < N_HORIZONS; h += 1) body.push(value);
    }
    stubFetch(encodeGrid(body, lots.length), {
      v: 1,
      generated_at: BASE_DATA_TS + 213,
      base_data_ts: BASE_DATA_TS,
      n_lots: lots.length,
      roster_id: ROSTER_ID,
      lots,
    });
  }

  it("keeps the nearest lot with no forecast reachable past the 20th row", async () => {
    stubCrowded(true);
    await renderLocated();

    // The ranker sorts it 25th, one row past the cap, and it was invisible.
    const row = rowFor(NEARBY_UNKNOWN);
    expect(row).toBeInTheDocument();
    expect(within(row).getByTestId("lot-probability").textContent).toContain(t("en").noData);
    expect(screen.getAllByTestId("lot-row").length).toBeGreaterThan(LIST_LIMIT);
  });

  it("grows the list rather than reordering it", async () => {
    stubCrowded(true);
    await renderLocated();

    const ids = screen.getAllByTestId("lot-row").map((el) => el.getAttribute("data-lot-id"));
    // The 20 scored lots keep the cap's places; the rescued row is appended.
    expect(ids.slice(0, LIST_LIMIT).every((id) => id?.startsWith("TPE_KNOWN_"))).toBe(true);
    expect(ids.at(-1)).toBe("TPE_NEAR_UNKNOWN");
  });

  it("still caps the list when every lot has a forecast", async () => {
    // Nothing was dropped, so nothing is rescued and the cap holds at 20.
    stubCrowded(false);
    await renderLocated();
    expect(screen.getAllByTestId("lot-row").length).toBe(LIST_LIMIT);
  });
});

/**
 * The edge of what this app can answer.
 *
 * `rankLots` has no distance cutoff by design -- it scores whatever roster it is
 * handed against whatever point it is handed -- so before `COVERAGE_RADIUS_M`
 * the screen answered "where should I park?" for a driver in Kaohsiung with a
 * ranked list of Taipei car parks 291 km away, every number in it true and the
 * answer useless. The two boundary tests below are what pin the constant; the
 * rest is what the user is told instead.
 */
describe("a destination outside the covered area", () => {
  /** The expected notice, radius and all, so the string cannot drift from the constant. */
  const notice = (lang: "en" | "zh") =>
    fillTemplate(t(lang).outsideCoverage, { km: COVERAGE_RADIUS_M / 1000 });

  /** A geolocation that lands exactly where the test says, not at `HERE`. */
  function stubGeolocationAt(at: { lat: number; lon: number }) {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: vi.fn((ok: PositionCallback) =>
          ok({ coords: { latitude: at.lat, longitude: at.lon } }),
        ),
      },
      configurable: true,
    });
  }

  /** Metres from `at` to the nearest fixture lot -- the quantity under test. */
  function nearestMeters(at: { lat: number; lon: number }): number {
    return Math.min(...LOTS.map((lot) => haversineMeters(at, { lat: lot.y, lon: lot.x })));
  }

  async function renderAt(at: { lat: number; lon: number }) {
    stubGeolocationAt(at);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
  }

  /** Due north of the roster: 0.10° of latitude is a little over 11 km. */
  const JUST_OUTSIDE = { lat: LOTS[0]!.y + 0.1, lon: LOTS[0]!.x };
  /** ...and 0.08° is a little under 9 km, on the other side of the line. */
  const JUST_INSIDE = { lat: LOTS[0]!.y + 0.08, lon: LOTS[0]!.x };
  /** The measurement that started this: Kaohsiung, 291 km from the nearest lot. */
  const KAOHSIUNG = { lat: 22.6273, lon: 120.3014 };

  it("says so instead of ranking car parks a day's walk away", async () => {
    expect(nearestMeters(KAOHSIUNG)).toBeGreaterThan(250_000);
    await renderAt(KAOHSIUNG);

    expect((await screen.findByTestId("outside-coverage")).textContent).toBe(notice("en"));
    expect(screen.queryByTestId("lot-list")).toBeNull();
    // ...and no heading claiming an order over an explanation that there is none.
    expect(screen.queryByText(t("en").rankedForArrival)).toBeNull();
    expect(screen.queryByText(t("en").nearbyCarParks)).toBeNull();
  });

  it("keeps the map and the rest of the page working out there", async () => {
    await renderAt(KAOHSIUNG);
    await screen.findByTestId("outside-coverage");

    // The map draws every lot regardless of where the driver is: it is the
    // *ranking* that is meaningless at 291 km, not the roster.
    expect(await screen.findByText(t("en").mapUnavailable)).toBeInTheDocument();
    expect(screen.getByTestId("staleness")).toBeInTheDocument();
    expect(screen.getByLabelText(t("en").searchLabel)).toBeInTheDocument();
  });

  it("draws the line at COVERAGE_RADIUS_M, not somewhere near it", async () => {
    expect(nearestMeters(JUST_OUTSIDE)).toBeGreaterThan(COVERAGE_RADIUS_M);
    await renderAt(JUST_OUTSIDE);
    expect(await screen.findByTestId("outside-coverage")).toBeInTheDocument();
  });

  it("still ranks from just inside it -- New Taipei is 2.7 km out, not 20", async () => {
    expect(nearestMeters(JUST_INSIDE)).toBeLessThan(COVERAGE_RADIUS_M);
    await renderAt(JUST_INSIDE);

    expect(await screen.findByTestId("lot-list")).toBeInTheDocument();
    expect(screen.queryByTestId("outside-coverage")).toBeNull();
    expect(screen.getByText(t("en").rankedForArrival)).toBeInTheDocument();
  });

  it("says it in Chinese too", async () => {
    await renderAt(KAOHSIUNG);
    await screen.findByTestId("outside-coverage");
    fireEvent.click(screen.getByRole("button", { name: "切換為中文" }));
    await screen.findByRole("button", { name: t("zh").useMyLocation });
    expect(screen.getByTestId("outside-coverage").textContent).toBe(notice("zh"));
  });

  it("covers an empty roster too, which is the same sentence and still true", async () => {
    // A schema-valid pair with no lots in it: with nothing in the roster,
    // nothing is within 10 km of anywhere. A bare heading over nothing was the
    // old failure here, and it is still not what happens.
    stubFetch(encodeGrid([], 0), {
      v: 1,
      generated_at: BASE_DATA_TS + 213,
      base_data_ts: BASE_DATA_TS,
      n_lots: 0,
      roster_id: ROSTER_ID,
      lots: [],
    });
    stubGeolocation("granted");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));

    expect((await screen.findByTestId("outside-coverage")).textContent).toBe(notice("en"));
    expect(screen.queryByTestId("lot-list")).toBeNull();
  });
});

/**
 * Setting a destination by name.
 *
 * The GPS button answers "where am I" and the map answers "that spot there";
 * neither answers "I am going to 台北車站 tomorrow morning", which is the
 * question a driver actually has. This searches the roster already in memory --
 * no geocoder, no key, no third-party origin, and the destination never leaves
 * the phone. `search.test.ts` covers the matching; these cover the wiring, and
 * the wiring is where the interesting failure is: a second destination path.
 */
describe("searching for a destination", () => {
  /**
   * One extra lot, 11 km north of the other four, so that picking it and
   * picking a downtown one produce visibly different rankings.
   *
   * Spelled with 臺, like 76 of the published names, while a driver types 台.
   */
  const FAR_LOT: Lot = {
    i: 4,
    id: "TPE_BEITOU",
    n: "臺北北投溫泉停車場",
    a: "北投區",
    y: 25.137,
    x: 121.503,
    c: 40,
    t: "民營停車場",
    p: { k: "exact", lo: 60, hi: 60 },
  };

  const SEARCHABLE = [...LOTS, FAR_LOT];

  function stubSearchable() {
    const perLot = [88, 61, 45, UNKNOWN, 70];
    const body: number[] = [];
    for (const lot of SEARCHABLE) {
      const value = perLot[lot.i] ?? UNKNOWN;
      for (let h = 0; h < N_HORIZONS; h += 1) body.push(value);
    }
    stubFetch(encodeGrid(body, SEARCHABLE.length), {
      v: 1,
      generated_at: BASE_DATA_TS + 213,
      base_data_ts: BASE_DATA_TS,
      n_lots: SEARCHABLE.length,
      roster_id: ROSTER_ID,
      lots: SEARCHABLE,
    });
  }

  /** The search box, once the roster it searches has arrived. */
  function box(): HTMLInputElement {
    return screen.getByLabelText(t("en").searchLabel) as HTMLInputElement;
  }

  async function renderSearchable(): Promise<HTMLInputElement> {
    stubSearchable();
    render(<App />);
    await screen.findByLabelText(t("en").searchLabel);
    return box();
  }

  function type(text: string) {
    fireEvent.change(box(), { target: { value: text } });
  }

  /** The ids of the rendered options, in the order they are offered. */
  function optionIds(): (string | null)[] {
    return screen.queryAllByTestId("search-option").map((el) => el.getAttribute("data-lot-id"));
  }

  /** The id of the first ranked row. */
  function firstRankedId(): string | null {
    return screen.getAllByTestId("lot-row")[0]?.getAttribute("data-lot-id") ?? null;
  }

  it("sets the destination from a car park chosen by name", async () => {
    await renderSearchable();
    // Nothing is ranked until a destination exists -- the prompt, not a list.
    expect(screen.getByText(t("en").startPrompt)).toBeInTheDocument();
    expect(screen.queryByTestId("lot-list")).toBeNull();

    type("北投");
    expect(optionIds()).toEqual(["TPE_BEITOU"]);
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(await screen.findByTestId("lot-list")).toBeInTheDocument();
    // The chosen car park is where the driver is going, so it is 0 m away.
    expect(firstRankedId()).toBe("TPE_BEITOU");
    expect(screen.queryByText(t("en").startPrompt)).toBeNull();
  });

  it("re-ranks around whichever car park was chosen", async () => {
    await renderSearchable();
    type("北投");
    fireEvent.keyDown(box(), { key: "Enter" });
    await screen.findByTestId("lot-list");
    expect(firstRankedId()).toBe("TPE_BEITOU");

    type("至善");
    fireEvent.keyDown(box(), { key: "Enter" });

    // A different point, a different order -- not a list that was computed once.
    expect(firstRankedId()).toBe("TPE_ENTRY");
  });

  it("finds a 臺-spelled car park from the 台 a driver types, and back", async () => {
    // The end-to-end half of the fold: 76 published names use 臺, 108 use 台,
    // and the variant the user happens to type must not decide what they see.
    await renderSearchable();
    type("台北北投");
    expect(optionIds()).toEqual(["TPE_BEITOU"]);
    // ...and the option shows the feed's own spelling, which is on the sign.
    expect(screen.getByTestId("search-option").textContent).toContain("臺北北投溫泉停車場");

    type("臺北北投");
    expect(optionIds()).toEqual(["TPE_BEITOU"]);
  });

  it("goes through the same destination path a map tap uses", async () => {
    // The one that catches a second code path: a location request still in
    // flight must be abandoned by a search pick exactly as it is by a tap,
    // or a fix arriving a second later silently moves the destination.
    stubSearchable();
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition: vi.fn() },
      configurable: true,
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
    expect(screen.getByRole("button", { name: t("en").locating })).toBeDisabled();

    type("北投");
    fireEvent.keyDown(box(), { key: "Enter" });

    await screen.findByTestId("lot-list");
    const locate = screen.getByRole("button", { name: t("en").useMyLocation });
    expect(locate).not.toBeDisabled();
    expect(locate.getAttribute("aria-busy")).toBe("false");
  });

  it("can be driven by the keyboard alone", async () => {
    await renderSearchable();
    type("停車場");
    const offered = optionIds();
    expect(offered.length).toBeGreaterThan(1);
    expect(box().getAttribute("aria-expanded")).toBe("true");

    // Down to the second option, down again, back up: Enter takes what is
    // highlighted, and `aria-activedescendant` says which that is.
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    const active = screen.getByRole("option", { selected: true });
    expect(box().getAttribute("aria-activedescendant")).toBe(active.id);
    expect(active.getAttribute("data-lot-id")).toBe(offered[1]);

    fireEvent.keyDown(box(), { key: "Enter" });
    await screen.findByTestId("lot-list");
    expect(firstRankedId()).toBe(offered[1]);
  });

  it("dismisses the results on escape without losing the query", async () => {
    await renderSearchable();
    type("北投");
    expect(optionIds()).toHaveLength(1);

    fireEvent.keyDown(box(), { key: "Escape" });

    expect(optionIds()).toHaveLength(0);
    expect(box().getAttribute("aria-expanded")).toBe("false");
    expect(box().value).toBe("北投");
    // ...and Down brings them back rather than making the user retype.
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(optionIds()).toEqual(["TPE_BEITOU"]);
  });

  it("says nothing matched instead of ranking something that did not", async () => {
    // 市政府 is the honest limitation, measured over the live roster: the car
    // parks by Taipei City Hall are called 松壽廣場 and 府前廣場. This searches
    // car park names, and it must say so rather than invent a landmark.
    await renderSearchable();
    type("市政府");

    expect(screen.getByTestId("search-no-match").textContent).toBe(t("en").searchNoMatch);
    expect(optionIds()).toHaveLength(0);
    expect(screen.queryByTestId("lot-list")).toBeNull();
    // The caption saying what is searched is on screen before the failure, too.
    expect(screen.getByText(t("en").searchHint)).toBeInTheDocument();
  });

  it("makes no network request at all while searching", async () => {
    // The whole reason there is no geocoder here. If this ever fails, the
    // driver's destination started leaving the phone.
    await renderSearchable();
    const before = fetchMock.mock.calls.length;

    for (const query of ["1", "10", "101", "USPACE", "市政府", "台北北投", "北投"]) type(query);
    fireEvent.keyDown(box(), { key: "Enter" });
    await screen.findByTestId("lot-list");

    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("names the car parks in Chinese and the districts in the reader's language", async () => {
    await renderSearchable();
    type("北投");
    const option = screen.getByTestId("search-option");
    // The name matches the signage, in either UI language...
    expect(option.textContent).toContain("臺北北投溫泉停車場");
    expect(option.textContent).toContain("Beitou District");

    fireEvent.click(screen.getByRole("button", { name: "切換為中文" }));
    await screen.findByRole("button", { name: t("zh").useMyLocation });

    const zhBox = screen.getByLabelText(t("zh").searchLabel);
    expect(screen.getByText(t("zh").searchHint)).toBeInTheDocument();
    fireEvent.change(zhBox, { target: { value: "北投" } });
    const zhOption = screen.getByTestId("search-option");
    expect(zhOption.textContent).toContain("臺北北投溫泉停車場");
    expect(zhOption.textContent).toContain("北投區");
  });
});

/**
 * The map is 333 KB gzipped and the list is the answer, so the list is no
 * longer behind it. This is the *after* picture: with the chunk in, the page is
 * the page it always was.
 *
 * The two halves this cannot show live elsewhere, for one reason each:
 * `mapChunk.test.tsx` proves the import is genuinely dynamic, which only the
 * first render of a module registry can observe because `React.lazy` caches;
 * and `mapLazy.test.tsx` holds the boundary open to show what the user reads
 * while the chunk is still in flight, which a real import resolves too fast to
 * catch.
 */
describe("the map is a separate chunk", () => {
  it("still ranks, lists and draws once the chunk has landed", async () => {
    await renderLocated();
    // MapLibre's own no-WebGL notice: proof the real `MapView` mounted, late.
    await screen.findByText(t("en").mapUnavailable);

    expect(screen.queryByTestId("map-loading")).toBeNull();
    expect(screen.getByTestId("lot-list")).toBeInTheDocument();
    expect(within(rowFor("市府路一號停車場")).getByTestId("lot-probability").textContent).toContain(
      "88%",
    );
  });
});
