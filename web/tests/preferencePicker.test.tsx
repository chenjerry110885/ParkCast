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
import App from "../src/App";
import { HEADER_SIZE } from "../src/artifacts";
import { EARTH_RADIUS_M } from "../src/geo";
import { t } from "../src/i18n";
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

/** A loaded app with a destination, so the ranked list is on screen. */
async function renderRanked(): Promise<void> {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
  await screen.findByTestId("lot-list");
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
    await renderRanked();
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
    await renderRanked();

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
    await renderRanked();
    choose("cheaper");
    expect(rowIds()).toEqual(ORDERS.cheaper);

    // The reload: this `App` is gone, and the only thing carried across is the
    // one word in `localStorage`.
    cleanup();
    map.renders.length = 0;
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBe("cheaper");

    await renderRanked();
    // The order first, because it is the half that cannot be faked: a fresh app
    // that ticked the box but ranked by Balanced fails on this line and passes
    // on the next.
    expect(rowIds()).toEqual(ORDERS.cheaper);
    expect(option("cheaper")).toBeChecked();
  });

  it("ranks by Balanced when storage holds something it does not recognise", async () => {
    window.localStorage.setItem(PREFERENCE_KEY, "closest");
    await renderRanked();
    expect(option("balanced")).toBeChecked();
    expect(rowIds()).toEqual(ORDERS.balanced);
  });

  it("re-ranks in place: nothing scrolls, the map is not re-centred, the arrival does not move", async () => {
    await renderRanked();
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
    await renderRanked();
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
    await renderRanked();
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
    await renderRanked();
    expect(within(screen.getByTestId("panel")).getByTestId("preference-picker")).toBeInTheDocument();
    expect(document.querySelector(".sheet")).toBeNull();

    choose("cheaper");
    expect(rowIds()).toEqual(ORDERS.cheaper);
    choose("closer");
    expect(rowIds()).toEqual(ORDERS.closer);
  });

  it("offers one option for every preset the ranker has prices for", async () => {
    await renderRanked();
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
