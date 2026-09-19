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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, {
  COVERAGE_RADIUS_M,
  GEO_WATCHDOG_MS,
  LIST_LIMIT,
  MIN_REFETCH_MS,
  REFRESH_MS,
} from "../src/App";
import {
  arrivalOptions,
  ceilToStep,
  composeArrival,
  dayOptions,
  defaultArrival,
  floorToStep,
  formatClock,
  horizonFromReading,
} from "../src/arrival";
import { HEADER_SIZE, UNKNOWN, horizonColumn, resetWeekCache } from "../src/artifacts";
import { WEEKLY_OBSERVATIONS } from "../src/confidence";
import { EARTH_RADIUS_M, haversineMeters } from "../src/geo";
import { fillTemplate, t } from "../src/i18n";
import { resetPlaceIndexCache } from "../src/places";
import { NEARBY_RADIUS_M } from "../src/rank";
import type { Grid, Lot, LotsDoc } from "../src/types";
import { weekBucket } from "../src/week";

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

/**
 * What `/artifacts/week.bin` answers with. `null` is the Worker's own 503 for
 * a table that has never been uploaded (`serveWeek`), and it is the **default**
 * for every test in this file: the week table is fetched lazily, so a test that
 * is not about it must be able to prove that by never being served one. A
 * function is evaluated per request, for the tests that need the second attempt
 * to answer differently from the first -- and it may return a promise, for the
 * one that needs a request still to be in the air while the picker moves.
 */
type WeekStub = ArrayBuffer | null | (() => ArrayBuffer | null | Promise<ArrayBuffer | null>);

function stubFetch(grid: ArrayBuffer = makeGrid(), lots: LotsDoc = makeLotsDoc(), week: WeekStub = null) {
  fetchMock = vi.fn((url: string) => {
    if (url.endsWith("grid.bin")) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(grid) });
    }
    if (url.endsWith("week.bin")) {
      return Promise.resolve(typeof week === "function" ? week() : week).then((table) =>
        table === null
          ? { ok: false, status: 503 }
          : { ok: true, status: 200, arrayBuffer: () => Promise.resolve(table) },
      );
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

/** How many times `week.bin` has been requested since the stub was installed. */
function weekFetchCount(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("week.bin")).length;
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
 * Shared by the three describes that need to see *which* column was read: the
 * staleness correction, the expiry that fires when there is only one column
 * left to read, and the week table, whose whole job is to be read *instead of*
 * the last of those columns.
 */
function stubColumnMarkedArtifacts({ lot = MARKED, week = null }: { lot?: Lot; week?: WeekStub } = {}) {
  const body = Array.from({ length: N_HORIZONS }, (_unused, c) => columnMark(c));
  stubFetch(
    encodeGrid(body, 1),
    {
      v: 1,
      generated_at: BASE_DATA_TS + 213,
      base_data_ts: BASE_DATA_TS,
      n_lots: 1,
      roster_id: ROSTER_ID,
      lots: [lot],
    },
    week,
  );
}

/** `week.bin`'s header: `<4sBIHHBI`, no padding, mirroring `web/src/week.ts`. */
const WEEK_HEADER_SIZE = 18;
/** `7 * 24 * 60 / 30`, the only bucket geometry `parseWeek` accepts. */
const WEEK_BUCKETS = 336;

/**
 * A single-lot `week.bin` with one bucket worth telling apart from the rest.
 *
 * `marked` is written into `bucket` alone and `filler` into all 335 others, so
 * a reader that lands on the wrong half-hour of the week -- the reading's own
 * rather than the arrival's, say -- renders `filler`'s percentage and is caught
 * by value rather than passing on a number that happened to be plausible.
 *
 * The bytes are laid out here by hand rather than generated from `week.ts`,
 * exactly as `encodeGrid` above is: a fixture built by the code under test can
 * only ever prove the client agrees with itself. Cross-language layout
 * agreement with the Python encoder is `seam.test.ts`'s job, against bytes
 * `artifacts.encode_week` actually wrote.
 */
function encodeWeek(
  bucket: number,
  marked: { percent: number; support: number },
  filler: { percent: number; support: number },
  rosterId: number = ROSTER_ID,
  nLots = 1,
): ArrayBuffer {
  const buf = new ArrayBuffer(WEEK_HEADER_SIZE + nLots * WEEK_BUCKETS * 2);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(new TextEncoder().encode("PCW1"), 0);
  dv.setUint8(4, 1);
  dv.setUint32(5, BASE_DATA_TS - 3600, true); // builtTs: rebuilt daily, not per tick
  dv.setUint16(9, nLots, true);
  dv.setUint16(11, WEEK_BUCKETS, true);
  dv.setUint8(13, 30); // bucketMin
  dv.setUint32(14, rosterId, true);
  // Row-major, lot then bucket, matching `probabilityAt`'s
  // `(lotIndex * N_BUCKETS + bucket) * 2`. Every lot gets the same pair, which
  // is all the multi-lot callers need: they are about which *card* says what,
  // not about telling two lots' climatologies apart.
  for (let lot = 0; lot < nLots; lot += 1) {
    for (let b = 0; b < WEEK_BUCKETS; b += 1) {
      const cell = b === bucket ? marked : filler;
      const at = WEEK_HEADER_SIZE + (lot * WEEK_BUCKETS + b) * 2;
      bytes[at] = cell.percent;
      bytes[at + 1] = cell.support;
    }
  }
  return buf;
}

/**
 * The far-arrival fixture, shared by the two describes that read `week.bin`:
 * the one where the reading is fresh and the arrival is simply out of the
 * grid's reach, and the one where the reading has also expired. Both ask the
 * same question of the same table, and a second copy of these numbers would be
 * a second place for the marked bucket and the filler to drift apart.
 */

/** The climatology in the arrival's own half-hour bucket. */
const FAR_PERCENT = 73;
/** ...and in all 335 others, so a lookup on the wrong bucket is caught by value. */
const OTHER_PERCENT = 20;
/** Five weeks of this half-hour: enough for `confidenceFor`'s support-led "high". */
const FAR_SUPPORT = 5 * WEEKLY_OBSERVATIONS;

/** What the grid's clamp says for every arrival past two hours. Never a right answer out here. */
const CLAMPED = `${columnMark(N_HORIZONS - 1)}%`;

/**
 * The marked lot with an observed count, so `blend`'s persistence term has a
 * reading to decay from -- `MARKED` itself publishes no `f`, which would make
 * every number out here pure climatology and hide a missing blend.
 */
const OBSERVED_LOT: Lot = { ...MARKED, f: 5 };

/** Tomorrow 21:20 Taipei: the case the user complained about, and 1,832 min from the reading. */
function tomorrowEvening(): number {
  return composeArrival(dayOptions(nowSec())[1]!.daySec, 21, 20);
}

/** A `week.bin` whose marked bucket is the one `ts` falls in. */
function weekFor(ts: number, support = FAR_SUPPORT): ArrayBuffer {
  // `weekBucket` is the client's own indexer, which makes this a wiring test
  // and not a second statement of the bucket arithmetic: that the client's
  // buckets agree with Python's is `seam.test.ts`'s job, against bytes the
  // Python encoder wrote. What this pins is that `App` looks the lot up at
  // the *arrival's* time of week rather than the reading's, which is visible
  // here because the two land in different buckets (234 and 173).
  return encodeWeek(weekBucket(ts), { percent: FAR_PERCENT, support }, { percent: OTHER_PERCENT, support: 0 });
}

/** The one rendered lot's probability cell, for the single-lot column-marked fixture. */
function chance(): string {
  return screen.getByTestId("lot-probability").textContent ?? "";
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

/**
 * Drive the arrival picker's day, hour and minute `<select>`s to `ts`, the way
 * a user reaches a specific arrival time now that there is no chip to click for
 * it directly.
 *
 * The day is set first and from `dayOptions` -- the same list the picker itself
 * renders -- because `onDayChange` carries the current hour and minute across,
 * so setting it after them would throw the pair away. For a `ts` already on the
 * selected day the `<select>`'s value does not move and React fires nothing,
 * which is why every test written before the seven-day picker existed still
 * reads the same.
 */
function selectArrival(ts: number) {
  const day = dayOptions(nowSec()).find((d) => d.daySec <= ts && ts < d.daySec + 24 * 3600);
  if (day === undefined) throw new Error(`no day option contains ${ts}`);
  const [hh, mm] = formatClock(ts).split(":");
  fireEvent.change(screen.getByLabelText(t("en").pickerDay), { target: { value: String(day.daySec) } });
  fireEvent.change(screen.getByLabelText(t("en").pickerHour), { target: { value: String(Number(hh)) } });
  fireEvent.change(screen.getByLabelText(t("en").pickerMinute), { target: { value: String(Number(mm)) } });
}

beforeEach(() => {
  stubFetch();
  // The place index is cached per URL for the life of the module, and recent
  // picks live in `localStorage`; both would otherwise leak from one test into
  // the next and decide what the search box offers. `week.bin` is cached the
  // same way and for the same reason -- one fetch per session, not per render
  // -- so a table one test served would otherwise still be in memory for the
  // next, and "was it fetched?" would stop meaning anything.
  resetPlaceIndexCache();
  resetWeekCache();
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

  /**
   * The standard fixture with one lot marked not updating, `cell` being that
   * lot's own grid row.
   *
   * `stalledId` defaults to the unpriced lot, which is what every test written
   * before the best-pick rule uses. Passing another id moves the stall; passing
   * an id no lot has (see `STALL_NOBODY`) marks none, which is how the control
   * case for the ranking tests below gets the same fixture with live feeds.
   */
  const STALL_NOBODY = "TPE_NONE_OF_THEM";
  function stubNotUpdating(cell: number = UNKNOWN, week: WeekStub = null, stalledId = "TPE_UNPRICED") {
    const lots = LOTS.map((lot) => (lot.id === stalledId ? { ...lot, u: LAST_UPDATE } : lot));
    const perLot = [88, 61, 45, UNKNOWN];
    const body: number[] = [];
    for (const lot of lots) {
      const value = lot.id === stalledId ? cell : (perLot[lot.i] ?? UNKNOWN);
      for (let h = 0; h < N_HORIZONS; h += 1) body.push(value);
    }
    stubFetch(encodeGrid(body, lots.length), { ...makeLotsDoc(), lots }, week);
  }

  /** The whole roster's climatology, so a far arrival has a number for every card. */
  const FAR_CLIMATOLOGY = 73;
  function weekForRoster(ts: number): ArrayBuffer {
    return encodeWeek(
      weekBucket(ts),
      { percent: FAR_CLIMATOLOGY, support: 30 },
      { percent: 20, support: 0 },
      ROSTER_ID,
      LOTS.length,
    );
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
    const row = rowFor(NAME);
    const chance = within(row).getByTestId("lot-probability");
    expect(chance.textContent).toContain("72%");
    expect(chance.textContent).not.toContain(t("en").notUpdating);
    // Nowhere else on the card either. The grid is built from the same reading
    // `u` is measured to, so a number in it is direct evidence this lot moved
    // and the stale `u` is the older file being wrong. That is the half of the
    // rule a week-sourced number must NOT inherit -- see the far-arrival test
    // at the bottom of this describe.
    expect(within(row).queryByTestId("lot-stalled")).toBeNull();
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

  it("still says so at an arrival answered from the week table, and keeps the number", async () => {
    // Two independent facts, and the driver is owed both. The climatology for
    // tomorrow at 21:20 is a real answer -- it is what this car park usually
    // has free at that hour, and it does not depend on a recent reading. This
    // lot's own feed stopped 30 hours before the reading, and that is still
    // true. `notUpdatingHours` used to drop the second the moment the first
    // existed, on a rationale written for the grid: a *grid* number proves the
    // lot moved, a week number proves nothing of the kind. So out here a dead
    // car park rendered as a bare confident percentage that said nothing.
    const far = tomorrowEvening();
    stubNotUpdating(UNKNOWN, weekForRoster(far));
    await renderLocated();

    selectArrival(far);
    await waitFor(() =>
      expect(within(rowFor(NAME)).getByTestId("lot-probability").textContent).toContain(`${FAR_CLIMATOLOGY}%`),
    );

    const row = rowFor(NAME);
    // The number is kept -- suppressing it would throw away a good answer...
    expect(within(row).getByTestId("lot-probability").textContent).toContain(`${FAR_CLIMATOLOGY}%`);
    // ...and the card says the feed has stopped, in words and in hours, among
    // the lot's own facts rather than as a hedge on the forecast.
    const stalled = within(row).getByTestId("lot-stalled");
    expect(stalled.textContent).toContain(t("en").notUpdating);
    expect(stalled.textContent).toContain(fillTemplate(t("en").unchangedForTemplate, { n: 30 }));

    // A lot whose feed is fine says nothing of the kind at the same arrival:
    // this is per-lot, and must not become a property of the arrival.
    const healthy = rowFor("市府路一號停車場");
    expect(within(healthy).getByTestId("lot-probability").textContent).toContain(`${FAR_CLIMATOLOGY}%`);
    expect(within(healthy).queryByTestId("lot-stalled")).toBeNull();

    // ...and back inside the grid's window, where the ring itself carries the
    // words, the card still says it. The near path is unchanged.
    selectArrival(ceilToStep(nowSec() + 30 * 60));
    const near = rowFor(NAME);
    expect(within(near).getByTestId("lot-probability").textContent).toContain(t("en").notUpdating);
    expect(within(near).getByTestId("lot-stalled").textContent).toContain(
      fillTemplate(t("en").unchangedForTemplate, { n: 30 }),
    );
  });

  it("says so during a stale period too, which is when this collector is paused", async () => {
    // The state 10b opened up: the reading has expired, so a near arrival is
    // withheld and a far one is answered from history. A dead lot must say so
    // in both halves -- this is about one car park's feed, never about the
    // global reading, and the two must not be allowed to merge.
    ageArtifact(383);
    const far = tomorrowEvening();
    stubNotUpdating(UNKNOWN, weekForRoster(far));
    await renderLocated();

    // Near, and withheld: no number at all, and the ring carries the words.
    expect(within(rowFor(NAME)).getByTestId("lot-probability").textContent).toContain(t("en").notUpdating);
    expect(within(rowFor(NAME)).getByTestId("lot-stalled").textContent).toContain(
      fillTemplate(t("en").unchangedForTemplate, { n: 30 }),
    );

    selectArrival(far);
    await waitFor(() =>
      expect(within(rowFor(NAME)).getByTestId("lot-probability").textContent).toContain(`${FAR_CLIMATOLOGY}%`),
    );
    const stalled = within(rowFor(NAME)).getByTestId("lot-stalled");
    expect(stalled.textContent).toContain(t("en").notUpdating);
    expect(stalled.textContent).toContain(fillTemplate(t("en").unchangedForTemplate, { n: 30 }));
  });

  /* ---------------------------------------------------------------- *
   * ...and the recommendation, which is a different question from the
   * number. `week.bin` carries no `liveness.Withholding` -- deliberately,
   * because what a car park usually has free at 21:20 does not depend on
   * whether its feed answered today -- so past the grid's window a dead lot
   * carries a full climatology figure. That figure is honest. Crowning it
   * "Best pick", top of the list, with no confidence pill beside it, is not:
   * a car park nobody has heard from in thirty hours may simply be closed.
   * See `rank.ts`'s `group` and `App.tsx`'s `bestId`.
   *
   * The entry-fee lot is the fixture's cheapest, and every lot here reads the
   * same climatology at this arrival, so it is the one the ranker crowns --
   * which is exactly what makes it the useful one to kill the feed on. The
   * control case below is what stops these from passing vacuously.
   * ---------------------------------------------------------------- */
  const CHEAPEST = LOTS[2]!;

  /** The lot ids of the rendered rows, in the order the list draws them. */
  function rankedIds(): (string | null)[] {
    return screen.getAllByTestId("lot-row").map((el) => el.getAttribute("data-lot-id"));
  }

  it("crowns the cheapest lot at a far arrival while its feed is alive", async () => {
    const far = tomorrowEvening();
    stubNotUpdating(UNKNOWN, weekForRoster(far), STALL_NOBODY);
    await renderLocated();

    selectArrival(far);
    await waitFor(() =>
      expect(within(rowFor(CHEAPEST.n)).getByTestId("lot-probability").textContent)
        .toContain(`${FAR_CLIMATOLOGY}%`),
    );

    expect(rankedIds()[0]).toBe(CHEAPEST.id);
    expect(within(rowFor(CHEAPEST.n)).getByText(t("en").bestPick)).toBeInTheDocument();
  });

  it("takes the 'Best pick' badge off that same lot once its feed stops, and keeps its number", async () => {
    const far = tomorrowEvening();
    stubNotUpdating(UNKNOWN, weekForRoster(far), CHEAPEST.id);
    await renderLocated();

    selectArrival(far);
    await waitFor(() =>
      expect(within(rowFor(CHEAPEST.n)).getByTestId("lot-probability").textContent)
        .toContain(`${FAR_CLIMATOLOGY}%`),
    );
    const row = rowFor(CHEAPEST.n);

    // The number stays. Suppressing it would throw away a real answer to fix a
    // presentation problem, and the card already says the feed has stopped.
    expect(within(row).getByTestId("lot-probability").textContent).toContain(`${FAR_CLIMATOLOGY}%`);
    expect(within(row).getByTestId("lot-stalled").textContent).toContain(t("en").notUpdating);
    // The row stays too -- a missing car park is invisible, an honest one is not.
    expect(rankedIds()).toContain(CHEAPEST.id);

    // What goes is the endorsement: no badge on this card...
    expect(within(row).queryByText(t("en").bestPick)).toBeNull();
    // ...exactly one elsewhere, on a car park we have actually heard from...
    const badges = screen.getAllByText(t("en").bestPick);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.closest("li")).not.toBe(row);
    // ...and it sinks below every lot that still has a live feed. All four
    // read the same climatology here, so nothing but the demotion can move it.
    expect(rankedIds()[rankedIds().length - 1]).toBe(CHEAPEST.id);
    expect(rankedIds()[0]).toBe(badges[0]!.closest("li")!.getAttribute("data-lot-id"));
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
  it("opens on the default arrival, with a day/hour/minute picker for changing it", async () => {
    render(<App />);
    await screen.findByTestId("staleness");

    // The one it opens on is a real arrival time, not a horizon index.
    expect(screen.getByTestId("arrival-time").textContent).toBe(formatClock(defaultArrival(NOW_SEC)));

    // Three native selects, each reachable and named by its own label --
    // `getByLabelText` throws unless the `<label for>`/`id` pair the
    // component wires up actually resolves, so this fails if the
    // association breaks, not just if the select goes missing.
    const day = screen.getByLabelText(t("en").pickerDay) as HTMLSelectElement;
    const hour = screen.getByLabelText(t("en").pickerHour) as HTMLSelectElement;
    const minute = screen.getByLabelText(t("en").pickerMinute) as HTMLSelectElement;
    expect(day.tagName).toBe("SELECT");
    expect(hour.tagName).toBe("SELECT");
    expect(minute.tagName).toBe("SELECT");
    // The day list is not one entry: this is a seven-day picker, not the old
    // strip's two-hour one -- the complaint ("limiting the prediction to two
    // hours is weird") this control exists to answer.
    expect(day.options.length).toBeGreaterThan(1);

    // The four quick chips, each its own labelled, clickable button.
    for (const label of [t("en").quickNow, t("en").quickPlus15, t("en").quickPlus30, t("en").quickPlus1h]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("moves the reading forward when a quick chip is clicked, not dragged", async () => {
    render(<App />);
    await screen.findByTestId("staleness");
    const before = screen.getByTestId("arrival-time").textContent;

    fireEvent.click(screen.getByRole("button", { name: t("en").quickPlus1h }));

    const after = screen.getByTestId("arrival-time").textContent;
    expect(after).not.toBe(before);
    expect(after).toBe(formatClock(ceilToStep(NOW_SEC + 3600)));
  });

  it("does not change the selection when a pointer is dragged across the quick chips", async () => {
    // The strip this replaces used to let a drag sweep across its chips change
    // the selection, which on desktop made a row of buttons behave like a
    // slider nobody asked for. The chips here are plain buttons with only an
    // `onClick`, so there is nothing for a drag to hook into -- this pins that
    // by firing the drag's own events and nothing else.
    render(<App />);
    await screen.findByTestId("staleness");
    const before = screen.getByTestId("arrival-time").textContent;

    const first = screen.getByRole("button", { name: t("en").quickNow });
    const last = screen.getByRole("button", { name: t("en").quickPlus1h });
    fireEvent.pointerDown(first, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerMove(last, { clientX: 300, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(last, { clientX: 300, clientY: 10, pointerId: 1 });

    expect(screen.getByTestId("arrival-time").textContent).toBe(before);
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

  it("leaves the readout showing the time the user picked, not one stale-shifted by the reading's age", async () => {
    // The correction is applied to the grid read, never to the label: the user
    // still sees a real clock time, and a 23-minute-old reading does not
    // quietly move the arrival time shown 23 minutes later.
    ageArtifact(23);
    render(<App />);
    await screen.findByTestId("staleness");

    expect(screen.getByTestId("arrival-time").textContent).toBe(formatClock(defaultArrival(nowSec())));
  });

  it("reads a real column for a time still on the grid, not the clamp standing in past its end", async () => {
    // `probabilityAt` clamps a request off the grid to its last column rather
    // than failing (see `horizonColumn`'s own comment) -- the honest trade for
    // a time slightly beyond what the grid covers. This pins the *other* side
    // of that trade: a time the grid still genuinely reaches must read its own
    // column, not the clamp meant for times past it.
    stubColumnMarkedArtifacts();
    ageArtifact(30);
    await renderLocated();

    const last = arrivalOptions(nowSec(), GRID_SPAN).at(-1)!;
    selectArrival(last);

    const chance = within(rowFor(MARKED.n)).getByTestId("lot-probability");
    expect(chance.textContent).toContain(`${columnMark(columnFor(last))}%`);
    // ...and not the grid's very last column, which is what the clamp this
    // test is *not* exercising would have said instead.
    expect(chance.textContent).not.toContain(`${columnMark(N_HORIZONS - 1)}%`);
    expect(chance.textContent).not.toContain(t("en").noData);
  });
});

/**
 * Past the grid's last column, where `week.bin` is the only honest source.
 *
 * The picker offers seven days; `grid.bin` covers two hours. For the ~98.8% of
 * that range the grid cannot reach, `horizonColumn` clamps to column 23 -- the
 * +120-minute figure -- and every earlier version of this screen presented that
 * clamp as the answer for the time the driver actually asked about, with
 * `forecastExpired` false, the "ranked for your arrival" heading above it and a
 * confidence pill beside it. This describe is what makes that impossible to
 * reintroduce quietly.
 *
 * The grid fixture is the column-marked one, so the clamp has a value of its
 * own (`columnMark(23)`, 96%) that no other source in the fixture can produce.
 * Any test here that starts passing 96% is the regression.
 */
describe("an arrival beyond the grid's own window", () => {
  it("answers tomorrow evening from the week table, not from the grid's last column", async () => {
    // THE regression test. Without the week path this row reads 96% -- the
    // +120-minute column -- labelled as tomorrow's forecast.
    const far = tomorrowEvening();
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: weekFor(far) });
    await renderLocated();

    selectArrival(far);
    expect(screen.getByTestId("arrival-time").textContent).toBe("21:20");
    await waitFor(() => expect(chance()).toBe(`${FAR_PERCENT}%`));

    // At 1,832 minutes from the reading the blend's persistence weight is 4e-19,
    // so the number is this bucket's climatology to every digit shown -- and
    // emphatically not the grid's clamp, nor another bucket's climatology.
    expect(chance()).not.toContain(CLAMPED);
    expect(chance()).not.toContain(`${OTHER_PERCENT}%`);
  });

  it("says the number came out of the week table, so it cannot pass for a live reading", async () => {
    // The freshness badge reports the *reading* and nothing else, which on a
    // page answered from `week.bin` is a dateline for the wrong thing: "4 min
    // ago" beside a forecast for tomorrow evening reads as a claim about that
    // forecast. This line is the only place the page says which artifact
    // answered, and it tracks the artifact rather than the reading's age --
    // the source of the number is what it is describing.
    const far = tomorrowEvening();
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: weekFor(far) });
    await renderLocated();

    // Inside the window the grid answers, and there is nothing to disclaim.
    expect(screen.queryByTestId("from-history")).toBeNull();

    selectArrival(far);
    await waitFor(() => expect(chance()).toBe(`${FAR_PERCENT}%`));
    expect(screen.getByTestId("from-history").textContent).toBe(t("en").basedOnHistory);

    // ...and it goes away again the moment the grid takes the question back.
    selectArrival(ceilToStep(nowSec() + 30 * 60));
    expect(chance()).toBe(`${columnMark(columnFor(ceilToStep(nowSec() + 30 * 60)))}%`);
    expect(screen.queryByTestId("from-history")).toBeNull();
  });

  it("claims nothing about a number that is not there", async () => {
    // With no week table every cell out here reads "no data", and a line
    // saying where "these chances" came from would be describing an empty
    // list. The attribution is gated on the table being in hand, not on the
    // arrival being far.
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: null });
    await renderLocated();

    selectArrival(tomorrowEvening());
    await waitFor(() => expect(weekFetchCount()).toBe(1));
    expect(chance()).toContain(t("en").noData);
    expect(screen.queryByTestId("from-history")).toBeNull();
  });

  it("blends the live reading into the climatology just past the grid's edge", async () => {
    // +122 min from the reading: one step past the grid's 120-minute span, where
    // the persistence weight is still 0.5 ** (122/30) = 0.0597. So
    // 0.0597 * 1 + 0.9403 * 0.73 = 0.7461 -> 75%, which is neither the bare
    // climatology (73%) nor the grid's clamp (96%). A wiring that reached the
    // week table but dropped `blend`, or measured its horizon from the wall
    // clock instead of `baseDataTs`, lands on a different number than this.
    const justPast = BASE_DATA_TS + 122 * 60;
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: weekFor(justPast) });
    await renderLocated();

    selectArrival(justPast);
    await waitFor(() => expect(chance()).toBe("75%"));
    expect(chance()).not.toBe(`${FAR_PERCENT}%`);
    expect(chance()).not.toContain(CLAMPED);
  });

  it("says 'no data' when the week table is unavailable, never the grid's last column", async () => {
    // The Worker answers 503 until the collector has uploaded a table, and a
    // fetch can simply fail. Either way the honest answer for a time nothing
    // covers is silence -- never the clamp standing in for it.
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: null });
    await renderLocated();

    selectArrival(tomorrowEvening());
    await waitFor(() => expect(weekFetchCount()).toBe(1));
    expect(chance()).toContain(t("en").noData);
    expect(chance()).not.toMatch(/\d+%/);
    // No forecast means no grade either: a pill over "no data" would be a claim
    // about a number that is not there.
    expect(screen.queryByRole("button", { name: /confidence/i })).toBeNull();
  });

  it("says 'no data' for a cell that carries no probability at all, never 0%", async () => {
    // The rule this whole branch is built around, and the one place it is
    // easiest to break by accident. `WEEK_UNKNOWN` (255) is the absence of an
    // answer, not an answer of nothing: a cell that carries no probability must
    // read "no data", because "0%" is the claim "reliably full at this hour" and
    // a driver hunting for a space would believe it. `week.ts`'s `blend` spends
    // three paragraphs forbidding the one-character version of this bug --
    // `p ?? 0` -- and this is the test that catches it: the coercion renders 0%
    // here and nothing else in the suite notices.
    //
    // The 255 is written by hand because the collector cannot currently produce
    // one -- see `week.ts`'s `WEEK_UNKNOWN`: an *unwatched* bucket ships the
    // citywide fallback with support 0, not this. That is exactly why the test
    // stays. The format carries the value, a future encoder could legitimately
    // emit it, and this is the only thing standing between such a cell and a
    // "255%" on a card.
    const far = tomorrowEvening();
    const unobserved = encodeWeek(
      weekBucket(far),
      { percent: 255, support: 0 },
      { percent: OTHER_PERCENT, support: 0 },
    );
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: unobserved });
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(weekFetchCount()).toBe(1));

    // The table loaded and the row exists -- this is the *cell* saying nothing.
    expect(chance()).toContain(t("en").noData);
    expect(chance()).not.toMatch(/\d+%/);
    expect(chance()).not.toContain(CLAMPED);
    // ...and no grade over a number that is not there.
    expect(screen.queryByRole("button", { name: /confidence/i })).toBeNull();
  });

  it("stays silent about a cell with no probability, however much support it carries", async () => {
    // Support and probability are different facts, and the pill is gated on the
    // second. Grading a cell that carries no rate as "high, five weeks" would
    // put a confident label beside a blank ring. Same defensive 255 as above:
    // hand-written, because the encoder does not currently produce one.
    const far = tomorrowEvening();
    const unobserved = encodeWeek(
      weekBucket(far),
      { percent: 255, support: FAR_SUPPORT },
      { percent: OTHER_PERCENT, support: 0 },
    );
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: unobserved });
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(weekFetchCount()).toBe(1));

    expect(chance()).toContain(t("en").noData);
    expect(screen.queryByRole("button", { name: /confidence/i })).toBeNull();
  });

  it("refuses a week table built against a different roster, rather than indexing it anyway", async () => {
    // `week.bin` is indexed by grid row. A table whose `rosterId` disagrees
    // describes a different ordering of lots, so every row would be answered
    // with some other car park's history -- silently, and plausibly. Same check
    // `loadArtifacts` already makes for the grid/lots pair.
    const far = tomorrowEvening();
    const foreign = encodeWeek(
      weekBucket(far),
      { percent: FAR_PERCENT, support: FAR_SUPPORT },
      { percent: OTHER_PERCENT, support: 0 },
      ROSTER_ID + 1,
    );
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: foreign });
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(weekFetchCount()).toBe(1));
    expect(chance()).toContain(t("en").noData);
    expect(chance()).not.toContain(`${FAR_PERCENT}%`);
    expect(chance()).not.toContain(CLAMPED);
  });

  it("grades the confidence pill on that bucket's own support, not on how far away it is", async () => {
    // The complaint this whole stage answers: "the further the time is the
    // lower the confidence is is also weird". Thirty observations is five weeks
    // of this half-hour, which reads high a day and a half out -- and says so.
    const far = tomorrowEvening();
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: weekFor(far) });
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(chance()).toBe(`${FAR_PERCENT}%`));

    fireEvent.click(screen.getByRole("button", { name: /confidence.*high/i }));
    expect(screen.getByRole("note")).toHaveTextContent(
      fillTemplate(t("en").confidenceWeeksTemplate, { n: 5 }),
    );
  });

  it("says so honestly when that bucket has barely been watched", async () => {
    // The other half of the same rule: support is what earns the grade, so a
    // bucket with one observation behind it reads low and names the reason,
    // even though the probability itself is as real as the one above.
    const far = tomorrowEvening();
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: weekFor(far, 1) });
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(chance()).toBe(`${FAR_PERCENT}%`));

    fireEvent.click(screen.getByRole("button", { name: /confidence.*low/i }));
    expect(screen.getByRole("note")).toHaveTextContent(t("en").confidenceThin);
  });

  it("upgrades an in-window grade once the week table has landed, without moving the number", async () => {
    // `supportForLot` is deliberately not gated on the grid's window, which
    // makes an in-window grade path-dependent inside a session: the same lot at
    // the same arrival reads "low · thin" cold and "high · 5 weeks" after the
    // driver has been out past the horizon and back. Pinned here so that gating
    // it later is a decision somebody makes rather than a regression nobody
    // notices -- and pinned together with the probability, which must NOT move:
    // inside the window the grid is still the source, and only the label is
    // better informed. See `supportForLot`'s doc comment.
    const inWindow = BASE_DATA_TS + 102 * 60; // > MEDIUM_MAX_MIN, <= the grid's 120
    stubColumnMarkedArtifacts({
      lot: OBSERVED_LOT,
      week: encodeWeek(
        weekBucket(inWindow),
        { percent: FAR_PERCENT, support: FAR_SUPPORT },
        { percent: OTHER_PERCENT, support: 0 },
      ),
    });
    await renderLocated();

    selectArrival(inWindow);
    const grid = `${columnMark(columnFor(inWindow))}%`;
    expect(chance()).toBe(grid);
    // Nothing has been fetched: this arrival is one the grid answers.
    expect(weekFetchCount()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /confidence.*low/i }));
    expect(screen.getByRole("note")).toHaveTextContent(t("en").confidenceThin);

    // Out past the horizon, which is what pays for the table...
    selectArrival(tomorrowEvening());
    await waitFor(() => expect(chance()).toBe(`${OTHER_PERCENT}%`));

    // ...and back to exactly the arrival we started at.
    selectArrival(inWindow);
    expect(chance()).toBe(grid);
    fireEvent.click(screen.getByRole("button", { name: /confidence.*high/i }));
    expect(screen.getByRole("note")).toHaveTextContent(
      fillTemplate(t("en").confidenceWeeksTemplate, { n: 5 }),
    );
  });
});

/**
 * `week.bin` is 715 KB raw. Most sessions ask about the next half hour and must
 * never pay for it -- the same bargain `PlaceSearch` strikes with the offline
 * place index, and for the same reason.
 */
describe("fetching the week table lazily", () => {
  function weekBytes(ts: number): ArrayBuffer {
    return encodeWeek(weekBucket(ts), { percent: 73, support: 30 }, { percent: 20, support: 0 });
  }

  it("does not fetch it on load, nor for an arrival the grid still covers", async () => {
    const far = tomorrowEvening();
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: weekBytes(far) });
    await renderLocated();
    expect(weekFetchCount()).toBe(0);

    // Half an hour out, and the last arrival time the grid itself reaches:
    // both inside the window, both answered without a second artifact.
    selectArrival(ceilToStep(nowSec() + 30 * 60));
    selectArrival(arrivalOptions(nowSec(), GRID_SPAN).at(-1)!);
    await screen.findByTestId("lot-list");
    expect(weekFetchCount()).toBe(0);
  });

  it("fetches it once, however many far arrivals are chosen after that", async () => {
    const far = tomorrowEvening();
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: weekBytes(far) });
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(screen.getByTestId("lot-probability").textContent).toBe("73%"));
    expect(weekFetchCount()).toBe(1);

    // Three more times out there, including a return through the grid's own
    // window: the table is in memory and nothing goes back to the network.
    selectArrival(composeArrival(dayOptions(nowSec())[1]!.daySec, 22, 30));
    selectArrival(ceilToStep(nowSec() + 30 * 60));
    selectArrival(composeArrival(dayOptions(nowSec())[3]!.daySec, 9, 0));
    await screen.findByTestId("lot-list");
    expect(weekFetchCount()).toBe(1);
  });

  it("retries on the next far arrival instead of remembering the failure", async () => {
    // A failed fetch must not poison the rest of the session -- the flag that
    // guards the request has to come back down, exactly as `PlaceSearch`'s
    // `loading` does in its cleanup. Without that, the first 503 is the last
    // word until the tab is reloaded.
    const far = tomorrowEvening();
    let published = false;
    stubColumnMarkedArtifacts({
      lot: OBSERVED_LOT,
      week: () => (published ? weekBytes(far) : null),
    });
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(weekFetchCount()).toBe(1));
    expect(screen.getByTestId("lot-probability").textContent).toContain(t("en").noData);

    // 21:25 is the same half-hour bucket as 21:20, so the answer below is the
    // retry landing rather than a different cell being read.
    published = true;
    selectArrival(composeArrival(dayOptions(nowSec())[1]!.daySec, 21, 25));
    await waitFor(() => expect(screen.getByTestId("lot-probability").textContent).toBe("73%"));
    expect(weekFetchCount()).toBe(2);
  });

  it("does not strand the request when the arrival moves while it is still in the air", async () => {
    // Two properties at once, and this test exists because an earlier draft of
    // the effect broke the first of them. A driver turning the picker's wheel
    // while 715 KB is downloading moves `arrivalTs`, which fires the effect's
    // cleanup and re-runs it within the same commit. That draft held an
    // in-flight flag in component state, so the re-run read `true` from the
    // render being cleaned up, refused itself, `cancelled` swallowed the
    // response, and the screen said "no data" for the rest of the session.
    // There is no flag now, so what is pinned here is the behaviour and not the
    // mechanism: the table still lands -- whatever guards this effect must not
    // refuse the run that takes over -- and it still costs exactly one request,
    // because `loadWeek`'s promise cache is what makes "fetched once" true.
    const far = tomorrowEvening();
    let release: (table: ArrayBuffer) => void = () => {};
    const inFlight = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: () => inFlight });
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(weekFetchCount()).toBe(1));

    // 21:25 is the same half-hour bucket as 21:20, so what lands below is this
    // request finishing rather than some other cell being read.
    selectArrival(composeArrival(dayOptions(nowSec())[1]!.daySec, 21, 25));
    release(weekBytes(far));

    await waitFor(() => expect(screen.getByTestId("lot-probability").textContent).toBe("73%"));
    // ...and still one request: the run after the cleanup re-subscribed to the
    // promise already in flight instead of starting a second download.
    expect(weekFetchCount()).toBe(1);
  });

  it("leaves everything inside the grid's window working when the fetch fails", async () => {
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: null });
    await renderLocated();

    selectArrival(tomorrowEvening());
    await waitFor(() => expect(weekFetchCount()).toBe(1));

    // Back to a time the grid answers for: its own column, as if the failed
    // fetch had never happened. The forecast never expired -- this grid is four
    // minutes old -- so the heading still claims the order it really has.
    const near = ceilToStep(nowSec() + 30 * 60);
    selectArrival(near);
    expect(screen.getByTestId("lot-probability").textContent).toBe(`${columnMark(columnFor(near))}%`);
    expect(screen.queryByTestId("forecast-expired")).toBeNull();
    expect(screen.getByText(t("en").rankedForArrival)).toBeInTheDocument();
    expect(screen.getByTestId("staleness")).toBeInTheDocument();
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

  it("keeps the arrival picker itself present and honest, even once this grid's forecast has expired", async () => {
    ageArtifact(OBSERVED_AGE_MIN);
    await renderLocated();
    // Not a disabled control and not a blank one: a driver can still say when
    // they expect to arrive -- the picker's own range runs seven days ahead
    // of the clock and has nothing to do with how old this particular grid
    // is. It is only *this* grid's forecast for that time that expired, which
    // the probability cells and the banner above already say; the picker does
    // not pretend otherwise by going empty.
    expect(screen.getByTestId("arrival-time").textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(screen.getByLabelText(t("en").pickerHour)).toBeInTheDocument();
    expect(screen.getByLabelText(t("en").pickerMinute)).toBeInTheDocument();
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
    expect(screen.getByText(t("en").nearbyCarParks)).toBeInTheDocument();
    for (const cell of screen.getAllByTestId("lot-probability")) {
      expect(cell.textContent).not.toMatch(/\d+%/);
    }
  });

  it("leaves a grid alone while an arrival time still has a column of its own", async () => {
    // One minute earlier, and the forecast is not a decoration: the last
    // arrival time the grid reaches still has a real column behind it, and
    // picking it reads that column rather than the clamped last one -- the
    // documented trade, not an expiry.
    stubColumnMarkedArtifacts();
    ageArtifact(LAST_LIVE_AGE_MIN);
    await renderLocated();

    expect(screen.queryByTestId("forecast-expired")).toBeNull();
    expect(screen.getByText(t("en").rankedForArrival)).toBeInTheDocument();

    const offered = arrivalOptions(nowSec(), GRID_SPAN);
    expect(offered.length).toBeGreaterThan(0);
    selectArrival(offered.at(-1)!);

    const chance = within(rowFor(MARKED.n)).getByTestId("lot-probability").textContent;
    expect(chance).toContain(`${columnMark(columnFor(offered.at(-1)!))}%`);
    // ...and not the grid's last column, which is what a clamp would have said.
    expect(chance).not.toContain(`${columnMark(N_HORIZONS - 1)}%`);
  });
});

/**
 * The expiry stopped at the edge of what it is actually a statement about.
 *
 * `forecastExpired` says the *reading* has aged past the grid's own span, so
 * nothing the grid holds still answers for a time the user can pick. That is
 * true of "in 20 minutes", and it is the whole point of the describe above.
 * It is not true of "tomorrow at 21:20", which no reading was ever going to
 * answer: past the grid's window the number is climatology with a persistence
 * term whose weight at 1,832 minutes from the reading is 4e-19. Weeks of
 * accumulated history do not go stale because a collector was paused for an
 * afternoon -- and this one is paused deliberately, for hours at a time.
 *
 * Worse, the expiry was also the *fetch* gate, so past a reading age of 113
 * minutes `week.bin` was not requested at all: zero network calls, and the
 * seven-day picker answered "no data" for every one of the seven days it
 * offers, in exactly the state where it is most useful.
 *
 * The line is drawn at the grid's span measured **from the clock**, not from
 * the reading. Measured from the reading it would be nowhere -- with a
 * 383-minute-old artifact every arrival, "in 20 minutes" included, sits past
 * the grid's window and would be answered from history, which is precisely
 * the near-term claim the expiry exists to refuse.
 */
describe("a stale reading and an arrival past the grid's window", () => {
  /** The 383 minutes actually observed while verifying the arrival control. */
  const OBSERVED_AGE_MIN = 383;
  /** The grid's whole span, which is also the line between the two behaviours here. */
  const SPAN_SEC = STEP_MIN * N_HORIZONS * 60;

  /** Age the artifact, then build the far arrival and the table that answers it. */
  function stubStale(week: (far: number) => ArrayBuffer | null = weekFor): number {
    ageArtifact(OBSERVED_AGE_MIN);
    const far = tomorrowEvening();
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: week(far) });
    return far;
  }

  it("answers tomorrow evening from the week table, expired reading and all", async () => {
    // THE regression test for this task. Before it, this row read "no data"
    // for every arrival on all seven days the picker offers.
    const far = stubStale();
    await renderLocated();

    selectArrival(far);
    expect(screen.getByTestId("arrival-time").textContent).toBe("21:20");
    await waitFor(() => expect(chance()).toBe(`${FAR_PERCENT}%`));

    // The climatology, not the clamp, not another bucket, and not silence.
    expect(chance()).not.toContain(CLAMPED);
    expect(chance()).not.toContain(`${OTHER_PERCENT}%`);
    expect(chance()).not.toContain(t("en").noData);
  });

  it("fetches the week table while the reading is stale, which the expiry used to prevent", async () => {
    // The reviewer's finding, as a network fact: `needsWeek` carried
    // `!forecastExpired`, so past an age of 113 minutes this count stayed 0
    // however far ahead the driver looked. Confirmed by probe before the fix.
    const far = stubStale();
    await renderLocated();

    // Still lazy: nothing on load, and nothing for the near arrival the
    // picker opens on -- that one is withheld, so the table would be
    // downloaded only to be thrown away.
    expect(weekFetchCount()).toBe(0);

    selectArrival(far);
    await waitFor(() => expect(weekFetchCount()).toBe(1));
  });

  it("still withholds a near arrival, and still says why", async () => {
    // Requirement unchanged by this task, and the reason the change is safe:
    // the picker opens 19 minutes out, a time only a live reading could ever
    // have answered, and there is no live reading. Climatology is not an
    // answer to "will there be a space when I get there in a quarter of an
    // hour" -- it is an answer to "what is this car park usually like".
    stubStale();
    await renderLocated();

    expect(chance()).toContain(t("en").noData);
    expect(chance()).not.toMatch(/\d+%/);
    expect(screen.getByTestId("forecast-expired").textContent).toBe(t("en").forecastTooOld);
    expect(screen.getByText(t("en").nearbyCarParks)).toBeInTheDocument();
    expect(screen.queryByText(t("en").rankedForArrival)).toBeNull();
    expect(screen.queryByTestId("from-history")).toBeNull();
    expect(weekFetchCount()).toBe(0);
  });

  it("draws the line at the grid's span from the clock, not from the reading", async () => {
    ageArtifact(OBSERVED_AGE_MIN);
    // The last five-minute mark still inside the grid's span, and the first
    // one past it. Five minutes apart, so this pins the boundary to the
    // granularity the picker actually offers.
    const inside = floorToStep(nowSec() + SPAN_SEC);
    const outside = ceilToStep(nowSec() + SPAN_SEC);
    // A fixture that did not straddle the line would prove nothing...
    expect(inside - nowSec()).toBeLessThanOrEqual(SPAN_SEC);
    expect(outside - nowSec()).toBeGreaterThan(SPAN_SEC);
    // ...and one that straddled a *bucket* edge as well would prove less than
    // this test claims below: the near arrival would then read the filler 20%
    // if it were answered, rather than the identical 73% that makes the silence
    // unambiguous. Asserted rather than left to a comment, because a constant
    // moving five minutes would quietly falsify it.
    expect(weekBucket(inside)).toBe(weekBucket(outside));
    stubColumnMarkedArtifacts({ lot: OBSERVED_LOT, week: weekFor(outside) });
    await renderLocated();

    // Measured from the *reading* these are both 500-odd minutes out, and both
    // would be answered. Measured from the clock -- which is what decides
    // whether a live reading could ever have covered them -- only the second
    // is.
    selectArrival(outside);
    await waitFor(() => expect(chance()).toBe(`${FAR_PERCENT}%`));

    // Five minutes earlier, and inside the span. The table is in hand by now
    // and the two arrivals share a half-hour bucket, so the silence below is
    // the app refusing to answer a near-term question out of history -- not a
    // missing artifact, and not an empty cell. Answering it would render this
    // same 73%, which is what makes the assertion sharp.
    selectArrival(inside);
    expect(chance()).toContain(t("en").noData);
    expect(chance()).not.toMatch(/\d+%/);
    expect(screen.getByTestId("forecast-expired").textContent).toBe(t("en").forecastTooOld);
    expect(screen.queryByTestId("from-history")).toBeNull();
  });

  it("says the number came from history, not from the reading it no longer has", async () => {
    // The two situations the driver has to be able to tell apart: a number
    // behind a reading taken minutes ago, and a number behind nothing but
    // what this car park usually does at this hour. One line of copy is what
    // separates them.
    const far = stubStale();
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(chance()).toBe(`${FAR_PERCENT}%`));

    expect(screen.getByTestId("from-history").textContent).toBe(t("en").basedOnHistory);
    // The badge still reports the reading, and the reading is still expired --
    // that is the truth about the reading, and it is not a claim about the
    // number beside it.
    expect(screen.getByTestId("staleness").textContent).toContain(t("en").expired);
    // ...while the sentence that withholds *every* probability is gone,
    // because this one is not withheld.
    expect(screen.queryByTestId("forecast-expired")).toBeNull();
    // And the order is real again: it was computed from these probabilities.
    expect(screen.getByText(t("en").rankedForArrival)).toBeInTheDocument();
  });

  it("says it in Chinese too", async () => {
    const far = stubStale();
    await renderLocated();
    selectArrival(far);
    await waitFor(() => expect(chance()).toBe(`${FAR_PERCENT}%`));

    fireEvent.click(screen.getByRole("button", { name: "切換為中文" }));
    await screen.findByRole("button", { name: t("zh").useMyLocation });

    expect(screen.getByTestId("from-history").textContent).toBe(t("zh").basedOnHistory);
    expect(screen.queryByTestId("forecast-expired")).toBeNull();
  });

  it("says 'no data' for a bucket nobody has watched out there, never 0%", async () => {
    // The rule the whole week path is built around, restated in the state this
    // task opened up: an expired reading must not turn `WEEK_UNKNOWN` into a
    // confident "0%". `p ?? 0` renders 0% here and the attribution line below
    // would then be vouching for it.
    const far = stubStale((ts) =>
      encodeWeek(weekBucket(ts), { percent: 255, support: 0 }, { percent: OTHER_PERCENT, support: 0 }),
    );
    await renderLocated();

    selectArrival(far);
    await waitFor(() => expect(weekFetchCount()).toBe(1));

    expect(chance()).toContain(t("en").noData);
    expect(chance()).not.toMatch(/\d+%/);
    expect(chance()).not.toContain(CLAMPED);
    // Nothing was answered, so nothing is attributed...
    expect(screen.queryByTestId("from-history")).toBeNull();
    // ...and the page falls back to the sentence that is still true out here:
    // the reading has expired and nothing we hold covers this time either.
    expect(screen.getByTestId("forecast-expired").textContent).toBe(t("en").forecastTooOld);
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
 * The expander, and the car park the cap used to hide.
 *
 * The owner's report: *"I always see lots around that's green but didn't see it
 * in the list if I'd like to know the detail about it."* The list took the
 * ranking's first twenty rows, and the ranking sorts by expected *cost*, so a
 * car park two streets away and visibly free could lose that race on price
 * alone and have no row to open at all. The list is bounded by distance now --
 * everything within `NEARBY_RADIUS_M` is reachable -- and the cap only decides
 * how much of it renders before the driver asks.
 *
 * `listRows` is unit-tested in `rank.test.ts`; this is the wiring, and the
 * wiring is where the last version of this bug lived. Every assertion below is
 * about *which rows, in what order* -- never how many. A count would pass
 * against a tail sorted the wrong way and against one repeating a row the head
 * is already showing, which are the two ways this can be wrong while looking
 * right.
 */
describe("the nearby expander", () => {
  /**
   * Metres per degree of latitude. Every lot here shares `HERE`'s longitude, so
   * `haversineMeters` reduces to `EARTH_RADIUS_M * dLat` exactly -- which
   * matters, since the fixture is built to straddle `NEARBY_RADIUS_M`.
   */
  const M_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS_M;

  /** A car park `meters` due north of `HERE`, charging `hourly` NT$ an hour. */
  function northOf(id: string, meters: number, hourly: number): Lot {
    return {
      i: 0,
      id,
      n: `車場${id}`,
      a: "信義區",
      y: HERE.lat + meters / M_PER_DEG_LAT,
      x: HERE.lon,
      c: 50,
      t: "民營停車場",
      p: { k: "exact", lo: hourly, hi: hourly },
    };
  }

  const metersOf = (lot: Lot) => haversineMeters(HERE, { lat: lot.y, lon: lot.x });

  /** Twenty cheap car parks on the doorstep: the head, under any ordering. */
  const NEAR = Array.from({ length: LIST_LIMIT }, (_unused, k) =>
    northOf(`TPE_NEAR_${String(k).padStart(2, "0")}`, 20 * (k + 1), 10),
  );

  /**
   * Three more inside the radius, arranged so that cost and distance disagree
   * about their order completely: the nearest is the dearest. That is the only
   * arrangement in which "the tail keeps the ranker's order" is a claim a test
   * can fail.
   */
  const DEAR = northOf("TPE_TAIL_DEAR", 700, 300);
  const MID = northOf("TPE_TAIL_MID", 900, 60);
  const CHEAP = northOf("TPE_TAIL_CHEAP", 1400, 10);

  /**
   * ...and one just outside it, cheap enough that the ranker would put it
   * *second* of the four. So a tail that forgot its bound does not merely grow
   * by a row at the end: it changes what the second row is.
   */
  const OUTSIDE = northOf("TPE_OUTSIDE", 1600, 10);

  const NEIGHBOURHOOD = [...NEAR, DEAR, MID, CHEAP, OUTSIDE];
  const HEAD_IDS = NEAR.map((lot) => lot.id);
  /** Cheapest first -- the ranker's order. */
  const TAIL_IDS = [CHEAP.id, MID.id, DEAR.id];
  /** The same three nearest-first: what a tail sorted by distance would show. */
  const TAIL_BY_DISTANCE = [DEAR, MID, CHEAP]
    .slice()
    .sort((a, b) => metersOf(a) - metersOf(b))
    .map((lot) => lot.id);

  /** Serve `lots`, re-indexed so a subset is still a valid roster. Everyone reads 70%. */
  function stubRoster(lots: Lot[]) {
    const rows = lots.map((lot, i) => ({ ...lot, i }));
    const body: number[] = [];
    for (const _row of rows) for (let h = 0; h < N_HORIZONS; h += 1) body.push(70);
    stubFetch(encodeGrid(body, rows.length), {
      v: 1,
      generated_at: BASE_DATA_TS + 213,
      base_data_ts: BASE_DATA_TS,
      n_lots: rows.length,
      roster_id: ROSTER_ID,
      lots: rows,
    });
  }

  const idsIn = (testId: string) =>
    within(screen.getByTestId(testId))
      .queryAllByTestId("lot-row")
      .map((el) => el.getAttribute("data-lot-id"));
  const headIds = () => idsIn("lot-list");
  const tailIds = () => idsIn("nearby-list");
  const toggle = () => screen.getByTestId("nearby-toggle");

  it("offers the rows the cap dropped, says how many, and draws none of them yet", async () => {
    stubRoster(NEIGHBOURHOOD);
    await renderLocated();

    expect(headIds()).toEqual(HEAD_IDS);
    expect(screen.queryByTestId("nearby-list")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveTextContent(
      fillTemplate(t("en").nearbyMoreTemplate, { n: TAIL_IDS.length }),
    );
  });

  it("reveals them in the ranker's order, which here is the reverse of distance's", async () => {
    stubRoster(NEIGHBOURHOOD);
    await renderLocated();
    fireEvent.click(toggle());

    expect(tailIds()).toEqual(TAIL_IDS);
    // The fixture really does separate the two orderings, so the line above is
    // a claim about the ranking and not an accident of where the lots are.
    expect(TAIL_BY_DISTANCE).not.toEqual(TAIL_IDS);
    expect(tailIds()).not.toEqual(TAIL_BY_DISTANCE);
  });

  it("leaves the ranked head exactly where it was, and lists no car park twice", async () => {
    stubRoster(NEIGHBOURHOOD);
    await renderLocated();
    const before = headIds();
    fireEvent.click(toggle());

    expect(headIds()).toEqual(before);
    expect(headIds()).toEqual(HEAD_IDS);
    const all = [...headIds(), ...tailIds()];
    expect(new Set(all).size).toBe(all.length);
  });

  it("never reaches the car park past NEARBY_RADIUS_M, open or shut", async () => {
    // The fixture straddles the bound -- asserted, not assumed.
    expect(metersOf(OUTSIDE)).toBeGreaterThan(NEARBY_RADIUS_M);
    expect(metersOf(CHEAP)).toBeLessThan(NEARBY_RADIUS_M);

    stubRoster(NEIGHBOURHOOD);
    await renderLocated();
    expect(headIds()).not.toContain(OUTSIDE.id);
    fireEvent.click(toggle());
    expect([...headIds(), ...tailIds()]).not.toContain(OUTSIDE.id);
  });

  it("closes again, and takes its rows with it", async () => {
    stubRoster(NEIGHBOURHOOD);
    await renderLocated();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveTextContent(t("en").nearbyFewer);

    fireEvent.click(toggle());
    expect(screen.queryByTestId("nearby-list")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(headIds()).toEqual(HEAD_IDS);
  });

  it("names the tail's list, so two lists on one page are told apart", async () => {
    stubRoster(NEIGHBOURHOOD);
    await renderLocated();
    fireEvent.click(toggle());
    // The ranked head sits under its own `<h2>`; the tail has only the button
    // above it, so without this a screen reader announces two unnamed lists.
    expect(screen.getByRole("list", { name: t("en").nearbyListLabel })).toBe(
      screen.getByTestId("nearby-list"),
    );
  });

  it("says 'car park' and not 'car parks' when the tail holds one", async () => {
    // The `n === 1` branch, which the main fixture never reaches. Same
    // singular/plural pattern as the hidden-count lines and `confidenceWeek`.
    stubRoster([...NEAR, CHEAP, OUTSIDE]);
    await renderLocated();
    expect(toggle()).toHaveTextContent(fillTemplate(t("en").nearbyMoreOneTemplate, { n: 1 }));
  });

  it("offers nothing at all when the cap already reached everything nearby", async () => {
    // Twenty rows and one car park 1.6 km away: the list is complete as it
    // stands, and a control promising more would be promising nothing.
    stubRoster([...NEAR, OUTSIDE]);
    await renderLocated();
    expect(headIds()).toEqual(HEAD_IDS);
    expect(screen.queryByTestId("nearby-toggle")).toBeNull();
  });

  it("sits in the sheet's body, not in the header whose height is budgeted", async () => {
    // `tests/preferencePicker.test.tsx` sums the header's blocks against the
    // `peek` height and fails by name on an unbudgeted one -- there are 13 px
    // of slack at 375x667. This control is part of the answer rather than part
    // of the question, and belongs on the list's side of that line anyway.
    stubRoster(NEIGHBOURHOOD);
    await renderLocated();
    const header = document.querySelector(".sheet__header");
    expect(header).not.toBeNull();
    expect(header!.contains(toggle())).toBe(false);
    expect(document.querySelector(".sheet__body")!.contains(toggle())).toBe(true);
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
    // Scoped to the results list: the arrival picker's own native `<select>`s
    // add "option" elements of their own to the page (a currently-selected
    // hour or minute is a selected option too), and an unscoped query would
    // now match one of those instead of failing outright.
    const active = within(screen.getByTestId("search-results")).getByRole("option", { selected: true });
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
