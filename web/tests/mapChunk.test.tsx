/**
 * The one thing only a first render can prove: the map's import is *dynamic*.
 *
 * `React.lazy` caches. Once its chunk has resolved, every later render of that
 * component is synchronous, so the window in which the map is provably absent
 * exists exactly once per module registry -- and vitest gives each test file its
 * own. Hence a file with a single render in it: this is the render a driver's
 * browser does, on a cold load, and the only one that can see the difference
 * between a dynamic `import()` and a static one.
 *
 * **Do not add a second `render` to this file**, and do not fold this into
 * `app.test.tsx`: the assertion would pass or fail depending on whether some
 * earlier test had already pulled the chunk in, which is the kind of green that
 * means nothing.
 *
 * Mutation check: turn `lazy(() => import("./map/MapView"))` in `App.tsx` back
 * into a static `import` and the first two assertions below fail together --
 * MapLibre's no-WebGL notice is already on the page, and the placeholder never
 * existed. `mapLazy.test.tsx` keeps passing under that mutation, which is
 * precisely why this file is separate from it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { HEADER_SIZE } from "../src/artifacts";
import { t } from "../src/i18n";
import type { Lot, LotsDoc } from "../src/types";

const ROSTER_ID = 4242;
const N_HORIZONS = 24;
const STEP_MIN = 5;
const BASE_DATA_TS = 1788677280;

const LOTS: Lot[] = [
  {
    i: 0,
    id: "TPE_A",
    n: "市府路一號停車場",
    a: "信義區",
    y: 25.0377,
    x: 121.5639,
    c: 120,
    t: "民營停車場",
    p: { k: "exact", lo: 60, hi: 60 },
  },
];

/** `grid.bin` exactly as the Python encoder writes it: `<4sBIIHBBI`, no padding. */
function encodeGrid(): ArrayBuffer {
  const body = Array.from({ length: LOTS.length * N_HORIZONS }, () => 77);
  const buf = new ArrayBuffer(HEADER_SIZE + body.length);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode("PCG1"), 0);
  dv.setUint8(4, 1);
  dv.setUint32(5, BASE_DATA_TS + 213, true);
  dv.setUint32(9, BASE_DATA_TS, true);
  dv.setUint16(13, LOTS.length, true);
  dv.setUint8(15, N_HORIZONS);
  dv.setUint8(16, STEP_MIN);
  dv.setUint32(17, ROSTER_ID, true);
  new Uint8Array(buf).set(body, HEADER_SIZE);
  return buf;
}

function lotsDoc(): LotsDoc {
  return {
    v: 1,
    generated_at: BASE_DATA_TS + 213,
    base_data_ts: BASE_DATA_TS,
    n_lots: LOTS.length,
    roster_id: ROSTER_ID,
    lots: LOTS,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("grid.bin")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(encodeGrid()),
        });
      }
      if (url.endsWith("lots.json")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(lotsDoc()) });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }),
  );
  // jsdom has no WebGL and says so loudly; answering `null` ourselves is the
  // same answer without the noise, and puts `MapView` on its real no-WebGL
  // path -- which is what makes its arrival visible as rendered text.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(Date, "now").mockReturnValue((BASE_DATA_TS + 4 * 60) * 1000);
  Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a cold first render", () => {
  it("paints the page without the map, then lets the map in", async () => {
    render(<App />);

    // Nothing of `MapView` is on the page: a dynamic import cannot resolve in
    // the tick that started it.
    expect(screen.queryByText(t("en").mapUnavailable)).toBeNull();
    // Its space is held all the same -- by a loading state, not by a gap and
    // not by an error.
    const placeholder = screen.getByTestId("map-loading");
    expect(placeholder.textContent).toBe(t("en").mapLoading);
    expect(placeholder.getAttribute("role")).toBe("status");
    // The class that carries `--map-height`, so the list is not sitting where
    // the map will be. The height itself is CSS and is checked in a browser.
    expect(placeholder.className).toContain("map-placeholder");
    // The app around it is already usable: this is the whole point.
    expect(screen.getByRole("heading", { name: t("en").appName })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("en").useMyLocation })).toBeEnabled();

    // ...and the chunk lands on its own, with the placeholder standing down.
    await screen.findByText(t("en").mapUnavailable);
    expect(screen.queryByTestId("map-loading")).toBeNull();
  });
});
