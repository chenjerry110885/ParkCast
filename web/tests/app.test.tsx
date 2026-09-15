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
import { arrivalOptions, defaultArrival, formatClock, horizonFromReading } from "../src/arrival";
import { HEADER_SIZE, UNKNOWN, horizonColumn } from "../src/artifacts";
import { haversineMeters } from "../src/geo";
import { fillTemplate, t } from "../src/i18n";
import { resetPlaceIndexCache } from "../src/places";
import type { Grid, Lot, LotsDoc } from "../src/types";

const ROSTER_ID = 4242;
const N_HORIZONS = 24;
const STEP_MIN = 5;
/** Matches the fixture header below, so the staleness line is deterministic. */
const BASE_DATA_TS = 1788677280;
/** The frozen wall clock every test runs at: four minutes after the reading. */
const NOW_MS = (BASE_DATA_TS + 4 * 60) * 1000;
/** ...as the app sees it. The arrival strip is built from unix seconds, not milliseconds. */
const NOW_SEC = NOW_MS / 1000;

/**
 * Just enough of the grid for `arrival.ts` to answer with, so every expectation
 * about the strip is computed by the same helpers the app uses rather than
 * spelled out as a literal clock time that would quietly rot when the fixture's
 * `base_data_ts` moved.
 */
const GRID_SPAN = { baseDataTs: BASE_DATA_TS, stepMin: STEP_MIN, nHorizons: N_HORIZONS };

/** The grid's shape, for `horizonColumn` -- the rest of a `Grid` is never read. */
const GRID = GRID_SPAN as unknown as Grid;

/** The wall clock the app is reading right now, in seconds -- after any `ageArtifact`. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** The column the app reads for an arrival time, age and all. See `horizonFromReading`. */
function columnFor(arrivalTs: number): number {
  return horizonColumn(GRID, horizonFromReading(arrivalTs, BASE_DATA_TS));
}

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
    // The offline place index, which `PlaceSearch` asks for once on its first
    // focus. Empty on purpose: these tests are about the wiring around the box,
    // and an empty index leaves the live roster as the only source of results --
    // which is the fallback the shipped code has to keep working anyway.
    if (url.endsWith("places/taipei.json")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ v: 1, built: 1, source: "t", rows: [] }),
      });
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

/**
 * A fact tile's sentence: the big value and the label under it, joined by the
 * space the layout puts between them and the DOM does not. The card splits
 * "NT$50 per entry" into two elements so the number can be set in the tabular
 * figures the label is not, which leaves `textContent` reading "NT$50per entry".
 */
function factText(tile: HTMLElement): string {
  const value = tile.querySelector(".fact__value")?.textContent ?? "";
  const label = tile.querySelector(".fact__label")?.textContent ?? "";
  return label === "" ? value : `${value} ${label}`;
}

/** The arrival strip's chips, as the clock times they read. */
function chipTimes(): string[] {
  return screen.queryAllByRole("radio").map((chip) => chip.textContent ?? "");
}

beforeEach(() => {
  stubFetch();
  // The place index is cached per URL for the life of the module, and recent
  // picks live in `localStorage`; both would otherwise leak from one test into
  // the next and decide what the search box offers.
  resetPlaceIndexCache();
  window.localStorage.clear();
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
  // jsdom answers `false` to every media query, which leaves the probability
  // ring counting to each new value over 400 ms of real animation frames --
  // updates React cannot see inside `act`, and a number that is briefly the
  // *old* answer. Reduced motion is a shipped code path, not a special case,
  // and it settles synchronously; the breakpoint query still answers "phone",
  // so the layout under test is the same one it always was.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
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
    expect(factText(price)).toBe(`NT$50 ${t("en").perEntry}`);
    expect(price.textContent).not.toContain(t("en").priceUnknown);
    expect(price.textContent).not.toContain(t("en").perHour);
  });

  it("renders a range as the range, not as one of its bounds", async () => {
    await renderLocated();
    const price = within(rowFor("世貿一館站停車場")).getByTestId("lot-price");
    expect(factText(price)).toBe(`NT$20–40 ${t("en").perHour}`);
    // The ranker scores this lot at its NT$30 midpoint; the screen must not.
    expect(price.textContent).not.toContain("NT$30");
  });

  it("renders an exact hourly fare with its own number", async () => {
    await renderLocated();
    const price = within(rowFor("市府路一號停車場")).getByTestId("lot-price");
    expect(factText(price)).toBe(`NT$60 ${t("en").perHour}`);
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

describe("a car park whose feed is not updating", () => {
  /** 30 hours and 7 minutes before the reading. */
  const LAST_UPDATE = BASE_DATA_TS - 30 * 3600 - 7 * 60;
  const NAME = "中山區行政中心停車場";

  /** The standard fixture, with the unpriced lot marked not updating. */
  function stubNotUpdating(cell: number = UNKNOWN) {
    const lots = LOTS.map((lot) => (lot.id === "TPE_UNPRICED" ? { ...lot, u: LAST_UPDATE } : lot));
    const perLot = [88, 61, 45, cell];
    const body: number[] = [];
    for (const lot of lots) for (let h = 0; h < N_HORIZONS; h += 1) body.push(perLot[lot.i] ?? UNKNOWN);
    stubFetch(encodeGrid(body, lots.length), { ...makeLotsDoc(), lots });
  }

  it("says so, and for how long, instead of a probability", async () => {
    stubNotUpdating();
    await renderLocated();
    const row = rowFor(NAME);
    const chance = within(row).getByTestId("lot-probability");
    expect(chance.textContent).toContain(t("en").notUpdating);
    // How long, on the card's sub-line under the name: the ring has room for
    // the words or the duration, not both, and the words are the claim.
    expect(row.textContent).toContain(fillTemplate(t("en").unchangedForTemplate, { n: 30 }));
    expect(chance.textContent).not.toMatch(/\d+%/);
    expect(chance.textContent).not.toContain(t("en").noData);
  });

  it("counts the hours to the reading, not to now", async () => {
    stubNotUpdating();
    ageArtifact(90); // to now it would be 31 h
    await renderLocated();
    expect(rowFor(NAME).textContent).toContain(
      fillTemplate(t("en").unchangedForTemplate, { n: 30 }),
    );
  });

  it("lets a fresher grid's forecast win over a stale lots.json", async () => {
    stubNotUpdating(72);
    await renderLocated();
    const chance = within(rowFor(NAME)).getByTestId("lot-probability");
    expect(chance.textContent).toContain("72%");
    expect(chance.textContent).not.toContain(t("en").notUpdating);
  });

  it("still says 'no data' for a lot with no forecast and no last update", async () => {
    await renderLocated();
    const chance = within(rowFor(NAME)).getByTestId("lot-probability");
    expect(chance.textContent).toContain(t("en").noData);
    expect(chance.textContent).not.toContain(t("en").notUpdating);
  });

  it("says it in Chinese too", async () => {
    Object.defineProperty(navigator, "language", { value: "zh-TW", configurable: true });
    stubNotUpdating();
    stubGeolocation("granted");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: t("zh").useMyLocation }));
    await screen.findByTestId("lot-list");
    const row = rowFor(NAME);
    expect(within(row).getByTestId("lot-probability").textContent).toContain("資料未更新");
    expect(row.textContent).toContain("已 30 小時未變動");
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

    // Said in the notice the user reads, and again in the live region that
    // announces it -- hence the testid rather than a text lookup.
    expect((await screen.findByTestId("geo-unavailable")).textContent).toBe(
      t("en").locationUnavailable,
    );
    // No spinner left behind, and the user can try again. The button is an icon
    // now, so its state is in its accessible name.
    expect(screen.queryByRole("button", { name: t("en").locating })).toBeNull();
    const retry = screen.getByRole("button", { name: t("en").locationUnavailable });
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("heading", { name: t("en").appName })).toBeDefined();
  });

  it("shows the unavailable string when the browser has no geolocation at all", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
    await screen.findByTestId("geo-unavailable");
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

    await screen.findByTestId("geo-unavailable");
    const retry = screen.getByRole("button", { name: t("en").locationUnavailable });
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(retry.getAttribute("aria-busy")).toBe("false");
  });

  it("does not take back a location it already found when the deadline passes", async () => {
    useDrivableFakeTimers();
    await renderLocated();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GEO_WATCHDOG_MS * 2);
    });

    expect(screen.queryByTestId("geo-unavailable")).toBeNull();
    expect(screen.getByTestId("lot-list")).toBeDefined();
  });
});

describe("staleness", () => {
  it("reports the age of the reading, from baseDataTs", async () => {
    render(<App />);
    const line = await screen.findByTestId("staleness");
    expect(line.textContent).toContain("data from 4 min ago");
    // Four minutes is not an expiry, and the badge must not say it is.
    expect(line.textContent).not.toContain(t("en").expired);
  });
});

describe("arrival time", () => {
  it("offers every clock time the grid actually holds, and opens on the default", async () => {
    render(<App />);
    // The strip's times are read off the grid's own header -- five minutes out
    // through the last column it forecasts -- so a grid built at a different
    // resolution, or an older reading, moves the strip instead of leaving its
    // far end pointing at a column that does not exist.
    const strip = await screen.findByRole("radiogroup", { name: t("en").arrivalGroupLabel });
    expect(within(strip).getAllByRole("radio").length).toBeGreaterThan(0);
    expect(chipTimes()).toEqual(arrivalOptions(NOW_SEC, GRID_SPAN).map(formatClock));

    // ...and the one it opens on is a real arrival time, not a horizon index.
    const checked = screen.getByRole("radio", { checked: true });
    expect(checked.textContent).toBe(formatClock(defaultArrival(NOW_SEC)));
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
    stubColumnMarkedArtifacts();
    ageArtifact(AGE_MIN);

    await renderLocated();

    // The strip offers a clock time; the column behind it is measured from the
    // *reading*, so the artifact's age is already inside the number.
    const column = columnFor(defaultArrival(nowSec()));
    const chance = within(rowFor(MARKED.n)).getByTestId("lot-probability");
    expect(chance.textContent).toContain(`${columnMark(column)}%`);
    // Not the column that same clock time would name if the age were ignored:
    // that one forecasts ten minutes before the driver arrives.
    expect(chance.textContent).not.toContain(`${columnMark(column - AGE_MIN / STEP_MIN)}%`);
  });

  it("moves the column it reads as the artifact ages, for one unchanged request", async () => {
    stubColumnMarkedArtifacts();
    ageArtifact(0);
    await renderLocated();
    const freshColumn = columnFor(defaultArrival(nowSec()));
    const fresh = within(rowFor(MARKED.n)).getByTestId("lot-probability").textContent;

    cleanup();
    stubColumnMarkedArtifacts();
    ageArtifact(20);
    await renderLocated();
    const staleColumn = columnFor(defaultArrival(nowSec()));
    const stale = within(rowFor(MARKED.n)).getByTestId("lot-probability").textContent;

    expect(fresh).toContain(`${columnMark(freshColumn)}%`);
    expect(stale).toContain(`${columnMark(staleColumn)}%`);
    // Twenty minutes of age is four columns of correction, for a driver asking
    // for the same lead time both times.
    expect(staleColumn - freshColumn).toBe(20 / STEP_MIN);
  });

  it("leaves the control offering the arrival times the user picks", async () => {
    // The correction is applied to the grid read, never to the label: the user
    // still chooses a real clock time, and a 23-minute-old reading does not
    // quietly move the chip they picked 23 minutes later.
    ageArtifact(23);
    render(<App />);
    await screen.findByRole("radiogroup", { name: t("en").arrivalGroupLabel });

    const at = nowSec();
    expect(chipTimes()).toEqual(arrivalOptions(at, GRID_SPAN).map(formatClock));
    expect(screen.getByRole("radio", { checked: true }).textContent).toBe(
      formatClock(defaultArrival(at)),
    );
  });

  it("keeps the far end of the strip a real answer rather than a clamp", async () => {
    // `arrivalOptions` stops at the last clock time the grid still forecasts,
    // instead of offering one `probabilityAt` would have to clamp. So the
    // furthest chip a driver can pick reads its own column -- not the last
    // column standing in for a time nobody asked for, and not "no data".
    stubColumnMarkedArtifacts();
    ageArtifact(30);
    await renderLocated();

    const chips = screen.getAllByRole("radio");
    const furthest = arrivalOptions(nowSec(), GRID_SPAN).at(-1)!;
    expect(chips.at(-1)?.textContent).toBe(formatClock(furthest));

    fireEvent.click(chips.at(-1)!);

    const chance = within(rowFor(MARKED.n)).getByTestId("lot-probability");
    expect(chance.textContent).toContain(`${columnMark(columnFor(furthest))}%`);
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

  it("keeps its request rate bounded when every fetch fails for an hour", async () => {
    useDrivableFakeTimers();
    render(<App />);
    await screen.findByTestId("staleness");
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls++;
      return Promise.reject(new Error("offline"));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });

    // One refresh per REFRESH_MS asks for both files; a failure must never trigger a retry loop.
    expect(calls).toBeLessThanOrEqual(2 * Math.ceil((60 * 60 * 1000) / REFRESH_MS) + 2);
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

  it("refuses a forecast dated in the future instead of calling it fresh", async () => {
    const grid = makeGrid();
    // base_data_ts sits at header offset 9; an hour ahead of the frozen clock.
    new DataView(grid).setUint32(9, BASE_DATA_TS + 3600, true);
    stubFetch(grid);
    render(<App />);
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByTestId("staleness")).toBeNull();
  });
});

/**
 * The forecast has an expiry, and the app has to say so.
 *
 * The staleness correction pushes every arrival time the user can pick towards
 * the end of the grid as the reading ages. Once even the *nearest* one clamps to
 * the last column, they all do: the strip becomes a control that changes
 * nothing while the screen shows one answer for a time nobody asked for. Found
 * with a 383-minute-old artifact, and guaranteed to recur: the collector stops
 * whenever its machine sleeps while the published copy stays up and goes on
 * ageing.
 *
 * The boundary is the point of the two tests at the bottom. It is *not* the
 * grid's span: at the shipped geometry the strip goes inert at an age of 113
 * minutes, eight before the span runs out at 121.
 */
describe("an artifact older than the grid it came from", () => {
  /** The 383 minutes actually observed while verifying the arrival control. */
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
    expect(factText(within(row).getByTestId("lot-price"))).toBe(`NT$50 ${t("en").perEntry}`);
    expect(within(row).getByTestId("lot-walk").textContent).toContain(t("en").walkTile);
    expect(screen.getByTestId("lot-list")).toBeInTheDocument();
    // ...and the age is still reported, which is how the user can tell why --
    // now with the word for what has happened to it, not just a big number.
    const badge = screen.getByTestId("staleness");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain(t("en").expired);
  });

  it("stops the heading claiming an order the forecast no longer supports", async () => {
    ageArtifact(OBSERVED_AGE_MIN);
    await renderLocated();
    expect(screen.getByText(t("en").nearbyCarParks)).toBeInTheDocument();
    expect(screen.queryByText(t("en").rankedForArrival)).toBeNull();
  });

  it("renders no arrival chips rather than leave a control that does nothing", async () => {
    ageArtifact(OBSERVED_AGE_MIN);
    await renderLocated();
    // Not a disabled strip and not a strip of identical answers: there is no
    // arrival time left that this grid forecasts, so there is none to offer.
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.getByTestId("arrival-time").textContent).not.toMatch(/\d/);
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
    // span test called this live, so the strip was offering chips and the
    // heading claimed an order over 24 identical clamped columns.
    ageArtifact(LAST_LIVE_AGE_MIN + 1);
    await renderLocated();

    expect(screen.getByTestId("forecast-expired").textContent).toBe(t("en").forecastTooOld);
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.getByText(t("en").nearbyCarParks)).toBeInTheDocument();
    for (const cell of screen.getAllByTestId("lot-probability")) {
      expect(cell.textContent).not.toMatch(/\d+%/);
    }
  });

  it("leaves a grid alone while an arrival time still has a column of its own", async () => {
    // One minute earlier, and the forecast is not a decoration: the last
    // arrival time the grid reaches is still offered, and it reads its own
    // column rather than the clamped last one -- the documented trade, not an
    // expiry.
    stubColumnMarkedArtifacts();
    ageArtifact(LAST_LIVE_AGE_MIN);
    await renderLocated();

    expect(screen.queryByTestId("forecast-expired")).toBeNull();
    expect(screen.getByText(t("en").rankedForArrival)).toBeInTheDocument();

    const offered = arrivalOptions(nowSec(), GRID_SPAN);
    expect(chipTimes()).toEqual(offered.map(formatClock));
    expect(offered.length).toBeGreaterThan(0);

    const chance = within(rowFor(MARKED.n)).getByTestId("lot-probability").textContent;
    expect(chance).toContain(`${columnMark(columnFor(offered.at(-1)!))}%`);
    // ...and not the grid's last column, which is what a clamp would have said.
    expect(chance).not.toContain(`${columnMark(N_HORIZONS - 1)}%`);
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
 * question a driver actually has. This searches the roster already in memory,
 * plus a place index fetched once from this app's own origin -- no geocoder, no
 * key, no third-party origin, and the destination never leaves the phone.
 * `places.test.ts` and `placeSearch.test.tsx` cover the matching and the
 * combobox; these cover the wiring, and the wiring is where the interesting
 * failure is: a second destination path.
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
    return screen.getByRole("combobox", { name: t("en").searchLabel }) as HTMLInputElement;
  }

  async function renderSearchable(): Promise<HTMLInputElement> {
    stubSearchable();
    render(<App />);
    await screen.findByRole("combobox", { name: t("en").searchLabel });
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
    expect(screen.getByText(t("en").startPromptMap)).toBeInTheDocument();
    expect(screen.queryByTestId("lot-list")).toBeNull();

    type("北投");
    expect(optionIds()).toEqual(["TPE_BEITOU"]);
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(await screen.findByTestId("lot-list")).toBeInTheDocument();
    // The chosen car park is where the driver is going, so it is 0 m away.
    expect(firstRankedId()).toBe("TPE_BEITOU");
    expect(screen.queryByText(t("en").startPromptMap)).toBeNull();
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
    expect(firstRankedId()).not.toBe("TPE_BEITOU");
    // TPE_ENTRY is the car park that was searched for and is zero metres away,
    // and it still does not win: at P=45% it is a coin flip that loses more
    // often than not, while TPE_RANGE is 16 points likelier for one minute's
    // walk and NT$10. Expected trip cost 95.4 against 101.2. Before the failure
    // branch was modelled this went the other way, on the strength of the zero
    // walk alone -- which is the whole reason the model changed.
    expect(firstRankedId()).toBe("TPE_RANGE");
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
    // The option Enter took is the destination, and -- because a car park is a
    // lot as well as a place -- the card the map is showing. Asserted on the
    // selection rather than on first place: three of these five car parks are
    // within fifty metres of each other, so which one the *ranking* puts first
    // is a question about the cost model, not about the keyboard.
    const chosen = screen
      .getAllByTestId("lot-row")
      .find((el) => el.getAttribute("data-lot-id") === offered[1]);
    expect(chosen).toBeDefined();
    expect(chosen).toHaveClass("lot-card--selected");
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

  it("makes no request beyond the one place-index fetch", async () => {
    // The whole reason there is no geocoder here. The index is one static file
    // from this app's own origin, fetched once when the box is first focused;
    // after that, typing a destination asks the network for nothing at all. If
    // this ever fails, the driver's destination started leaving the phone.
    await renderSearchable();
    const seen = new Set(fetchMock.mock.calls.map(([url]) => String(url)));

    fireEvent.focus(box());
    for (const query of ["1", "10", "101", "USPACE", "市政府", "台北北投", "北投"]) type(query);
    fireEvent.keyDown(box(), { key: "Enter" });
    await screen.findByTestId("lot-list");

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    const places = urls.filter((url) => url.endsWith("places/taipei.json"));
    // Once, on the first focus -- not per keystroke, and not never either: the
    // index is what lets the box find anything that is not a car park.
    expect(places.length).toBe(1);
    // ...and nothing else: every other request is one the artifacts had already
    // made before a key was pressed.
    expect(urls.filter((url) => !places.includes(url)).every((url) => seen.has(url))).toBe(true);
  });

  it("names the car parks in Chinese and the districts in the reader's language", async () => {
    await renderSearchable();
    type("北投");
    const option = screen.getByTestId("search-option");
    // The name matches the signage, in either UI language...
    expect(option.textContent).toContain("臺北北投溫泉停車場");
    // ...while the district beside it -- one of the feed's twelve, a closed set
    // this app translates everywhere else it shows one -- is read in the
    // reader's own language.
    expect(option.querySelector(".search__option-where")?.textContent).toContain("Beitou District");

    fireEvent.click(screen.getByRole("button", { name: "切換為中文" }));
    await screen.findByRole("button", { name: t("zh").useMyLocation });

    expect(screen.getByText(t("zh").searchHint)).toBeInTheDocument();
    const zhBox = screen.getByRole("combobox", { name: t("zh").searchLabel });
    fireEvent.change(zhBox, { target: { value: "北投" } });
    const zhOption = screen.getByTestId("search-option");
    expect(zhOption.textContent).toContain("臺北北投溫泉停車場");
    expect(zhOption.querySelector(".search__option-where")?.textContent).toContain("北投區");
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
/**
 * Both layouts are binding (spec §2), and every other test in this file renders
 * the phone -- jsdom answers `false` to `(min-width: 768px)` unless a test says
 * otherwise, which is exactly how the desktop arrangement could rot unnoticed.
 * One render of the other branch, asserting the swap `Shell` actually makes:
 * the side panel instead of the sheet, with the search inside it rather than in
 * a top bar that does not exist up there.
 */
describe("the desktop layout", () => {
  /** Reduced motion as everywhere else in this file, plus a desktop-width viewport. */
  function stubDesktop() {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") || query.includes("min-width: 768px"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  }

  it("puts the search in a side panel and mounts no bottom sheet", async () => {
    stubDesktop();
    render(<App />);
    await screen.findByTestId("staleness");

    const panel = screen.getByTestId("panel");
    expect(within(panel).getByRole("combobox", { name: t("en").searchLabel })).toBeInTheDocument();
    // The sheet and its grip are the phone's; up here there is nothing to drag.
    expect(screen.queryByTestId("sheet")).toBeNull();
    expect(screen.queryByRole("button", { name: t("en").expandList })).toBeNull();
    expect(screen.queryByRole("button", { name: t("en").collapseList })).toBeNull();
  });
});

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
