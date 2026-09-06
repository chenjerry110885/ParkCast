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
 * `fetch` and `navigator.geolocation` are the only two stubs: the artifacts are
 * built as real bytes and go through the real `loadArtifacts`, so the parse,
 * the roster pairing and the ranking are all exercised as shipped.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { GEO_WATCHDOG_MS, REFRESH_MS } from "../src/App";
import { HEADER_SIZE, UNKNOWN } from "../src/artifacts";
import { t } from "../src/i18n";
import type { Lot, LotsDoc } from "../src/types";

const ROSTER_ID = 4242;
const N_HORIZONS = 24;
const STEP_MIN = 5;
/** Matches the fixture header below, so the staleness line is deterministic. */
const BASE_DATA_TS = 1788677280;

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

/** The row whose lot name is `name`. Names are Chinese in both languages. */
function rowFor(name: string): HTMLElement {
  const heading = screen.getByText(name);
  const row = heading.closest("li");
  if (row === null) throw new Error(`no row rendered for ${name}`);
  return row;
}

beforeEach(() => {
  stubFetch();
  // A fixed clock, so the staleness line is a fact rather than a race. Spying
  // on `Date.now` rather than faking timers: the component's clock interval is
  // not under test, and fake timers would put it in the way of every `findBy`.
  vi.spyOn(Date, "now").mockReturnValue((BASE_DATA_TS + 4 * 60) * 1000);
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
    const select = (await screen.findByLabelText(t("en").arrivingIn)) as HTMLSelectElement;
    expect(select.options.length).toBe(N_HORIZONS);
    expect(select.options[0]?.value).toBe(String(STEP_MIN));
    expect(select.options[N_HORIZONS - 1]?.value).toBe(String(N_HORIZONS * STEP_MIN));
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
  /** Column `c` reads `(c + 1) * 4`%, so every column is a distinct percentage. */
  const columnMark = (column: number) => (column + 1) * 4;

  const MARKED = LOTS[0]!;

  /** One lot whose 24 columns are all different, so the row names its column. */
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
    const select = (await screen.findByLabelText(t("en").arrivingIn)) as HTMLSelectElement;
    expect(select.options.length).toBe(N_HORIZONS);
    expect(select.options[0]?.value).toBe(String(STEP_MIN));
    expect(select.options[N_HORIZONS - 1]?.value).toBe(String(N_HORIZONS * STEP_MIN));
    expect(select.value).toBe("15");
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
