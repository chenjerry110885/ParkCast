/**
 * The ranking preference, end to end through the real `App`.
 *
 * The owner's ask, in their words: **"There should be able to prioritize
 * walking distance (closer the better), price (cheaper the better), or
 * balanced."** Three things have to hold for that to be true, and each is a
 * separate failure this file is written to catch:
 *
 *   - the choice reaches `rankLots` and **the rendered order actually
 *     changes** -- the trap in this task is that a test which clicks an option
 *     and asserts the option's own state passes just as happily against a
 *     control wired to nothing, so every assertion below that matters is made
 *     on the list's rows and not on the radio;
 *   - it **survives a reload**, which is asserted the same way: a fresh `App`
 *     with nothing but `localStorage` behind it must render the *order* the
 *     stored preset produces, not merely tick the right box;
 *   - and changing it **re-ranks in place** -- no scroll, no re-centred map,
 *     no moved arrival. The list reorders and the map recolours, as they do
 *     when the arrival moves.
 *
 * **Balanced is (5, 5), which is what the ranker's constants already were**, so
 * nothing resting on Balanced alone proves any wiring at all. Every ordering
 * assertion here is made on Cheaper and Closer, whose orders differ from
 * Balanced's *and* from each other on this fixture.
 *
 * The score is never shown, and that rule is checked rather than trusted: the
 * expected cost of every row under every preset is computed in the comment on
 * `COSTS` and asserted absent from the rendered page, so a helpful "NT$90"
 * explaining the ordering fails here.
 *
 * jsdom lays nothing out, so the 44 px floor and the segmented look are read
 * out of `components.css` as text; the visual check is a real browser at
 * 375 px and desktop, in both themes -- see the report.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { TOP_BAR_PX } from "../src/App";
import { HEADER_SIZE } from "../src/artifacts";
import { EARTH_RADIUS_M } from "../src/geo";
import { t } from "../src/i18n";
import { snapHeights } from "../src/layout/sheet";
import { PREFERENCE_KEY } from "../src/preference";
import { PREFERENCES, type Preference } from "../src/rank";
import type { Lot, LotsDoc } from "../src/types";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROSTER_ID = 4242;
const N_HORIZONS = 24;
const STEP_MIN = 5;
const BASE_DATA_TS = 1788677280;
const NOW_MS = (BASE_DATA_TS + 4 * 60) * 1000;
const HERE = { lat: 25.0375, lon: 121.5637 };

/** Every lot is certain to have a space, so the failure branch weighs nothing and each score is exactly its walk-plus-fare term. */
const PERCENT = 100;

/** Degrees of latitude per metre due north, from the ranker's own earth radius. */
const DEGREES_PER_METER = 180 / (Math.PI * EARTH_RADIUS_M);

/** `metres` due north of the destination. */
function north(meters: number): number {
  return HERE.lat + meters * DEGREES_PER_METER;
}

/**
 * Three car parks chosen so that the three presets give three *different*
 * orders, with no pair closer than NT$6 apart.
 *
 * Walking is rounded up at 80 m/min, a fare is charged for `EXPECTED_HOURS`
 * (2), and every lot is certain, so `cost` is exactly `walkMin * walk + fare`:
 *
 *   |          | walk   | fare | cheaper (2) | balanced (5) | closer (12) |
 *   |----------|--------|------|-------------|--------------|-------------|
 *   | door     |  0 min |   90 |          90 |           90 |          90 |
 *   | middling |  7 min |   46 |          60 |           81 |         130 |
 *   | far      | 18 min |   18 |          54 |          108 |         234 |
 *
 * so Cheaper reads far → middling → door, Balanced middling → door → far, and
 * Closer door → middling → far. Balanced's order is a third distinct one, which
 * is what keeps a mutation that pins the ranker to one preset from passing two
 * of the three assertions by luck.
 *
 * The distances are 5 m short of a whole number of minutes rather than exactly
 * on one, so a float landing a hair above the boundary cannot round the walk up
 * an extra minute and quietly change the arithmetic above.
 */
const LOTS: Lot[] = [
  { i: 0, id: "TPE_DOOR", n: "門口停車場", a: "信義區", y: HERE.lat, x: HERE.lon, c: 63, t: "民營停車場", p: { k: "exact", lo: 45, hi: 45 } },
  { i: 1, id: "TPE_MID", n: "中距停車場", a: "信義區", y: north(555), x: HERE.lon, c: 63, t: "民營停車場", p: { k: "exact", lo: 23, hi: 23 } },
  { i: 2, id: "TPE_FAR", n: "遠處停車場", a: "信義區", y: north(1435), x: HERE.lon, c: 63, t: "民營停車場", p: { k: "exact", lo: 9, hi: 9 } },
];

/** The rendered order each preset must produce, read off the table above. */
const ORDERS: Record<Preference, string[]> = {
  cheaper: ["TPE_FAR", "TPE_MID", "TPE_DOOR"],
  balanced: ["TPE_MID", "TPE_DOOR", "TPE_FAR"],
  closer: ["TPE_DOOR", "TPE_MID", "TPE_FAR"],
};

/**
 * Every expected cost in the table above, which is the set of numbers the
 * screen must never contain.
 *
 * None of them collides with anything the fixture does show -- the fares are
 * 45/23/9, the walks 0/7/18 minutes, the distances 0 m / 555 m / 1.4 km and
 * the chance 100% -- so a match is a score that escaped, not a coincidence.
 */
const COSTS = [54, 60, 81, 90, 108, 130, 234];

/** The last props the (mocked) map was rendered with, so a test can see whether it was asked to move. */
const map = vi.hoisted(() => ({ renders: [] as Record<string, unknown>[] }));

vi.mock("../src/map/MapView", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      map.renders.push(props);
      return createElement("div", { "data-testid": "map-mounted" });
    },
  };
});

function encodeGrid(): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + LOTS.length * N_HORIZONS);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode("PCG1"), 0);
  dv.setUint8(4, 1);
  dv.setUint32(5, BASE_DATA_TS + 213, true);
  dv.setUint32(9, BASE_DATA_TS, true);
  dv.setUint16(13, LOTS.length, true);
  dv.setUint8(15, N_HORIZONS);
  dv.setUint8(16, STEP_MIN);
  dv.setUint32(17, ROSTER_ID, true);
  new Uint8Array(buf).fill(PERCENT, HEADER_SIZE);
  return buf;
}

const DOC: LotsDoc = {
  v: 1,
  generated_at: BASE_DATA_TS + 213,
  base_data_ts: BASE_DATA_TS,
  n_lots: LOTS.length,
  roster_id: ROSTER_ID,
  lots: LOTS,
};

/** `matchMedia`, answering the desktop query either way and reduced-motion never. */
function stubMatchMedia(desktop: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: desktop && query.includes("min-width"),
      addEventListener() {},
      removeEventListener() {},
    })),
  );
}

beforeEach(() => {
  map.renders.length = 0;
  window.localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  stubMatchMedia(false);
  // jsdom has neither, and both are how a re-rank could move the page under
  // the driver without touching any state this file can see.
  vi.stubGlobal("scrollTo", vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("grid.bin")) {
        return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(encodeGrid()) });
      }
      if (url.endsWith("lots.json")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DOC) });
      }
      if (url.endsWith("week.bin")) return Promise.resolve({ ok: false, status: 503 });
      return Promise.reject(new Error(`unexpected url ${url}`));
    }),
  );
  Object.defineProperty(navigator, "geolocation", {
    value: {
      getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) =>
        ok({ coords: { latitude: HERE.lat, longitude: HERE.lon } }),
    },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A loaded app with a destination, so the ranked list is on screen.
 *
 * Leaves the phone's sheet at `peek`, where it opens -- and where the
 * preference row is deliberately not rendered, because the header has no room
 * for it there (see "the sheet header's height budget" below). Tests about the
 * control itself use `renderWithControl`.
 */
async function renderRanked(): Promise<void> {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
  await screen.findByTestId("lot-list");
}

/** ...and with the sheet opened, which is where the driver meets the control. The desktop panel has no sheet to open. */
async function renderWithControl(): Promise<void> {
  await renderRanked();
  const grip = screen.queryByRole("button", { name: t("en").expandList });
  if (grip !== null) fireEvent.click(grip);
  await screen.findByTestId("preference-picker");
}

function rowIds(): string[] {
  return within(screen.getByTestId("lot-list"))
    .queryAllByTestId("lot-row")
    .map((row) => row.getAttribute("data-lot-id") ?? "");
}

const LABELS: Record<Preference, string> = {
  cheaper: t("en").preferenceCheaper,
  balanced: t("en").preferenceBalanced,
  closer: t("en").preferenceCloser,
};

function option(preference: Preference): HTMLInputElement {
  return screen.getByRole("radio", { name: LABELS[preference] }) as HTMLInputElement;
}

function choose(preference: Preference): void {
  act(() => {
    fireEvent.click(option(preference));
  });
}

describe("the ranking preference", () => {
  it("opens on Balanced, which is the ordering the app shipped with", async () => {
    await renderWithControl();
    // A driver who never touches the control must see exactly what they saw
    // before it existed. This is a regression guard and nothing else: Balanced
    // is (5, 5), the ranker's own constants, so it would pass against a control
    // wired to nothing. The two tests below are what prove the wiring.
    expect(option("balanced")).toBeChecked();
    expect(option("cheaper")).not.toBeChecked();
    expect(option("closer")).not.toBeChecked();
    expect(rowIds()).toEqual(ORDERS.balanced);
  });

  it("re-ranks the rendered list -- a different order for Cheaper than for Closer", async () => {
    await renderWithControl();

    choose("cheaper");
    expect(rowIds()).toEqual(ORDERS.cheaper);

    choose("closer");
    expect(rowIds()).toEqual(ORDERS.closer);

    // The discriminating pair, stated outright: these two orders are different
    // from each other and from Balanced's, so a control that only moved its own
    // highlight -- or a `rankLots` that ignored the argument -- fails here.
    expect(ORDERS.cheaper).not.toEqual(ORDERS.closer);
    expect(ORDERS.cheaper).not.toEqual(ORDERS.balanced);
    expect(ORDERS.closer).not.toEqual(ORDERS.balanced);

    choose("balanced");
    expect(rowIds()).toEqual(ORDERS.balanced);
  });

  it("survives a reload, in the ordering and not just in the control", async () => {
    await renderWithControl();
    choose("cheaper");
    expect(rowIds()).toEqual(ORDERS.cheaper);

    // The reload: this `App` is gone, and the only thing carried across is the
    // one word in `localStorage`.
    cleanup();
    map.renders.length = 0;
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBe("cheaper");

    await renderWithControl();
    // The order first, because it is the half that cannot be faked: a fresh app
    // that ticked the box but ranked by Balanced fails on this line and passes
    // on the next.
    expect(rowIds()).toEqual(ORDERS.cheaper);
    expect(option("cheaper")).toBeChecked();
  });

  it("ranks by Balanced when storage holds something it does not recognise", async () => {
    window.localStorage.setItem(PREFERENCE_KEY, "closest");
    await renderWithControl();
    expect(option("balanced")).toBeChecked();
    expect(rowIds()).toEqual(ORDERS.balanced);
  });

  it("re-ranks in place: nothing scrolls, the map is not re-centred, the arrival does not move", async () => {
    await renderWithControl();
    const body = document.querySelector(".sheet__body");
    expect(body).not.toBeNull();
    // A driver part-way down the list is the case this protects: a re-rank that
    // remounted the list, or scrolled it, throws this away.
    body!.scrollTop = 120;
    const list = screen.getByTestId("lot-list");
    const arrival = screen.getByTestId("arrival-time").textContent;
    const snap = screen.getByTestId("sheet").getAttribute("data-snap");
    const centerBefore = map.renders.at(-1)?.["centerRequest"];

    choose("closer");

    // It did re-rank -- otherwise every assertion below is about a screen that
    // never changed and proves nothing.
    expect(rowIds()).toEqual(ORDERS.closer);
    expect(body!.scrollTop).toBe(120);
    expect(screen.getByTestId("lot-list")).toBe(list);
    expect(screen.getByTestId("arrival-time").textContent).toBe(arrival);
    expect(screen.getByTestId("sheet").getAttribute("data-snap")).toBe(snap);
    expect(map.renders.at(-1)?.["centerRequest"]).toBe(centerBefore);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("never puts the score on the screen", async () => {
    await renderWithControl();
    for (const preference of Object.keys(ORDERS) as Preference[]) {
      choose(preference);
      expect(rowIds()).toEqual(ORDERS[preference]);
      const text = document.body.textContent ?? "";
      for (const cost of COSTS) {
        // Digit boundaries, so "90" cannot be excused by the "1,090" in some
        // other string -- and cannot be matched by one either.
        expect(text).not.toMatch(new RegExp(`(?<![0-9])${cost}(?![0-9])`));
      }
    }
    // The control names a preference, not a number: no NT$ figure, no digits at
    // all. This is the line a "helpful" explanation of the ordering breaks.
    const control = screen.getByTestId("preference-picker").textContent ?? "";
    expect(control).not.toContain("NT$");
    expect(control).not.toMatch(/[0-9]/);
  });

  it("is a labelled group of keyboard-reachable radios, one of them selected", async () => {
    await renderWithControl();
    const group = screen.getByRole("radiogroup", { name: t("en").preferenceLabel });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(3);

    // Real radios sharing one name is what buys the arrow-key group behaviour
    // and the "2 of 3" a screen reader reads out -- neither of which jsdom
    // implements, so what is pinned here is the markup that earns them. The
    // keyboard itself was walked in a real browser; see the report.
    const names = new Set(radios.map((r) => r.name));
    expect(names.size).toBe(1);
    expect([...names][0]).toBeTruthy();
    for (const radio of radios) {
      expect(radio.type).toBe("radio");
      expect(radio.disabled).toBe(false);
      expect(radio.tabIndex).not.toBe(-1);
      expect(radio).toHaveAccessibleName();
      radio.focus();
      expect(document.activeElement).toBe(radio);
    }
    expect(radios.filter((r) => r.checked)).toHaveLength(1);

    // Chosen with the keyboard rather than a pointer: selecting a focused radio
    // is a click, and it has to re-rank exactly as a tap does.
    const closer = option("closer");
    closer.focus();
    act(() => {
      fireEvent.click(closer);
    });
    expect(rowIds()).toEqual(ORDERS.closer);
  });

  it("offers the control, and re-ranks, on the desktop layout too", async () => {
    cleanup();
    stubMatchMedia(true);
    await renderWithControl();
    expect(within(screen.getByTestId("panel")).getByTestId("preference-picker")).toBeInTheDocument();
    expect(document.querySelector(".sheet")).toBeNull();

    choose("cheaper");
    expect(rowIds()).toEqual(ORDERS.cheaper);
    choose("closer");
    expect(rowIds()).toEqual(ORDERS.closer);
  });

  it("offers one option for every preset the ranker has prices for", async () => {
    await renderWithControl();
    // Driven off `PREFERENCES` rather than a list repeated here, so a fourth
    // preset cannot be added to the ranker and silently have no control.
    const group = screen.getByRole("radiogroup", { name: t("en").preferenceLabel });
    const offered = (within(group).getAllByRole("radio") as HTMLInputElement[]).map((r) => r.value);
    expect([...offered].sort()).toEqual(Object.keys(PREFERENCES).sort());
  });
});

describe("the copy", () => {
  it("is comparative in both languages, never superlative", async () => {
    // The ranker still puts a likely space above an unlikely bargain under every
    // preset, so copy promising *the* cheapest or *the* nearest car park would
    // be a promise it deliberately does not keep.
    const en = t("en"), zh = t("zh");
    expect(en.preferenceCheaper).toBe("Cheaper");
    expect(en.preferenceCloser).toBe("Closer");
    for (const word of [en.preferenceCheaper, en.preferenceCloser, en.preferenceBalanced, en.preferenceLabel]) {
      expect(word).not.toMatch(/est\b/i);
      expect(word).not.toMatch(/nearest|cheapest|closest|best/i);
    }
    // 最 is the superlative marker, and 就近 ("head for whatever is nearby")
    // makes the same absolute claim in a friendlier register. 較 is the
    // comparative this copy is built on.
    for (const word of [zh.preferenceCheaper, zh.preferenceCloser, zh.preferenceBalanced, zh.preferenceLabel]) {
      expect(word).not.toContain("最");
      expect(word).not.toContain("就近");
    }
    expect(zh.preferenceCheaper).toContain("較");
    expect(zh.preferenceCloser).toContain("較");
  });

  it("names a preference and never a number", () => {
    for (const lang of ["en", "zh"] as const) {
      const s = t(lang);
      for (const word of [s.preferenceLabel, s.preferenceCheaper, s.preferenceBalanced, s.preferenceCloser]) {
        expect(word).not.toMatch(/[0-9]/);
        expect(word).not.toContain("NT$");
      }
    }
  });
});

/**
 * What each block in the phone's sheet header costs, as an outer height in
 * pixels including its margins. Measured in Chrome at 375 px (Task 3 report).
 *
 * A budget rather than a measurement because jsdom lays nothing out: there is
 * no `getBoundingClientRect` here worth reading. What makes it a real test and
 * not a restatement is that `headerCost` reads the blocks that are *actually
 * in the header* out of the rendered DOM and looks each one up here -- so a
 * block added to the header fails as an unbudgeted class, and a block rendered
 * in a state that has no room for it fails on the arithmetic below.
 *
 * `status visually-hidden` measures -1 px (a 1 px box with -1 px margins) and
 * is budgeted at 0: rounding a cost *up* keeps the budget conservative.
 */
const HEADER_BUDGET_PX: Record<string, number> = {
  "head-row": 33,
  "arrival-picker": 142,
  "preference": 54,
  "status visually-hidden": 0,
};
/** `.sheet__header`'s own `padding: 0 16px 8px`. */
const HEADER_PADDING_PX = 8;
/** `.sheet__grip`'s `min-height`, which sits above the header inside the same sheet. */
const GRIP_PX = 44;

/**
 * The phones this geometry is asserted at, and the bottom safe-area inset each
 * one spends.
 *
 * The inset matters and is easy to miss: `.sheet` pays `--safe-bottom` as
 * *padding* and `box-sizing` is `border-box`, so on a notched phone the sheet's
 * usable box is `snapHeights(...)` minus the inset. 375x812 and 390x844 are
 * notched; 375x667 is not.
 */
const PHONES = [
  { name: "375x667, iPhone SE/8", height: 667, safeBottom: 0 },
  { name: "375x812, iPhone X/13 mini", height: 812, safeBottom: 34 },
  { name: "390x844, iPhone 13/14", height: 844, safeBottom: 34 },
];

/** What the sheet header in the document costs, from the blocks actually rendered into it. */
function headerCost(): number {
  const header = document.querySelector(".sheet__header");
  expect(header).not.toBeNull();
  let total = GRIP_PX + HEADER_PADDING_PX;
  for (const child of Array.from(header!.children)) {
    const cost = HEADER_BUDGET_PX[child.className];
    expect(
      cost,
      `the sheet header has a block this budget does not account for: "${child.className}". ` +
        "Measure its outer height in a browser at 375 px and add it to HEADER_BUDGET_PX.",
    ).toBeTypeOf("number");
    total += cost ?? 0;
  }
  return total;
}

/**
 * The sheet header fits inside the sheet, at the sizes real phones come in.
 *
 * This is the test that would have caught the regression this control
 * introduced, and it is deliberately not "the preference row is absent at
 * peek" -- that assertion would go on passing against a header that overflowed
 * for some other reason. It asserts the geometry instead: whatever is in the
 * header has to fit in the snap that is showing it.
 *
 * `peek` is the state with no slack. `sheet.ts` calls it "just the search bar
 * and a hint of the list" and derives it from the viewport so "a short phone in
 * landscape still gets a usable peek instead of a sheet that swallows the map".
 * With the grip, a 179 px header left 17-64 px of list there. Adding the
 * preference row took the header to 233 and the list to 8-12 px -- and past the
 * bottom of the screen at 375x667 and on every notched phone, because the
 * safe-area inset comes out of the sheet's own height. Hence
 * `App`'s `roomForPreference`, and hence this.
 */
describe("the sheet header's height budget", () => {
  it("fits inside `peek` on every phone, with the preference row left out", async () => {
    await renderRanked();
    expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "peek");
    const cost = headerCost();
    for (const phone of PHONES) {
      const room = snapHeights(phone.height, TOP_BAR_PX).peek - phone.safeBottom;
      expect(
        cost,
        `${phone.name}: the sheet header needs ${cost} px and peek has ${room} px`,
      ).toBeLessThanOrEqual(room);
    }
  });

  it("fits inside `half` and `full`, with the preference row in it", async () => {
    await renderRanked();
    // The grip toggles peek <-> full; `half` is only reachable by a drag, so it
    // is asserted arithmetically off the same cost -- the row is rendered from
    // `half` upward, and `half` is never smaller than `full`'s header need.
    fireEvent.click(screen.getByRole("button", { name: t("en").expandList }));
    expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", "full");
    expect(screen.getByTestId("preference-picker")).toBeInTheDocument();

    const cost = headerCost();
    // The row really is what the two states differ by -- otherwise the peek test
    // above is asserting the same header twice and neither one is about the row.
    expect(cost).toBe(GRIP_PX + HEADER_PADDING_PX + 33 + 142 + 54);
    for (const phone of PHONES) {
      const heights = snapHeights(phone.height, TOP_BAR_PX);
      expect(cost, `${phone.name}: half`).toBeLessThanOrEqual(heights.half - phone.safeBottom);
      expect(cost, `${phone.name}: full`).toBeLessThanOrEqual(heights.full - phone.safeBottom);
    }
  });

  it("keeps the row out of the peek header and puts it back when the sheet opens", async () => {
    // The behaviour behind the arithmetic, and the accessibility half of it:
    // rendered rather than hidden in CSS, so at `peek` the control is absent
    // from the accessibility tree too, rather than being a radio group a screen
    // reader can reach and a sighted user cannot see.
    await renderRanked();
    expect(screen.queryByTestId("preference-picker")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: t("en").preferenceLabel })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: t("en").expandList }));
    expect(screen.getByRole("radiogroup", { name: t("en").preferenceLabel })).toBeInTheDocument();
    // ...and the preference it shows is still the one the ranking used while it
    // was off screen: `peek` hides the control, never the choice.
    expect(option("balanced")).toBeChecked();
    expect(rowIds()).toEqual(ORDERS.balanced);
  });

  it("always offers the row on the desktop panel, which has no `peek`", async () => {
    cleanup();
    stubMatchMedia(true);
    await renderRanked();
    expect(document.querySelector(".sheet")).toBeNull();
    expect(within(screen.getByTestId("panel")).getByTestId("preference-picker")).toBeInTheDocument();
  });
});

describe("the control's stylesheet", () => {
  const componentsCss = readFileSync(join(WEB, "src", "styles", "components.css"), "utf8");

  it("gives every option a 44 px tap target", () => {
    // jsdom lays nothing out, so this pins the rule where it is written; the
    // measurement that decides whether it is honoured is in a real browser.
    const rule = componentsCss.match(/\.pchip\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/min-height:\s*44px/);
  });

  it("colours the selected option off the checked input, not off a class", () => {
    // Same rule `.fchip[aria-pressed="true"]` follows: the look is keyed on the
    // state a screen reader is told, so the two cannot drift apart.
    expect(componentsCss).toMatch(/\.pchip:has\(input:checked\)/);
    // The input is visually hidden, so the focus ring has to be drawn on the
    // chip or a keyboard user cannot see where they are.
    expect(componentsCss).toMatch(/\.pchip:has\(input:focus-visible\)/);
  });
});
