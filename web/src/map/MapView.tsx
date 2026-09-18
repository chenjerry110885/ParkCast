/**
 * The map: every car park in the roster over a self-hosted basemap, coloured by
 * its chance of having a space at the driver's arrival time.
 *
 * Every lot is one point in **one** GeoJSON source, drawn by one circle layer
 * for the dots and three more underneath: a halo around the selection, a second
 * one around the best pick, which is the one that breathes, and a third, faintest
 * one under both for the card the pointer is over. The obvious
 * alternative -- a `maplibregl.Marker` per lot -- puts a thousand
 * absolutely-positioned DOM nodes on the page and repositions every one of them
 * on every frame of a pan. That is the difference between a map that glides and
 * one that stutters on the phone this app is meant to be used on. The selection
 * is a *property on the feature* for the same reason: moving the ring is one
 * `setData`, not a DOM node that follows a lot around.
 *
 * Colour comes from the feature's own `colour` property rather than from a
 * paint expression that re-derives it, so the map, the list and `colour.ts`
 * cannot drift apart -- and in particular the "no forecast" grey is decided in
 * exactly one place. Unknown lots are also drawn dimmer than known ones: two
 * channels saying the same true thing, for the reader who does not have the
 * legend memorised. That choice has a price, and it is worth stating: a change
 * of arrival time recolours the dots *instantly*, because MapLibre transitions
 * paint properties and not the data underneath them, so there is no
 * `circle-color-transition` to be had on a `["get", "colour"]` fill. The
 * animated reading of a forecast changing is the card's ring, not the map.
 *
 * **This module is a lazy boundary, and the component is a *default* export for
 * that reason.** MapLibre and its stylesheet are 333 KB gzipped between them --
 * more than everything else the app ships put together -- and a static import
 * here made the ranked list, which is the app's actual answer, wait for all of
 * it. `App.tsx` reaches this file through `React.lazy` instead, which needs a
 * default export. There is deliberately no named component export: a stray
 * `import { MapView }` anywhere would pull MapLibre straight back into the
 * entry chunk, and nothing in the build output would say so.
 */
import { useEffect, useMemo, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
// The one value this module takes from MapLibre. Everything else is a type, so
// the lazy boundary above still decides when the library itself is downloaded.
import { Popup } from "maplibre-gl";
import type { GeoJSONSource, MapLayerMouseEvent, MapMouseEvent } from "maplibre-gl";
import type { LatLon } from "../geo";
import { t, type Lang } from "../i18n";
import { prefersReducedMotion } from "../motion";
import { toFeatureCollection, toPointCollection, type MapLot } from "./lotSource";
import { useMapLibre } from "./useMapLibre";

/** Exported so a test can assert on the source the app actually feeds. */
export const LOTS_SOURCE = "lots";
const LOTS_LAYER = "lots-circles";
/**
 * Two halo layers, not one with a filter that matches both.
 *
 * The best pick breathes and the selection does not, and a paint property is
 * set per *layer*: one layer for both would mean the driver's own selection
 * pulsing along with the recommendation, which says the app is unsure about the
 * thing the driver just chose.
 */
const LOTS_HALO_LAYER = "lots-halo";
const LOTS_BEST_HALO_LAYER = "lots-best-halo";

/**
 * How much of a dot is left when the list's amenity filter has taken its car
 * park out of the list. Exported so a test can pin it against the opacities
 * either side of it rather than restating a number.
 *
 * Faint enough that the lots the driver *can* use are what the eye lands on,
 * and well clear of the 0.5 an unknown-forecast dot already gets, so dimming
 * for the filter cannot be mistaken for dimming for no data. Not zero, and not
 * a `filter` that removes the feature: an invisible car park is an absent one,
 * and this app does not do absent (`MapLot.filteredOut`).
 */
export const FILTERED_OUT_OPACITY = 0.2;
/**
 * The third ring: the card the pointer is over, on desktop.
 *
 * Its own layer with a filter on the hovered id, rather than a third boolean on
 * the features or MapLibre's feature-state. The source stays what `lotSource.ts`
 * says it is -- a pure reshape of the roster -- and hover changes many times a
 * second while a mouse crosses a list, which is a `setFilter` on one layer
 * rather than a rebuilt `FeatureCollection` per frame.
 */
const LOTS_HOVER_HALO_LAYER = "lots-hover-halo";
const DESTINATION_SOURCE = "destination";
const DESTINATION_LAYER = "destination-pin";

/** `--accent` in `styles/tokens.css`. The halo is the same teal as the app's own. */
const ACCENT = "#0fb5a5";
/** The ring at rest, and at the bottom of the best pick's breath. */
const HALO_OPACITY = 0.55;
const HALO_OPACITY_DIM = 0.2;
/** The hover ring, fainter than either of the other two: a hint, not a choice. */
const HOVER_HALO_OPACITY = 0.5;
/** One breath per second, each one slower than a blink: noticeable, not busy. */
const PULSE_EVERY_MS = 1000;
/** Half-beats: three dim-and-back cycles, then the halo holds still. */
const PULSE_STEPS = 6;
const PULSE_FADE_MS = 900;
/** The glide to a lot the driver tapped in the list. */
const CENTRE_MS = 600;
/** Covers both rings of the destination ripple, including the late one's delay. */
const RIPPLE_MS = 1200;

export interface MapViewProps {
  /**
   * Every lot to draw: the whole roster, not the slice the list shows -- and
   * not the ranking either. A dot needs an identity, a position and a
   * probability, none of which come from where the driver is going, so the map
   * is drawn from the artifacts and is full before a destination exists.
   */
  lots: readonly MapLot[];
  /** Where the driver is going, drawn as a pin. `null` before one is chosen. */
  destination: LatLon | null;
  /** Called with the tapped point, so the map can *be* the destination input. */
  onPick?: (at: LatLon) => void;
  lang: Lang;
  /** The lot the driver has tapped, in the list or here. Haloed, not recoloured. */
  selectedId: string | null;
  /** The lot the ranking put first. Haloed too, and the only one that pulses. */
  bestId: string | null;
  /**
   * The lot whose card the pointer is over, or `null`. Drawn as a fainter ring
   * *under* the selection's, so pointing at a card can never be mistaken for
   * having chosen it. Absent on touch, where there is no hover to report.
   */
  hoverId?: string | null;
  /** A dot was tapped. The map does not own the selection; it reports one. */
  onSelectLot?: (id: string) => void;
  /**
   * Whether the app is going to draw a full card for this lot, asked at the
   * moment of the tap.
   *
   * The popup below is the *fallback* answer -- a lot's name and its chance --
   * for the dots the app cannot card: no destination to measure a trip to, or
   * a car park further from it than the ranking means anything at. Which dots
   * those are is the app's question and not the map's (it turns on a ranking
   * this module has never seen), and it has to be answered *synchronously*:
   * `onDot` runs inside a MapLibre event handler, before React has re-rendered,
   * so a prop would be one selection out of date and a dot whose card is about
   * to open would flash a bubble first. Hence a predicate rather than a flag.
   *
   * Absent means "no card ever", which is what a `MapView` rendered on its own
   * -- every test in `mapSource.test.tsx`'s second half -- should get.
   */
  hasCard?: (id: string) => boolean;
  /**
   * Where to move the view, how far below the middle to leave it, and *which
   * time* the request was made.
   *
   * The nonce is the whole point: tapping the same card twice is two requests
   * for the same coordinates, and without it the second one would be
   * indistinguishable from a re-render. The map eases when the nonce changes
   * and at no other time, so a parent that re-renders mid-pan cannot yank the
   * view out from under a finger.
   *
   * `offsetY` is how the app keeps a lot out from under something it has drawn
   * over the map -- its own card, today. Padding could do the same job and does
   * not, because padding also moves the picture when it is taken away again;
   * this rides with the movement that was going to happen anyway. Optional and
   * `0` by default: most requests just want the middle.
   */
  centerRequest: { lat: number; lon: number; offsetY?: number; nonce: number } | null;
  /**
   * The chrome covering the map's edges, in pixels -- the sheet at the bottom,
   * the panel at the side. MapLibre centres on the *unpadded* middle, so this
   * is what keeps a lot the driver just tapped from arriving underneath the
   * sheet that was showing it.
   */
  padding: { top: number; right: number; bottom: number; left: number };
}

export default function MapView({
  lots,
  destination,
  onPick,
  lang,
  // Defaulted because each one has a real opening state: nothing selected,
  // nothing ranked yet, nowhere asked for, and no chrome over the map.
  selectedId = null,
  bestId = null,
  hoverId = null,
  onSelectLot,
  hasCard,
  centerRequest = null,
  padding = { top: 0, right: 0, bottom: 0, left: 0 },
}: MapViewProps) {
  const { containerRef, map, unavailable } = useMapLibre(lang);
  const s = t(lang);

  const features = useMemo(
    () => toFeatureCollection(lots, { selectedId, bestId }),
    [lots, selectedId, bestId],
  );
  const pin = useMemo(() => toPointCollection(destination), [destination]);

  // The taps outlive the render that registered them, so the handler reads the
  // latest callback from a ref instead of being torn down and re-added on every
  // parent render. The strings ride along for the same reason: the popup is
  // written by a handler registered once, in whatever language is current when
  // it fires rather than when it was registered.
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  const onSelectLotRef = useRef(onSelectLot);
  useEffect(() => {
    onSelectLotRef.current = onSelectLot;
  }, [onSelectLot]);

  const hasCardRef = useRef(hasCard);
  useEffect(() => {
    hasCardRef.current = hasCard;
  }, [hasCard]);

  const stringsRef = useRef(s);
  useEffect(() => {
    stringsRef.current = s;
  }, [s]);

  /** The one popup, so the selection effect below can close what a tap opened. */
  const popupRef = useRef<Popup | null>(null);
  /** Which lot the open popup is about, or `null` when none is open. */
  const popupForRef = useRef<string | null>(null);

  const centerRequestRef = useRef(centerRequest);
  useEffect(() => {
    centerRequestRef.current = centerRequest;
  }, [centerRequest]);

  // Sources and layers, once per map. Added empty: the data effect below runs
  // in the same commit, immediately after this one.
  useEffect(() => {
    if (map === null) return;
    const empty = toPointCollection(null);

    map.addSource(LOTS_SOURCE, { type: "geojson", data: empty });
    map.addLayer({
      id: LOTS_LAYER,
      type: "circle",
      source: LOTS_SOURCE,
      paint: {
        // Small enough at city zoom that a thousand dots stay a texture rather
        // than a blob, big enough to hit with a thumb once in a district.
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 13, 5, 16, 9],
        "circle-color": ["get", "colour"],
        // Three cases, in this order, because the first one outranks the
        // other two: a lot the list's amenity filter took out is drawn faint
        // whatever its forecast says, since the question the driver is asking
        // right now is "which of these can I use", and a bright dot for a car
        // park the list refuses to recommend answers it wrongly. It is still
        // *drawn* -- see `MapLot.filteredOut` for why removing it is not on
        // the table -- and still tappable, and its card still tells the truth
        // about the field. `["boolean", ..., false]` supplies the unfiltered
        // default for a feature written before this property existed.
        "circle-opacity": [
          "case",
          ["boolean", ["get", "filteredOut"], false], FILTERED_OUT_OPACITY,
          ["get", "known"], 0.9,
          0.5,
        ],
        "circle-stroke-width": 1,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-opacity": [
          "case",
          ["boolean", ["get", "filteredOut"], false], FILTERED_OUT_OPACITY,
          0.75,
        ],
      },
    });
    // The halos, *under* the dots: a ring around the selection and a ring
    // around the best pick, never a recolouring of either. Colour on this map
    // means one thing -- the chance of a space -- and a second meaning laid
    // over the same channel would make both unreadable. Their own layers rather
    // than a wider stroke on the dots, because a stroke would grow the hit
    // target and shift the texture of every dot around it.
    //
    // The two specs differ only in what they match and whether their opacity is
    // animated; everything else is deliberately identical, so the ring the
    // driver chose and the ring the ranking chose are the same ring.
    map.addLayer(
      {
        id: LOTS_HALO_LAYER,
        type: "circle",
        source: LOTS_SOURCE,
        filter: ["get", "selected"],
        paint: {
          // Tracks the dot ramp above, six-ish pixels clear of it at every zoom.
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 13, 12, 16, 18],
          "circle-color": "rgba(0, 0, 0, 0)",
          "circle-stroke-width": 3,
          "circle-stroke-color": ACCENT,
          "circle-stroke-opacity": HALO_OPACITY,
        },
      },
      LOTS_LAYER,
    );
    // Under the selection's ring, deliberately: when the driver hovers the card
    // of a lot they have already chosen, the steady ring they chose is the one
    // that shows. Empty filter to start -- nothing is hovered on first paint.
    map.addLayer(
      {
        id: LOTS_HOVER_HALO_LAYER,
        type: "circle",
        source: LOTS_SOURCE,
        filter: ["==", ["get", "id"], ""],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 13, 12, 16, 18],
          "circle-color": "rgba(0, 0, 0, 0)",
          "circle-opacity": 0,
          "circle-stroke-width": 3,
          "circle-stroke-color": ACCENT,
          "circle-stroke-opacity": HOVER_HALO_OPACITY,
        },
      },
      LOTS_HALO_LAYER,
    );
    map.addLayer(
      {
        id: LOTS_BEST_HALO_LAYER,
        type: "circle",
        source: LOTS_SOURCE,
        filter: ["get", "best"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 13, 12, 16, 18],
          "circle-color": "rgba(0, 0, 0, 0)",
          "circle-stroke-width": 3,
          "circle-stroke-color": ACCENT,
          "circle-stroke-opacity": HALO_OPACITY,
          // Declared with the rest of the paint, so the pulse below is only a
          // value being toggled and not a place transitions are defined.
          "circle-stroke-opacity-transition": { duration: PULSE_FADE_MS },
        },
      },
      LOTS_LAYER,
    );

    map.addSource(DESTINATION_SOURCE, { type: "geojson", data: empty });
    map.addLayer({
      id: DESTINATION_LAYER,
      type: "circle",
      source: DESTINATION_SOURCE,
      paint: {
        "circle-radius": 7,
        "circle-color": "#1b1b1f",
        "circle-stroke-width": 3,
        "circle-stroke-color": "#ffffff",
      },
    });

    return () => {
      // Only reachable while the map is alive; a removed map takes its own
      // layers with it, so this guards the StrictMode double-invoke rather than
      // the unmount.
      if (map.getLayer(DESTINATION_LAYER)) map.removeLayer(DESTINATION_LAYER);
      if (map.getLayer(LOTS_BEST_HALO_LAYER)) map.removeLayer(LOTS_BEST_HALO_LAYER);
      if (map.getLayer(LOTS_HOVER_HALO_LAYER)) map.removeLayer(LOTS_HOVER_HALO_LAYER);
      if (map.getLayer(LOTS_HALO_LAYER)) map.removeLayer(LOTS_HALO_LAYER);
      if (map.getLayer(LOTS_LAYER)) map.removeLayer(LOTS_LAYER);
      if (map.getSource(DESTINATION_SOURCE)) map.removeSource(DESTINATION_SOURCE);
      if (map.getSource(LOTS_SOURCE)) map.removeSource(LOTS_SOURCE);
    };
  }, [map]);

  // Re-colouring the city as the arrival time changes is `setData` and nothing
  // else: no request, no re-created layer, no marker churn. That is the payoff
  // of precomputing all 24 horizons into the grid.
  useEffect(() => {
    const source = map?.getSource<GeoJSONSource>(LOTS_SOURCE);
    source?.setData(features);
  }, [map, features]);

  useEffect(() => {
    const source = map?.getSource<GeoJSONSource>(DESTINATION_SOURCE);
    source?.setData(pin);
  }, [map, pin]);

  // Hover is a filter, not data: pointing at a card moves one ring by swapping
  // the id one layer matches on, with no `setData` and no feature rebuilt. The
  // empty string matches nothing, because no lot has an empty id.
  useEffect(() => {
    // The layer effect owns the halos; this one only ever borrows one -- and on
    // the first commit, before the style has loaded, there is not one to borrow.
    if (map === null || map.getLayer(LOTS_HOVER_HALO_LAYER) === undefined) return;
    map.setFilter(LOTS_HOVER_HALO_LAYER, ["==", ["get", "id"], hoverId ?? ""]);
  }, [map, hoverId]);

  // Follow a destination that arrives from outside the map (geolocation), but
  // never yank the view out from under a finger that just tapped inside it.
  useEffect(() => {
    if (map === null || destination === null) return;
    const at: [number, number] = [destination.lon, destination.lat];
    if (!map.getBounds().contains(at)) map.easeTo({ center: at });
  }, [map, destination]);

  // A new destination lands with a ripple, so the eye is told where to look
  // without the map moving. Two plain divs rather than a `Marker`: this is a
  // one-off flourish at a known screen position, and a Marker would mean a DOM
  // node MapLibre repositions on every frame for the 1.2 s it exists.
  useEffect(() => {
    if (map === null || destination === null) return;
    // No projection (jsdom's fake map), or a driver who asked for less motion:
    // both mean there is nothing to draw, and neither is an error.
    if (typeof map.project !== "function" || prefersReducedMotion()) return;
    const container = map.getContainer();
    const at = map.project([destination.lon, destination.lat]);
    const rings = ["pin-ripple", "pin-ripple pin-ripple--late"].map((className) => {
      const ring = document.createElement("div");
      ring.className = className;
      ring.style.left = `${at.x}px`;
      ring.style.top = `${at.y}px`;
      container.append(ring);
      return ring;
    });
    const clear = () => {
      for (const ring of rings) ring.remove();
    };
    const timer = window.setTimeout(clear, RIPPLE_MS);
    return () => {
      window.clearTimeout(timer);
      clear();
    };
  }, [map, destination]);

  // What the sheet and the side panel cover. MapLibre centres on the middle of
  // the *unpadded* canvas, so without this a lot the driver just tapped arrives
  // underneath the sheet that is showing it.
  const { top, right, bottom, left } = padding;
  useEffect(() => {
    if (map === null) return;
    map.setPadding({ top, right, bottom, left });
  }, [map, top, right, bottom, left]);

  // Keyed on the nonce alone -- see `centerRequest` above -- and reading the
  // coordinates from the ref, so a request that is rebuilt on every parent
  // render still moves the map exactly once.
  const centerNonce = centerRequest === null ? null : centerRequest.nonce;
  useEffect(() => {
    const request = centerRequestRef.current;
    if (map === null || request === null) return;
    map.easeTo({
      center: [request.lon, request.lat],
      // Relative to the *padded* centre, which is already the middle of the
      // band the sheet and the panel leave -- so the app only has to say how
      // far below that its own overlay reaches.
      offset: [0, request.offsetY ?? 0],
      duration: prefersReducedMotion() ? 0 : CENTRE_MS,
    });
  }, [map, centerNonce]);

  // The best pick announces itself with three slow beats of its own halo's
  // stroke and then holds still. Forever was the first version, and it cost
  // more than it looked: each paint change re-renders the whole map, so a
  // 1 s pulse with a 900 ms transition keeps MapLibre redrawing every tile and
  // label at 60 fps for as long as the tab is open -- on a large display, a
  // constant CPU load in aid of an animation nobody is still watching. Three
  // beats is enough to find the dot; after that the halo is a static ring,
  // which is what actually marks it. Opacity and not radius, because a
  // changing radius reads as a changing *value* on a map whose circles already
  // mean something. Only the best layer is touched -- the selection's ring is
  // steady, because the driver is not waiting to be convinced about it.
  useEffect(() => {
    if (map === null || bestId === null || prefersReducedMotion()) return;
    const fade = (opacity: number) => {
      // The layer effect owns the halos; this one only ever borrows one.
      if (map.getLayer(LOTS_BEST_HALO_LAYER) === undefined) return;
      map.setPaintProperty(LOTS_BEST_HALO_LAYER, "circle-stroke-opacity", opacity);
    };
    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      fade(step % 2 === 1 ? HALO_OPACITY_DIM : HALO_OPACITY);
      // Stops itself rather than waiting for unmount: a new best pick restarts
      // the effect, and nothing else needs the timer alive.
      if (step >= PULSE_STEPS) window.clearInterval(timer);
    }, PULSE_EVERY_MS);
    return () => {
      window.clearInterval(timer);
      fade(HALO_OPACITY);
    };
  }, [map, bestId]);

  // Taps. Two handlers, because a tap on a dot and a tap on the city mean
  // opposite things: "tell me about this car park" and "I am going here".
  useEffect(() => {
    if (map === null) return;
    // One popup, reused. A popup per tap would leave a trail of them behind.
    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 12 });
    popupRef.current = popup;

    const onDot = (event: MapLayerMouseEvent) => {
      const properties = event.features?.[0]?.properties;
      // `== null`: a feature can arrive with null properties, not just without.
      if (properties == null) return;
      const id: unknown = properties.id;
      if (typeof id !== "string") return;
      // Is the app about to answer this tap with a full card? If so there is
      // no popup to open -- a card and a bubble saying a strict subset of what
      // the card says, over the same car park, is one answer too many -- and
      // any popup still open from an earlier tap goes now. See `hasCard` for
      // why this is asked here rather than read off a prop.
      const carded = hasCardRef.current?.(id) === true;
      // Before the selection is reported, not after: the effect that closes a
      // popup the selection has moved past must be able to tell *this* tap's own
      // selection from one made anywhere else. A carded tap owns no popup, so
      // it claims none -- and that effect is then free to close whatever the
      // last tap left open, which is exactly what should happen.
      popupForRef.current = carded ? null : id;
      onSelectLotRef.current?.(id);
      if (carded) {
        popup.remove();
        return;
      }

      const name: unknown = properties.name;
      const probability: unknown = properties.probability;
      // Built as nodes, never as an HTML string: a lot's name is feed data, and
      // `innerHTML` would make whoever writes the feed the author of this page.
      const box = document.createElement("div");
      const title = document.createElement("b");
      title.textContent = typeof name === "string" ? name : id;
      const chance = document.createElement("span");
      // Anything that is not a real number is "no data" -- never 0%, which is a
      // claim about a car park that nobody made.
      chance.textContent =
        typeof probability === "number" && Number.isFinite(probability)
          ? `${Math.round(probability * 100)}%`
          : stringsRef.current.noData;
      box.append(title, chance);
      // The name and the chance, and nothing else: the expected-cost score
      // orders the list, and is not a number to put in front of a driver.
      popup.setLngLat(event.lngLat).setDOMContent(box).addTo(map);
    };

    const onMap = (event: MapMouseEvent) => {
      // One mouse event reaches both handlers -- they are siblings on the same
      // emitter, so the dot's cannot cancel this one. Asking what is actually
      // under the point is what keeps a tap on a car park from also declaring
      // it the destination.
      if (map.queryRenderedFeatures(event.point, { layers: [LOTS_LAYER] }).length > 0) return;
      popup.remove();
      popupForRef.current = null;
      onPickRef.current?.({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    };

    // Desktop only in effect: a touch device has no hover to give a cursor to.
    const pointer = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const unpointer = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", LOTS_LAYER, onDot);
    map.on("click", onMap);
    map.on("mouseenter", LOTS_LAYER, pointer);
    map.on("mouseleave", LOTS_LAYER, unpointer);
    return () => {
      popup.remove();
      popupRef.current = null;
      popupForRef.current = null;
      map.off("click", LOTS_LAYER, onDot);
      map.off("click", onMap);
      map.off("mouseenter", LOTS_LAYER, pointer);
      map.off("mouseleave", LOTS_LAYER, unpointer);
    };
  }, [map]);

  // A popup describes the dot that was tapped, so it belongs to that selection
  // and to no other. A card tapped in the list, or a selection cleared by a new
  // destination, would otherwise leave it open over a lot the driver has moved
  // on from -- naming one car park while the halo sits on another. The guard is
  // what keeps a dot's *own* tap, which selects it a moment after opening the
  // popup, from closing what it just opened.
  useEffect(() => {
    if (popupForRef.current === selectedId) return;
    popupRef.current?.remove();
    popupForRef.current = null;
  }, [selectedId]);

  return (
    <div className="map">
      {/* Kept mounted even when unusable -- the hook needs the element to have
          existed to find out that WebGL is missing -- but not left as a blank
          rectangle where a map should be. */}
      <div
        ref={containerRef}
        className="map-canvas"
        role="region"
        aria-label={s.mapLabel}
        hidden={unavailable}
      />
      {unavailable && (
        <p className="map-unavailable" role="status">
          {s.mapUnavailable}
        </p>
      )}
    </div>
  );
}
