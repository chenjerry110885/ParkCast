/**
 * What the map is actually handed -- the one thing `app.test.tsx` cannot see.
 *
 * Those tests run the real `MapView` down its real no-WebGL path, so the map
 * mounts but never gets a MapLibre instance and its GeoJSON source is never
 * written. That blind spot hid the branch's worst bug: the map was fed the
 * *ranked* array, which is empty until a destination exists, so a first load
 * drew a basemap with zero of 1,088 car parks on it and nothing said so.
 *
 * So this file stubs `useMapLibre` -- and only that -- with a map object that
 * records what is set on its sources. Everything above it is real: the fixture
 * goes through the real `loadArtifacts`, the real `App` and the real `MapView`
 * effects, and the assertions are on the FeatureCollection MapLibre would have
 * drawn.
 *
 * `MapView` now arrives behind `React.lazy`, so every test here waits for the
 * map region before reading what was drawn on it. That wait is the *only*
 * concession to the split: what is asserted afterwards is unchanged, because
 * the guarantee is unchanged -- the whole roster is on the map before anything
 * is tapped, and each dot reads its own declared grid row.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { FeatureCollection, Point } from "geojson";
import type { MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { HEADER_SIZE } from "../src/artifacts";
import { t } from "../src/i18n";
import { LOTS_SOURCE } from "../src/map/MapView";
import type { LotProperties } from "../src/map/lotSource";
import type { Lot, LotsDoc } from "../src/types";

const ROSTER_ID = 4242;
const N_HORIZONS = 24;
const STEP_MIN = 5;
const BASE_DATA_TS = 1788677280;

/**
 * The fake map, reachable from inside the hoisted `vi.mock` factory.
 *
 * `vi.hoisted` because the factory runs during the import of `App`, before any
 * ordinary `let` in this file has been initialised.
 */
const shared = vi.hoisted(() => ({ map: null as null | FakeMap }));

interface FakeSource {
  data: unknown;
  setData(data: unknown): void;
}

/** Just enough MapLibre for `MapView`'s effects: sources, layers, and taps. */
interface FakeMap {
  addSource(id: string, spec: { data: unknown }): void;
  addLayer(spec: { id: string }): void;
  getSource(id: string): FakeSource | undefined;
  getLayer(id: string): object | undefined;
  removeLayer(id: string): void;
  removeSource(id: string): void;
  getBounds(): { contains(): boolean };
  easeTo(): void;
  on(): void;
  off(): void;
}

function makeFakeMap(): FakeMap {
  const sources = new Map<string, FakeSource>();
  const layers = new Set<string>();
  return {
    addSource(id, spec) {
      sources.set(id, {
        data: spec.data,
        setData(data: unknown) {
          this.data = data;
        },
      });
    },
    addLayer: (spec) => void layers.add(spec.id),
    getSource: (id) => sources.get(id),
    getLayer: (id) => (layers.has(id) ? {} : undefined),
    removeLayer: (id) => void layers.delete(id),
    removeSource: (id) => void sources.delete(id),
    getBounds: () => ({ contains: () => true }),
    easeTo: () => {},
    on: () => {},
    off: () => {},
  };
}

vi.mock("../src/map/useMapLibre", () => ({
  useMapLibre: () => ({
    containerRef: { current: null },
    map: shared.map as unknown as MapLibreMap | null,
    unavailable: false,
  }),
}));

/**
 * Three lots, of which the middle one cannot be placed.
 *
 * `fetchLots` drops it -- it has no latitude -- which is exactly the case that
 * makes array position and grid row diverge. The survivors still declare rows 0
 * and 2, and row 2's forecast must follow `TPE_C` to its new position 1.
 */
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
    id: "TPE_UNPLACEABLE",
    n: "無座標停車場",
    a: "信義區",
    y: null as unknown as number,
    x: 121.5641,
    c: 40,
    t: "民營停車場",
    p: { k: "exact", lo: 60, hi: 60 },
  },
  {
    i: 2,
    id: "TPE_C",
    n: "至善公園平面停車場",
    a: "士林區",
    y: 25.0382,
    x: 121.5643,
    c: 13,
    t: "本處自營停車場",
    p: { k: "entry", lo: 50, hi: 50 },
  },
];

/** One distinct percentage per grid row, so a feature names the row it read. */
const ROW_MARK = [10, 50, 90];

function encodeGrid(): ArrayBuffer {
  const body: number[] = [];
  for (const lot of LOTS) {
    for (let h = 0; h < N_HORIZONS; h += 1) body.push(ROW_MARK[lot.i]!);
  }
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

/** `n_lots` counts the published roster, including the row we cannot place. */
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

/** The lots source as MapLibre would have received it. */
function drawnLots(): FeatureCollection<Point, LotProperties> {
  const source = shared.map?.getSource(LOTS_SOURCE);
  if (source === undefined) throw new Error("the map was never given a lots source");
  return source.data as FeatureCollection<Point, LotProperties>;
}

/**
 * Render, wait for the artifacts, then wait for the map's own chunk.
 *
 * The map is lazy, so it mounts a tick after the page does -- that is Task 2's
 * whole point, and it is asserted in `mapLazy.test.tsx`. Here it is only
 * something to wait for: the region carries the map's accessible name, and by
 * the time it is on the page `MapView`'s source and data effects have run.
 */
async function renderMapped(): Promise<void> {
  render(<App />);
  await screen.findByTestId("staleness");
  await screen.findByRole("region", { name: t("en").mapLabel });
}

beforeEach(() => {
  shared.map = makeFakeMap();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("grid.bin")) {
        return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(encodeGrid()) });
      }
      if (url.endsWith("lots.json")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(lotsDoc()) });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }),
  );
  vi.spyOn(Date, "now").mockReturnValue((BASE_DATA_TS + 4 * 60) * 1000);
  Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  shared.map = null;
});

describe("the map before a destination", () => {
  it("draws every placeable lot with nothing tapped and no location taken", async () => {
    await renderMapped();

    // The whole roster minus the row that could not be placed -- and, before
    // this was fixed, zero: the map was fed the ranking, which is empty until a
    // destination exists.
    expect(drawnLots().features).toHaveLength(2);
    expect(drawnLots().features.map((f) => f.properties.id)).toEqual(["TPE_A", "TPE_C"]);
    // Nothing has been chosen: no ranked list, and the start prompt is showing.
    expect(screen.queryByTestId("lot-list")).toBeNull();
  });

  it("gives each dot the forecast for its own grid row, not for its position", async () => {
    await renderMapped();

    // `TPE_C` declares row 2 and sits at position 1 once the unplaceable row is
    // dropped. Reading by position would hand it 50% -- its neighbour's number,
    // wrong and entirely plausible-looking.
    const drawn = drawnLots().features.find((f) => f.properties.id === "TPE_C");
    expect(drawn?.properties.probability).toBe(0.9);
    expect(drawn?.properties.probability).not.toBe(0.5);
  });

  it("keeps a lot with no forecast on the map rather than dropping it", async () => {
    // Guarding the other half of the honesty rule: an unknown lot is drawn grey
    // and flagged `known: false`, never filtered out and never coerced to 0.
    await renderMapped();

    for (const feature of drawnLots().features) {
      expect(feature.properties.known).toBe(feature.properties.probability !== null);
    }
  });
});
