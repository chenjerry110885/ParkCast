/**
 * What the screen looks like while MapLibre is still on the wire.
 *
 * `app.test.tsx` can show that the map is absent for a tick; it cannot hold it
 * absent, because a real dynamic import resolves as fast as the test can look.
 * So this file replaces `map/MapView` with a component that suspends on a
 * promise the test owns, which is exactly how `React.lazy` suspends -- the
 * boundary, the fallback and everything around it are the shipped ones.
 *
 * The claim being tested is Task 2's entire reason to exist: the ranked list is
 * the answer to the user's question and the map is the illustration, so a
 * 333 KB illustration must not hold up the answer. Every assertion below is
 * made with the map's chunk still pending.
 *
 * Delete the `Suspense`/`lazy` pair in `App.tsx` and this file fails loudly:
 * a component that throws a promise with no boundary above it takes the render
 * down instead of showing a fallback.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { HEADER_SIZE } from "../src/artifacts";
import { t } from "../src/i18n";
import type { Lot, LotsDoc } from "../src/types";

/**
 * The map's chunk, as a switch.
 *
 * `vi.hoisted` because the mock factory below is lifted above every import in
 * this file, and it has to be able to reach this. Re-armed before each test so
 * the order tests run in cannot matter: each render gets its own pending
 * promise, and React caches the one it was thrown.
 */
const chunk = vi.hoisted(() => {
  const state = {
    arrived: false,
    pending: Promise.resolve(),
    land: () => {},
    /** The last props the map was rendered with, so a test can see what it was handed. */
    props: null as unknown,
  };
  return {
    state,
    /** Put the chunk back in flight. */
    reset() {
      state.arrived = false;
      state.props = null;
      state.pending = new Promise<void>((resolve) => {
        state.land = resolve;
      }).then(() => {
        state.arrived = true;
      });
    },
    /** Let it land, and wait until React has been told. */
    async arrive() {
      state.land();
      await state.pending;
    },
  };
});

vi.mock("../src/map/MapView", async () => {
  const { createElement } = await import("react");
  return {
    // Suspends the way a lazy chunk does, until the test says it has arrived,
    // and records what it was handed on the render it finally does.
    default: (props: unknown) => {
      chunk.state.props = props;
      if (!chunk.state.arrived) throw chunk.state.pending;
      return createElement("div", { "data-testid": "map-mounted" });
    },
  };
});

const ROSTER_ID = 4242;
const N_HORIZONS = 24;
const STEP_MIN = 5;
const BASE_DATA_TS = 1788677280;
const HERE = { lat: 25.0375, lon: 121.5637 };

/** Two lots is enough: this file is about load order, not about ranking. */
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
  {
    i: 1,
    id: "TPE_B",
    n: "至善公園平面停車場",
    a: "士林區",
    y: 25.038,
    x: 121.5641,
    c: 13,
    t: "本處自營停車場",
    p: { k: "entry", lo: 50, hi: 50 },
  },
];

/** `grid.bin` exactly as the Python encoder writes it: `<4sBIIHBBI`, no padding. */
function encodeGrid(): ArrayBuffer {
  const body: number[] = [];
  for (const _lot of LOTS) for (let h = 0; h < N_HORIZONS; h += 1) body.push(77);
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
  chunk.reset();
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
  vi.spyOn(Date, "now").mockReturnValue((BASE_DATA_TS + 4 * 60) * 1000);
  Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "geolocation");
});

/** Render and take the location, with the map's chunk still in flight. */
async function renderLocatedWithoutMap(): Promise<void> {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
  await screen.findByTestId("lot-list");
  // The premise of every assertion that follows.
  expect(screen.queryByTestId("map-mounted")).toBeNull();
}

describe("while the map's chunk is still downloading", () => {
  it("has already answered the question: the ranked list is on the screen", async () => {
    await renderLocatedWithoutMap();

    expect(screen.getByText(t("en").rankedForArrival)).toBeInTheDocument();
    for (const lot of LOTS) expect(screen.getByText(lot.n)).toBeInTheDocument();
    expect(screen.getAllByTestId("lot-row")).toHaveLength(LOTS.length);
    // The forecast is readable, not just present.
    expect(screen.getAllByTestId("lot-probability")[0]?.textContent).toContain("77%");
  });

  it("has the staleness line and the arrival control too", async () => {
    // The two things that make the list an answer rather than a snapshot: how
    // old the reading is, and which arrival time it is being read for. Neither
    // has anything to do with the map, so neither may wait for it.
    await renderLocatedWithoutMap();

    expect(screen.getByTestId("staleness").textContent).toBe("data from 4 min ago");
    expect(screen.getByLabelText(t("en").arrivingIn)).not.toBeDisabled();
  });

  it("says the map is loading, and does not say anything has failed", async () => {
    await renderLocatedWithoutMap();

    const placeholder = screen.getByTestId("map-loading");
    expect(placeholder.textContent).toBe(t("en").mapLoading);
    // A download in flight is not an error and is not announced as one.
    expect(placeholder.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(placeholder.textContent).not.toContain(t("en").loadFailed);
    // Nor is it the *other* map string, which means the device cannot draw one.
    expect(placeholder.textContent).not.toContain(t("en").mapUnavailable);
  });

  it("says it in Chinese too", async () => {
    await renderLocatedWithoutMap();
    fireEvent.click(screen.getByRole("button", { name: "切換為中文" }));
    await screen.findByRole("button", { name: t("zh").useMyLocation });

    expect(screen.getByTestId("map-loading").textContent).toBe(t("zh").mapLoading);
  });

  it("swaps the placeholder for the map when the chunk lands, and keeps the list", async () => {
    await renderLocatedWithoutMap();

    await act(async () => {
      await chunk.arrive();
    });

    expect(await screen.findByTestId("map-mounted")).toBeInTheDocument();
    expect(screen.queryByTestId("map-loading")).toBeNull();
    // The list was there before the map and is unchanged after it.
    expect(screen.getAllByTestId("lot-row")).toHaveLength(LOTS.length);
  });

  it("hands the late map the whole city, with nothing tapped and no location", async () => {
    // Plan 3c's guarantee, restated for the load order this task introduced:
    // the map can now mount *after* the artifacts, and it must still get every
    // lot rather than the ranking -- which is empty until a destination exists.
    // The roster is projected above the Suspense boundary precisely so that the
    // chunk landing late cannot miss data that landed early.
    render(<App />);
    await screen.findByTestId("staleness");
    expect(screen.queryByTestId("map-mounted")).toBeNull();

    await act(async () => {
      await chunk.arrive();
    });
    await screen.findByTestId("map-mounted");

    const props = chunk.state.props as { lots: readonly { id: string }[]; destination: unknown };
    expect(props.lots.map((lot) => lot.id)).toEqual(LOTS.map((lot) => lot.id));
    // Nothing was chosen, so there is no ranking -- and the map is full anyway.
    expect(props.destination).toBeNull();
    expect(screen.queryByTestId("lot-list")).toBeNull();
  });
});
