/**
 * The map: 1,088 car parks over a self-hosted basemap, coloured by their chance
 * of having a space at the driver's arrival time.
 *
 * Every lot is one point in **one** GeoJSON source drawn by **one** circle
 * layer. The obvious alternative -- a `maplibregl.Marker` per lot -- puts 1,088
 * absolutely-positioned DOM nodes on the page and repositions all of them on
 * every frame of a pan. That is the difference between a map that glides and
 * one that stutters on the phone this app is meant to be used on.
 *
 * Colour comes from the feature's own `colour` property rather than from a
 * paint expression that re-derives it, so the map, the list and `colour.ts`
 * cannot drift apart -- and in particular the "no forecast" grey is decided in
 * exactly one place. Unknown lots are also drawn dimmer than known ones: two
 * channels saying the same true thing, for the reader who does not have the
 * legend memorised.
 */
import { useEffect, useMemo, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import type { LatLon } from "../geo";
import { t, type Lang } from "../i18n";
import type { Ranked } from "../rank";
import { toFeatureCollection, toMapLot, toPointCollection } from "./lotSource";
import { useMapLibre } from "./useMapLibre";

const LOTS_SOURCE = "lots";
const LOTS_LAYER = "lots-circles";
const DESTINATION_SOURCE = "destination";
const DESTINATION_LAYER = "destination-pin";

export interface MapViewProps {
  /** Every lot to draw -- the whole ranked set, not the slice the list shows. */
  rows: readonly Ranked[];
  /** Where the driver is going, drawn as a pin. `null` before one is chosen. */
  destination: LatLon | null;
  /** Called with the tapped point, so the map can *be* the destination input. */
  onPick?: (at: LatLon) => void;
  lang: Lang;
}

export function MapView({ rows, destination, onPick, lang }: MapViewProps) {
  const { containerRef, map, unavailable } = useMapLibre();
  const s = t(lang);

  const lots = useMemo(() => toFeatureCollection(rows.map(toMapLot)), [rows]);
  const pin = useMemo(() => toPointCollection(destination), [destination]);

  // The taps outlive the render that registered them, so the handler reads the
  // latest callback from a ref instead of being torn down and re-added on every
  // parent render.
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

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
        // Small enough at city zoom that 1,088 dots stay a texture rather than
        // a blob, big enough to hit with a thumb once you are in a district.
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 13, 5, 16, 9],
        "circle-color": ["get", "colour"],
        "circle-opacity": ["case", ["get", "known"], 0.9, 0.5],
        "circle-stroke-width": 1,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-opacity": 0.75,
      },
    });

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
    source?.setData(lots);
  }, [map, lots]);

  useEffect(() => {
    const source = map?.getSource<GeoJSONSource>(DESTINATION_SOURCE);
    source?.setData(pin);
  }, [map, pin]);

  // Follow a destination that arrives from outside the map (geolocation), but
  // never yank the view out from under a finger that just tapped inside it.
  useEffect(() => {
    if (map === null || destination === null) return;
    const at: [number, number] = [destination.lon, destination.lat];
    if (!map.getBounds().contains(at)) map.easeTo({ center: at });
  }, [map, destination]);

  useEffect(() => {
    if (map === null) return;
    const handler = (event: MapMouseEvent) => {
      onPickRef.current?.({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    };
    map.on("click", handler);
    return () => {
      map.off("click", handler);
    };
  }, [map]);

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
