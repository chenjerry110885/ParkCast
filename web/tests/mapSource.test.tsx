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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FeatureCollection, Point } from "geojson";
import type { MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { COVERAGE_RADIUS_M, LIST_LIMIT } from "../src/App";
import { HEADER_SIZE, resetWeekCache } from "../src/artifacts";
import { WEEKLY_OBSERVATIONS } from "../src/confidence";
import { haversineMeters, walkMinutes } from "../src/geo";
import { districtName, fillTemplate, t } from "../src/i18n";
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

/** `grid.bin` exactly as the Python encoder writes it: `<4sBIIHBBI`, no padding. */
function encodeGridBody(body: number[], nLots: number): ArrayBuffer {
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

function encodeGrid(): ArrayBuffer {
  const body: number[] = [];
  for (const lot of LOTS) {
    for (let h = 0; h < N_HORIZONS; h += 1) body.push(ROW_MARK[lot.i]!);
  }
  return encodeGridBody(body, LOTS.length);
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

  it("stops pulsing the best pick's halo after a few beats", () => {
    // The pulse used to run for as long as the tab was open. Every paint change
    // re-renders the whole map, so that was a permanent 60 fps redraw of every
    // tile and label in aid of an animation nobody is still watching.
    vi.useFakeTimers();
    try {
      render(
        <MapView
          lots={MAP_LOTS}
          destination={null}
          lang="en"
          selectedId={null}
          bestId="TPE_C"
          centerRequest={null}
          padding={NO_PADDING}
        />,
      );

      vi.advanceTimersByTime(10_000);
      const settled = (shared.map?.setPaintProperty.mock.calls ?? []).length;
      expect(settled).toBeGreaterThan(0);

      vi.advanceTimersByTime(60_000);
      expect((shared.map?.setPaintProperty.mock.calls ?? []).length).toBe(settled);
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

/**
 * The dead end this file's fake map is the only way to reach.
 *
 * The map draws every car park in the roster and the list draws twenty, so
 * most dots on screen belong to no row. Tapping one already selected it --
 * `onSelectLot` fired, `App` set `selectedLotId`, the halo moved -- and then
 * nothing: `LotList` only renders a card for a row it was handed, so a lot
 * outside `listed` got a ring on the map and no way to read it.
 *
 * Every test here goes through the whole screen -- the real `loadArtifacts`,
 * the real ranker, the real `LotCard` -- and drives it the way MapLibre would:
 * one tap on empty map to say where the driver is going, then one on a dot.
 * Nothing asserts that "a card rendered"; a card showing the wrong car park
 * would pass that. What is asserted is the *identity* of the lot on the card,
 * from facts no listed lot in this fixture shares with it.
 */
describe("a car park the ranked list does not show", () => {
  /** Where the driver is going: the tap on empty map that sets the destination. */
  const DEST = { lat: 25.0375, lon: 121.5637 };

  /** The lot the complaint is about: ranked past the cap, and tapped anyway. */
  const OUTSIDER_ID = "TPE_OUTSIDER";
  const OUTSIDER_NAME = "北投公園地下停車場";
  /** Facts that belong to this lot and to no other row in the fixture. */
  const OUTSIDER_PERCENT = 34;
  const OUTSIDER_PRICE = 90;
  const OUTSIDER_FREE = 7;
  const OUTSIDER_CAPACITY = 200;

  /** A second one, so "tap another dot" has somewhere to land. */
  const SECOND_ID = "TPE_OUTSIDER_2";
  const SECOND_NAME = "洲美運動公園停車場";
  const SECOND_PERCENT = 12;

  /** Either side of the edge the list stops at: ~9.5 km out, and ~16.7 km out. */
  const EDGE_ID = "TPE_EDGE";
  const EDGE_NAME = "關渡宮地下停車場";
  const EDGE_PERCENT = 41;
  const FAR_ID = "TPE_FAR";
  const FAR_NAME = "淡水文化園區停車場";
  const FAR_PERCENT = 23;

  /** Every listed lot shares these, so any of them on the pinned card is caught. */
  const LISTED_PERCENT = 70;
  const LISTED_PRICE = 30;

  /**
   * Twenty-two near lots and two far ones, all priced and scored so that the
   * two outsiders can only rank last: lower probability, higher price, further
   * to walk. `LIST_LIMIT` is 20, so they are the rows the cap drops -- which is
   * the situation under test, produced by the real ranker rather than asserted
   * into being.
   */
  function crowd(): Lot[] {
    const near = Array.from({ length: 22 }, (_unused, k): Lot => ({
      i: k,
      id: `TPE_LISTED_${k}`,
      n: `已知停車場${k}`,
      a: "信義區",
      y: DEST.lat + 0.0002 * (k + 1),
      x: DEST.lon,
      c: 50,
      t: "民營停車場",
      p: { k: "exact", lo: LISTED_PRICE, hi: LISTED_PRICE },
    }));
    const outsiders: Lot[] = [
      {
        i: 22,
        id: OUTSIDER_ID,
        n: OUTSIDER_NAME,
        a: "北投區",
        y: DEST.lat + 0.02,
        x: DEST.lon,
        c: OUTSIDER_CAPACITY,
        t: "市府委外停車場",
        p: { k: "exact", lo: OUTSIDER_PRICE, hi: OUTSIDER_PRICE },
        f: OUTSIDER_FREE,
      },
      {
        i: 23,
        id: SECOND_ID,
        n: SECOND_NAME,
        a: "士林區",
        y: DEST.lat + 0.025,
        x: DEST.lon,
        c: 80,
        t: "民營停車場",
        p: { k: "exact", lo: OUTSIDER_PRICE, hi: OUTSIDER_PRICE },
      },
      // Due north of the destination, so the distance is the latitude
      // difference and nothing else. Both are asserted against
      // `COVERAGE_RADIUS_M` where they are used rather than trusted here.
      {
        i: 24,
        id: EDGE_ID,
        n: EDGE_NAME,
        a: "北投區",
        y: DEST.lat + 0.085,
        x: DEST.lon,
        c: 120,
        t: "市府委外停車場",
        p: { k: "exact", lo: OUTSIDER_PRICE, hi: OUTSIDER_PRICE },
      },
      {
        i: 25,
        id: FAR_ID,
        n: FAR_NAME,
        a: "淡水區",
        y: DEST.lat + 0.15,
        x: DEST.lon,
        c: 60,
        t: "民營停車場",
        p: { k: "exact", lo: OUTSIDER_PRICE, hi: OUTSIDER_PRICE },
      },
    ];
    return [...near, ...outsiders];
  }

  const CROWD = crowd();

  const OWN_PERCENT = new Map([
    [OUTSIDER_ID, OUTSIDER_PERCENT],
    [SECOND_ID, SECOND_PERCENT],
    [EDGE_ID, EDGE_PERCENT],
    [FAR_ID, FAR_PERCENT],
  ]);
  const percentOf = (lot: Lot): number => OWN_PERCENT.get(lot.id) ?? LISTED_PERCENT;

  function crowdedGrid(): ArrayBuffer {
    const body: number[] = [];
    for (const lot of CROWD) {
      for (let h = 0; h < N_HORIZONS; h += 1) body.push(percentOf(lot));
    }
    return encodeGridBody(body, CROWD.length);
  }

  beforeEach(() => {
    // Runs after the outer `beforeEach`, so this replaces its three-lot fixture.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("grid.bin")) {
          return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(crowdedGrid()) });
        }
        if (url.endsWith("lots.json")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                v: 1,
                generated_at: BASE_DATA_TS + 213,
                base_data_ts: BASE_DATA_TS,
                n_lots: CROWD.length,
                roster_id: ROSTER_ID,
                lots: CROWD,
              }),
          });
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      }),
    );
  });

  /** Render, wait for the map, then tap empty map to choose a destination. */
  async function renderWithDestination(): Promise<void> {
    render(<App />);
    await screen.findByTestId("staleness");
    await screen.findByRole("region", { name: t("en").mapLabel });
    // `queryRenderedFeatures` answers `[]` by default, so nothing is under the
    // point and the map-wide handler takes the tap as the destination.
    await act(async () => {
      fire("click", null, { lngLat: { lat: DEST.lat, lng: DEST.lon }, point: { x: 1, y: 1 } });
    });
    await screen.findByTestId("lot-list");
  }

  /** The tap MapLibre would deliver on a dot. */
  function tapDot(lot: Lot): void {
    act(() => {
      fire("click", LOTS_LAYER, {
        features: [{ properties: { id: lot.id, name: lot.n, probability: percentOf(lot) / 100 } }],
        lngLat: { lat: lot.y, lng: lot.x },
        point: { x: 10, y: 20 },
      });
    });
  }

  /** The rows the ranked list itself is drawing -- never the pinned card. */
  function listedRows(): HTMLElement[] {
    return within(screen.getByTestId("lot-list")).getAllByTestId("lot-row");
  }

  it("gives a tapped car park outside the list the list's own card", async () => {
    await renderWithDestination();

    // The situation: twenty rows, and this car park is not one of them.
    expect(listedRows()).toHaveLength(LIST_LIMIT);
    expect(screen.queryByText(OUTSIDER_NAME)).toBeNull();
    expect(screen.queryByTestId("pinned-lot")).toBeNull();

    tapDot(CROWD[22]!);

    const pinned = screen.getByTestId("pinned-lot");
    // Identity first: the name, then facts no listed lot carries -- its own
    // percentage, its own fare, its own observed count and its own district. A
    // card for the wrong car park passes "a card rendered" and fails all four.
    expect(within(pinned).getByTestId("lot-name")).toHaveTextContent(OUTSIDER_NAME);
    expect(within(pinned).getByTestId("lot-probability")).toHaveTextContent(`${OUTSIDER_PERCENT}%`);
    expect(within(pinned).getByTestId("lot-probability")).not.toHaveTextContent(`${LISTED_PERCENT}%`);
    expect(within(pinned).getByTestId("lot-price").textContent).toContain(`NT$${OUTSIDER_PRICE}`);
    expect(within(pinned).getByTestId("lot-spaces").textContent).toContain(
      `${OUTSIDER_FREE} / ${OUTSIDER_CAPACITY}`,
    );
    // The district, which is chrome and so *is* translated -- unlike the lot's
    // own name above, which is the sign at the entrance and never is.
    expect(pinned.textContent).toContain(districtName("北投區", "en"));
    expect(pinned.textContent).not.toContain(districtName("信義區", "en"));
    // "The same detail as the list's card": every tile a listed card carries.
    for (const tile of ["lot-walk", "lot-price", "lot-arrival"]) {
      expect(within(listedRows()[0]!).getByTestId(tile)).toBeInTheDocument();
      expect(within(pinned).getByTestId(tile)).toBeInTheDocument();
    }

    // Above the ranked list, and the list is untouched by it: still twenty
    // rows, still without this car park among them.
    expect(pinned.compareDocumentPosition(screen.getByTestId("lot-list"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(listedRows()).toHaveLength(LIST_LIMIT);
    expect(listedRows().map((row) => row.getAttribute("data-lot-id"))).not.toContain(OUTSIDER_ID);
  });

  it("never crowns it, and never pulses its dot", async () => {
    await renderWithDestination();
    tapDot(CROWD[22]!);

    const pinned = screen.getByTestId("pinned-lot");
    // The badge the ranking withholds from lots it cannot vouch for is withheld
    // with more force from one the ranking's output never reached.
    expect(within(pinned).queryByText(t("en").bestPick)).toBeNull();
    expect(pinned.querySelector(".lot-card--best")).toBeNull();
    // ...and the crown is still where the ranking put it.
    expect(within(screen.getByTestId("lot-list")).getByText(t("en").bestPick)).toBeInTheDocument();

    // The map says the same thing: this dot is selected and is not the best
    // pick, so the layer that pulses can never match it.
    const drawn = drawnLots().features.find((f) => f.properties.id === OUTSIDER_ID);
    expect(drawn?.properties.selected).toBe(true);
    expect(drawn?.properties.best).toBe(false);
    expect(drawnLots().features.filter((f) => f.properties.best)).toHaveLength(1);
  });

  it("replaces the card when a second dot is tapped, rather than stacking them", async () => {
    await renderWithDestination();
    tapDot(CROWD[22]!);
    expect(within(screen.getByTestId("pinned-lot")).getByTestId("lot-name")).toHaveTextContent(OUTSIDER_NAME);

    tapDot(CROWD[23]!);

    const pinned = screen.getByTestId("pinned-lot");
    expect(screen.getAllByTestId("pinned-lot")).toHaveLength(1);
    expect(within(pinned).getByTestId("lot-name")).toHaveTextContent(SECOND_NAME);
    expect(within(pinned).getByTestId("lot-probability")).toHaveTextContent(`${SECOND_PERCENT}%`);
    // The first car park is gone from the screen entirely, not merely demoted.
    expect(screen.queryByText(OUTSIDER_NAME)).toBeNull();
  });

  it("leaves a lot the list already shows in the list, with no second copy", async () => {
    await renderWithDestination();
    const id = listedRows()[0]!.getAttribute("data-lot-id") ?? "";
    const lot = CROWD.find((l) => l.id === id);
    expect(lot).toBeDefined();

    tapDot(lot!);

    // Today's behaviour, unchanged: the row highlights where it already is.
    expect(screen.queryByTestId("pinned-lot")).toBeNull();
    expect(listedRows()).toHaveLength(LIST_LIMIT);
    expect(screen.getByTestId("lot-list").querySelector(`[data-lot-id="${id}"]`)?.className).toContain(
      "lot-card--selected",
    );
    expect(screen.getAllByText(lot!.n)).toHaveLength(1);
  });

  /**
   * A uniform `week.bin`: the same probability and the same support in all 336
   * buckets, so this test is about *whether* a card was given its lot's support
   * at all and not about which half-hour it read (`app.test.tsx` owns that, and
   * `seam.test.ts` owns agreeing with Python about it).
   *
   * Header `<4sBIHHBI`, no padding, mirroring `web/src/week.ts` -- laid out by
   * hand here for the same reason `encodeGridBody` is: a fixture written by the
   * code under test can only prove the client agrees with itself.
   */
  function encodeWeek(percent: number, support: number): ArrayBuffer {
    const buckets = 336;
    const buf = new ArrayBuffer(18 + CROWD.length * buckets * 2);
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    bytes.set(new TextEncoder().encode("PCW1"), 0);
    dv.setUint8(4, 1);
    dv.setUint32(5, BASE_DATA_TS - 3600, true);
    dv.setUint16(9, CROWD.length, true);
    dv.setUint16(11, buckets, true);
    dv.setUint8(13, 30);
    dv.setUint32(14, ROSTER_ID, true);
    for (let cell = 0; cell < CROWD.length * buckets; cell += 1) {
      bytes[18 + cell * 2] = percent;
      bytes[18 + cell * 2 + 1] = support;
    }
    return buf;
  }

  /**
   * The pinned card's confidence grade has to rest on this lot's own history,
   * exactly as a listed card's does.
   *
   * `supportById` is built over the rows that render a card, and the pinned row
   * has to be one of them: `LotCard`'s `support` defaults to `0`, which
   * `confidence.ts` reads as its *thinnest* evidence ("not watched at this time
   * of week often enough yet"). A pinned row left out of that map therefore
   * does not fail loudly -- it renders "Low · thin" beside twenty cards reading
   * "High · 5 weeks" for the same arrival, a card quietly less informative than
   * the list's, which is the one thing it exists not to be.
   *
   * Reached without touching the arrival picker: a reading 110 minutes old puts
   * the default +15 min arrival 125 minutes past it, which is beyond the grid's
   * 120-minute span but not far enough for `forecastExpired`, so `week.bin` is
   * fetched and the reading is too old to carry the grade on its own. Support
   * is then the only thing left deciding it, which is what makes the two
   * outcomes visibly different.
   */
  it("grades the pinned card on its own history, not on a default of none", async () => {
    resetWeekCache();
    const week = encodeWeek(73, 5 * WEEKLY_OBSERVATIONS);
    const grid = crowdedGrid();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("grid.bin")) {
          return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(grid) });
        }
        if (url.endsWith("week.bin")) {
          return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(week) });
        }
        if (url.endsWith("lots.json")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                v: 1,
                generated_at: BASE_DATA_TS + 213,
                base_data_ts: BASE_DATA_TS,
                n_lots: CROWD.length,
                roster_id: ROSTER_ID,
                lots: CROWD,
              }),
          });
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue((BASE_DATA_TS + 110 * 60) * 1000);

    await renderWithDestination();
    // The table has landed and the page says the numbers came out of it.
    await screen.findByTestId("from-history");

    // The list's own cards grade on five weeks of history, the reading being
    // far too old to speak for itself.
    const listedPill = within(listedRows()[0]!).getByRole("button", { name: /Confidence/ });
    await waitFor(() => expect(listedPill).toHaveTextContent(t("en").confidenceHigh));

    tapDot(CROWD[22]!);

    const pinned = screen.getByTestId("pinned-lot");
    const pill = within(pinned).getByRole("button", { name: /Confidence/ });
    expect(pill).toHaveTextContent(t("en").confidenceHigh);
    expect(pill).not.toHaveTextContent(t("en").confidenceLow);
    // ...and the evidence it names is the history, not a bare grade: the
    // popover is where a default of `0` would have said "not watched yet".
    fireEvent.click(pill);
    expect(within(pinned).getByRole("note").textContent).toBe(
      fillTemplate(t("en").confidenceWeeksTemplate, { n: 5 }),
    );
  });

  /** A fixture lot by id, so a test names the car park it means. */
  function lotById(id: string): Lot {
    const found = CROWD.find((l) => l.id === id);
    if (found === undefined) throw new Error(`no fixture lot ${id}`);
    return found;
  }

  /**
   * The card is bounded by the tapped lot's own distance, not the
   * destination's.
   *
   * `ranked` has no distance cutoff, so every dot on the map has a row behind
   * it however far away it is -- and the card's walk tile renders whatever
   * that row's `meters` divides into. On the real roster, with the
   * destination at Taipei 101 and a car park 55 m from it, 100 of the 1,090
   * lots are still more than 10 km away and the farthest is 16,439 m: a
   * 206-minute walk on a card, true to the metre and describing a trip
   * nobody is going to make.
   *
   * A gate on the *destination* cannot see that case -- it asks whether
   * anything is near where the driver is going, which is a different
   * question. These two pin the per-row bound from both sides.
   */
  it("gives a card to a car park just inside the edge the list stops at", async () => {
    const edge = lotById(EDGE_ID);
    // The premise, measured rather than asserted into being.
    expect(haversineMeters(DEST, { lat: edge.y, lon: edge.x })).toBeLessThan(COVERAGE_RADIUS_M);
    await renderWithDestination();
    expect(listedRows().map((row) => row.getAttribute("data-lot-id"))).not.toContain(EDGE_ID);

    tapDot(edge);

    const pinned = screen.getByTestId("pinned-lot");
    expect(within(pinned).getByTestId("lot-name")).toHaveTextContent(EDGE_NAME);
    expect(within(pinned).getByTestId("lot-probability")).toHaveTextContent(`${EDGE_PERCENT}%`);
    // Nine and a half kilometres is a long walk and the card says so; what it
    // does not do is refuse to answer a question the ranker can answer.
    expect(within(pinned).getByTestId("lot-walk")).toBeInTheDocument();
  });

  it("answers a car park past that edge with the map's popup, not with a manufactured walk", async () => {
    const far = lotById(FAR_ID);
    const meters = haversineMeters(DEST, { lat: far.y, lon: far.x });
    expect(meters).toBeGreaterThan(COVERAGE_RADIUS_M);
    await renderWithDestination();
    // The destination has a car park 22 m from it, so `outsideCoverage` is
    // false and its notice is not on screen: this is the case a gate on the
    // destination's own surroundings can never reach.
    expect(screen.queryByTestId("outside-coverage")).toBeNull();

    tapDot(far);

    expect(screen.queryByTestId("pinned-lot")).toBeNull();
    // Not merely "no card": the number the card would have carried is
    // nowhere on the screen either.
    const minutes = walkMinutes(meters);
    expect(minutes).toBeGreaterThan(200);
    expect(screen.queryByText(new RegExp(String(minutes)))).toBeNull();
    // The tap is still answered, by the same fallback a tap with no
    // destination gets: the lot's name and its chance, and nothing else.
    const popup = popups.opened.at(-1);
    expect(popup?.content?.textContent).toContain(FAR_NAME);
    expect(popup?.content?.textContent).toContain(`${FAR_PERCENT}%`);
    // ...and the list the driver already had is untouched by the tap.
    expect(listedRows()).toHaveLength(LIST_LIMIT);
  });

  it("shows no card when the destination itself has nothing within reach", async () => {
    render(<App />);
    await screen.findByTestId("staleness");
    await screen.findByRole("region", { name: t("en").mapLabel });
    // Kaohsiung: ~290 km from every car park in this fixture, so nothing in
    // `ranked` is inside the radius and the list stands down.
    await act(async () => {
      fire("click", null, { lngLat: { lat: 22.63, lng: 120.3 }, point: { x: 1, y: 1 } });
    });
    await screen.findByTestId("outside-coverage");

    tapDot(lotById(OUTSIDER_ID));

    // The per-row bound covers this direction too, which is why the render
    // gate no longer repeats `outsideCoverage`: if no row is within the
    // radius then the tapped row is not either.
    expect(screen.queryByTestId("pinned-lot")).toBeNull();
    expect(screen.queryByTestId("lot-list")).toBeNull();
    // The notice says in words how far away everything is, and the popup
    // still names the car park that was tapped.
    expect(popups.opened.at(-1)?.content?.textContent).toContain(OUTSIDER_NAME);
  });

  it("shows no card before a destination is chosen, and does not go silent either", async () => {
    render(<App />);
    await screen.findByTestId("staleness");
    await screen.findByRole("region", { name: t("en").mapLabel });

    tapDot(CROWD[22]!);

    // Nothing to rank against, so there is no row to render: three of the
    // card's four fact tiles measure a trip that has no destination yet, and
    // inventing one would be the manufactured number this app exists to refuse.
    expect(screen.queryByTestId("pinned-lot")).toBeNull();
    expect(screen.queryByTestId("lot-list")).toBeNull();
    // The tap is still answered -- by the map's own popup -- and the page still
    // says how to get the rest.
    const popup = popups.opened.at(-1);
    expect(popup?.content?.textContent).toContain(OUTSIDER_NAME);
    expect(popup?.content?.textContent).toContain(`${OUTSIDER_PERCENT}%`);
    expect(screen.getByText(t("en").startPromptMap)).toBeInTheDocument();
  });
});
