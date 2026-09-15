/**
 * What the map is actually handed -- the one thing `app.test.tsx` cannot see.
 *
 * Those tests run the real `MapView` down its real no-WebGL path, so the map
 * mounts but never gets a MapLibre instance and its GeoJSON source is never
 * written. That blind spot hid the branch's worst bug: the map was fed the
 * *ranked* array, which is empty until a destination exists, so a first load
 * drew a basemap with zero of the roster's car parks on it and nothing said so.
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
 *
 * The second half of the file renders `MapView` **directly**. Selection, the
 * centre request and the padding under the sheet are a conversation between the
 * app shell and the map, and the only honest way to test the map's half of it is
 * to hand it the props and watch what it does to MapLibre. Those tests keep the
 * same fake map, so what they assert is still "what MapLibre was actually told".
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { FeatureCollection, Point } from "geojson";
import type { MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { HEADER_SIZE } from "../src/artifacts";
import { t } from "../src/i18n";
import MapView, { LOTS_SOURCE } from "../src/map/MapView";
import { toMapLot, type LotProperties, type MapLot } from "../src/map/lotSource";
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

/**
 * Every popup MapLibre was asked to open, in order.
 *
 * `MapView` imports `Popup` as a *value* -- the one thing in that module it
 * cannot express as a type -- and a real one would reach into the map instance
 * it is added to, which here is a plain object. So the class is replaced and
 * nothing else about `maplibre-gl` is needed: `useMapLibre` is mocked too, so
 * this file never touches the real library.
 */
const popups = vi.hoisted(() => ({ opened: [] as { lngLat: unknown; content: Node | null; removed: number }[] }));

vi.mock("maplibre-gl", () => {
  class FakePopup {
    lngLat: unknown = null;
    content: Node | null = null;
    /** How many times it was closed -- the real one is idempotent, so counting is enough. */
    removed = 0;
    setLngLat(at: unknown) {
      this.lngLat = at;
      return this;
    }
    setDOMContent(node: Node) {
      this.content = node;
      return this;
    }
    addTo() {
      popups.opened.push(this);
      return this;
    }
    remove() {
      this.removed += 1;
      return this;
    }
  }
  return { Popup: FakePopup };
});

interface FakeSource {
  data: unknown;
  setData(data: unknown): void;
}

/** A layer as `addLayer` received it, plus the layer it was inserted under. */
interface FakeLayer {
  id: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  /** The `beforeId` argument: what "under the dots" means, checkably. */
  before?: string;
}

type FakeHandler = (event: never) => void;

/** Just enough MapLibre for `MapView`'s effects: sources, layers, and taps. */
interface FakeMap {
  /** Layer specs by id, so a test can read the filter and paint, not just the name. */
  layerSpecs: Map<string, FakeLayer>;
  /** Handlers by `event|layer` -- `layer` empty for a map-wide one. */
  handlers: Map<string, Set<FakeHandler>>;
  addSource(id: string, spec: { data: unknown }): void;
  addLayer(spec: FakeLayer, before?: string): void;
  getSource(id: string): FakeSource | undefined;
  getLayer(id: string): object | undefined;
  removeLayer(id: string): void;
  removeSource(id: string): void;
  getBounds(): { contains(): boolean };
  easeTo: ReturnType<typeof vi.fn>;
  setPadding: ReturnType<typeof vi.fn>;
  setPaintProperty: ReturnType<typeof vi.fn>;
  setFilter: ReturnType<typeof vi.fn>;
  getCanvas(): { style: Record<string, string> };
  queryRenderedFeatures(): unknown[];
  getContainer(): HTMLElement;
  on(type: string, layerOrHandler: string | FakeHandler, handler?: FakeHandler): void;
  off(type: string, layerOrHandler: string | FakeHandler, handler?: FakeHandler): void;
}

/** The key a handler is filed under: MapLibre's own (event, layer) pair. */
function handlerKey(type: string, layer: string | null): string {
  return `${type}|${layer ?? ""}`;
}

function makeFakeMap(): FakeMap {
  const sources = new Map<string, FakeSource>();
  const layerSpecs = new Map<string, FakeLayer>();
  const handlers = new Map<string, Set<FakeHandler>>();
  const canvas = { style: {} as Record<string, string> };
  const container = document.createElement("div");
  const register = (
    add: boolean,
    type: string,
    layerOrHandler: string | FakeHandler,
    handler?: FakeHandler,
  ) => {
    const layer = typeof layerOrHandler === "string" ? layerOrHandler : null;
    const fn = typeof layerOrHandler === "string" ? handler : layerOrHandler;
    if (fn === undefined) return;
    const key = handlerKey(type, layer);
    const set = handlers.get(key) ?? new Set<FakeHandler>();
    handlers.set(key, set);
    if (add) set.add(fn);
    else set.delete(fn);
  };
  return {
    layerSpecs,
    handlers,
    addSource(id, spec) {
      sources.set(id, {
        data: spec.data,
        setData(data: unknown) {
          this.data = data;
        },
      });
    },
    addLayer: (spec, before) => void layerSpecs.set(spec.id, { ...spec, before }),
    getSource: (id) => sources.get(id),
    getLayer: (id) => (layerSpecs.has(id) ? {} : undefined),
    removeLayer: (id) => void layerSpecs.delete(id),
    removeSource: (id) => void sources.delete(id),
    getBounds: () => ({ contains: () => true }),
    easeTo: vi.fn(),
    setPadding: vi.fn(),
    setPaintProperty: vi.fn(),
    setFilter: vi.fn(),
    getCanvas: () => canvas,
    // Nothing is rendered in jsdom, so by default every tap is a tap on empty
    // map -- the branch `onPick` lives on. Replaceable per test, because "was
    // there a dot under the finger?" is the whole of the click model.
    queryRenderedFeatures: () => [],
    getContainer: () => container,
    // `project` is deliberately absent: jsdom has no projection, and the map's
    // ripple has to notice that rather than throw.
    on: (type, layerOrHandler, handler) => register(true, type, layerOrHandler, handler),
    off: (type, layerOrHandler, handler) => register(false, type, layerOrHandler, handler),
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
  popups.opened.length = 0;
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

/** The layer ids `MapView` keeps private; spelled out here so a rename is caught. */
const LOTS_LAYER = "lots-circles";
const LOTS_HALO_LAYER = "lots-halo";
const LOTS_BEST_HALO_LAYER = "lots-best-halo";
const LOTS_HOVER_HALO_LAYER = "lots-hover-halo";

/** The two placeable lots, as the app would project them. */
const MAP_LOTS: MapLot[] = [toMapLot(LOTS[0]!, 0.1), toMapLot(LOTS[2]!, 0.9)];

const NO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

/** Fire a handler the map registered, the way MapLibre would. */
function fire(type: string, layer: string | null, event: unknown): void {
  const registered = shared.map?.handlers.get(handlerKey(type, layer));
  if (registered === undefined || registered.size === 0) {
    throw new Error(`nothing is listening for "${type}" on ${layer ?? "the map"}`);
  }
  for (const handler of registered) (handler as (e: unknown) => void)(event);
}

describe("the map's selection, padding and taps", () => {
  it("haloes the selection and the best pick separately, and applies the padding it is given", () => {
    render(
      <MapView
        lots={MAP_LOTS}
        destination={null}
        lang="en"
        selectedId="TPE_A"
        bestId="TPE_C"
        centerRequest={null}
        padding={{ top: 0, right: 0, bottom: 300, left: 0 }}
      />,
    );

    // Two halo layers, each under the dots -- a ring around the dot, never a
    // substitute for it. Two and not one because only the best pick breathes,
    // and a paint property is set per layer.
    const halo = shared.map?.layerSpecs.get(LOTS_HALO_LAYER);
    const bestHalo = shared.map?.layerSpecs.get(LOTS_BEST_HALO_LAYER);
    expect(halo).toBeDefined();
    expect(bestHalo).toBeDefined();
    expect(halo?.before).toBe(LOTS_LAYER);
    expect(bestHalo?.before).toBe(LOTS_LAYER);
    expect(JSON.stringify(halo?.filter)).toContain("selected");
    expect(JSON.stringify(halo?.filter)).not.toContain("best");
    expect(JSON.stringify(bestHalo?.filter)).toContain("best");
    expect(JSON.stringify(bestHalo?.filter)).not.toContain("selected");

    // The sheet sits over the bottom of the map, so the map's idea of "centre"
    // has to move up by exactly as much.
    expect(shared.map?.setPadding).toHaveBeenCalledWith({ top: 0, right: 0, bottom: 300, left: 0 });

    // ...and the marks the halos filter on are on the features themselves.
    const drawn = shared.map?.getSource(LOTS_SOURCE)?.data as FeatureCollection<Point, LotProperties>;
    const selected = drawn.features.find((f) => f.id === "TPE_A");
    expect(selected?.properties.selected).toBe(true);
    expect(selected?.properties.best).toBe(false);
    expect(drawn.features.find((f) => f.id === "TPE_C")?.properties.best).toBe(true);
  });

  it("haloes the hovered card's dot through a filter, under the selection's ring", () => {
    const view = (hoverId: string | null) => (
      <MapView
        lots={MAP_LOTS}
        destination={null}
        lang="en"
        selectedId={null}
        bestId={null}
        hoverId={hoverId}
        centerRequest={null}
        padding={NO_PADDING}
      />
    );
    const { rerender } = render(view(null));

    // Its own layer, below the selection's: pointing at a card must never look
    // like having chosen it.
    const hover = shared.map?.layerSpecs.get(LOTS_HOVER_HALO_LAYER);
    expect(hover).toBeDefined();
    expect(hover?.before).toBe(LOTS_HALO_LAYER);

    // ...and hover moves that ring with `setFilter`, never by rebuilding the
    // source: a pointer crossing a list changes this many times a second.
    rerender(view("TPE_C"));
    expect(shared.map?.setFilter).toHaveBeenCalledWith(LOTS_HOVER_HALO_LAYER, ["==", ["get", "id"], "TPE_C"]);
    rerender(view(null));
    expect(shared.map?.setFilter).toHaveBeenLastCalledWith(LOTS_HOVER_HALO_LAYER, ["==", ["get", "id"], ""]);
  });

  it("eases to a centre request and selects the tapped lot", () => {
    const onSelectLot = vi.fn();
    const view = (centerRequest: { lat: number; lon: number; nonce: number } | null) => (
      <MapView
        lots={MAP_LOTS}
        destination={null}
        lang="en"
        selectedId={null}
        bestId={null}
        onSelectLot={onSelectLot}
        centerRequest={centerRequest}
        padding={NO_PADDING}
      />
    );
    const { rerender } = render(view(null));
    expect(shared.map?.easeTo).not.toHaveBeenCalled();

    // Tapping a card asks the map to go there. The nonce is what makes a second
    // tap on the *same* card move the map again.
    rerender(view({ lat: 25.03, lon: 121.56, nonce: 1 }));
    expect(shared.map?.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [121.56, 25.03] }),
    );

    // Tapping a dot is the same act from the other end: it selects the lot...
    fire("click", LOTS_LAYER, {
      features: [{ properties: { id: "TPE_C", name: "至善公園平面停車場", probability: 0.9 } }],
      lngLat: { lat: 25.0382, lng: 121.5643 },
      point: { x: 10, y: 20 },
    });
    expect(onSelectLot).toHaveBeenCalledWith("TPE_C");

    // ...and says which lot it is and what its chance is, and nothing else. The
    // expected-cost score ranks the list; it is not a thing to show a driver.
    const popup = popups.opened.at(-1);
    expect(popup?.content?.textContent).toContain("至善公園平面停車場");
    expect(popup?.content?.textContent).toContain("90%");

    // ...and it belongs to that dot alone. A selection made elsewhere -- a card
    // in the list -- is about a different lot, so the popup goes with it rather
    // than naming one car park over a halo sitting on another.
    expect(popup?.removed).toBe(0);
    rerender(
      <MapView
        lots={MAP_LOTS}
        destination={null}
        lang="en"
        selectedId="TPE_A"
        bestId={null}
        onSelectLot={onSelectLot}
        centerRequest={{ lat: 25.03, lon: 121.56, nonce: 1 }}
        padding={NO_PADDING}
      />,
    );
    expect(popup?.removed).toBeGreaterThan(0);
  });

  it("says no data on a lot with no forecast, never 0%", () => {
    render(
      <MapView
        lots={MAP_LOTS}
        destination={null}
        lang="en"
        selectedId={null}
        bestId={null}
        centerRequest={null}
        padding={NO_PADDING}
      />,
    );

    fire("click", LOTS_LAYER, {
      features: [{ properties: { id: "TPE_A", name: "市府路一號停車場", probability: null } }],
      lngLat: { lat: 25.0377, lng: 121.5639 },
      point: { x: 10, y: 20 },
    });

    const popup = popups.opened.at(-1);
    expect(popup?.content?.textContent).toContain(t("en").noData);
    expect(popup?.content?.textContent).not.toContain("0%");
  });

  it("breathes the best pick's halo and leaves the selection's alone", () => {
    vi.useFakeTimers();
    try {
      render(
        <MapView
          lots={MAP_LOTS}
          destination={null}
          lang="en"
          selectedId="TPE_A"
          bestId="TPE_C"
          centerRequest={null}
          padding={NO_PADDING}
        />,
      );

      // Two beats, so the toggle is seen going both ways.
      vi.advanceTimersByTime(2000);

      const opacity = (shared.map?.setPaintProperty.mock.calls ?? []).filter(
        (call) => call[1] === "circle-stroke-opacity",
      );
      expect(opacity.length).toBeGreaterThan(0);
      // The driver's own selection does not pulse: the app is not asking them to
      // reconsider the thing they just chose.
      for (const call of opacity) expect(call[0]).toBe(LOTS_BEST_HALO_LAYER);
      expect(new Set(opacity.map((call) => call[2])).size).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not take a tap on a dot as a tap on the city", () => {
    const onPick = vi.fn();
    render(
      <MapView
        lots={MAP_LOTS}
        destination={null}
        onPick={onPick}
        lang="en"
        selectedId={null}
        bestId={null}
        centerRequest={null}
        padding={NO_PADDING}
      />,
    );

    // MapLibre hands the same mouse event to both the dot handler and the
    // map-wide one; the dot's cannot cancel the map's. What keeps a tap on a car
    // park from also moving the destination is the map handler asking what is
    // under the point -- so here, something is.
    shared.map!.queryRenderedFeatures = () => [{ properties: { id: "TPE_C" } }];
    fire("click", null, { lngLat: { lat: 25.0382, lng: 121.5643 }, point: { x: 10, y: 20 } });

    expect(onPick).not.toHaveBeenCalled();
  });

  it("still takes a tap on empty map as the destination", () => {
    const onPick = vi.fn();
    render(
      <MapView
        lots={MAP_LOTS}
        destination={null}
        onPick={onPick}
        lang="en"
        selectedId={null}
        bestId={null}
        centerRequest={null}
        padding={NO_PADDING}
      />,
    );

    // Nothing under the point: the map is still the destination input it was
    // before any of this, and in this codebase's `{lat, lon}` order.
    fire("click", null, { lngLat: { lat: 25.03, lng: 121.56 }, point: { x: 10, y: 20 } });

    expect(onPick).toHaveBeenCalledWith({ lat: 25.03, lon: 121.56 });
  });
});
