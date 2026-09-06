/**
 * The MapLibre instance's whole life, in one hook.
 *
 * **Created once, removed on unmount.** A `new maplibregl.Map(...)` in a React
 * render body -- or in an effect whose dependencies change -- leaks a WebGL
 * context every time, and browsers cap the number of live contexts at around
 * 16 before they start refusing to make more. The map is built in an effect
 * with an empty dependency list and torn down in its cleanup; nothing else in
 * this app ever constructs one.
 *
 * **The basemap is a static file, not a service.** `taipei.pmtiles` is served
 * from this app's own origin and read by HTTP range request through the pmtiles
 * protocol, so a browser downloads only the few hundred KB of tiles actually on
 * screen, and there is no API key, no account and no third party watching the
 * user pan around their own city. That is why the archive exists at all -- see
 * `docs/basemap.md`.
 *
 * **No labels, on purpose.** Symbol layers need glyph PBFs, and the only place
 * to fetch those from is a CDN -- a runtime request to a third party, which is
 * exactly what self-hosting the tiles was meant to avoid. So the basemap draws
 * roads, water, parks and buildings and no text. Self-hosting the glyph ranges
 * (Chinese needs a lot of them) is the fix, and it is a separate piece of work.
 */
import { useEffect, useRef, useState } from "react";
import { MapLibreMap, addProtocol, setWorkerUrl } from "maplibre-gl";
// MapLibre 6 works out its worker's URL at runtime, as
// `new URL('./maplibre-gl-worker.mjs', import.meta.url)` -- a path that exists
// in `node_modules/maplibre-gl/dist` and nowhere a bundler puts things. Vite's
// dev pre-bundle and its production build both leave that URL pointing at a
// file that is not there, the request 404s, no worker boots, and the map paints
// its background colour and not one tile. There is no error in the console: it
// simply looks like an empty grey box.
//
// `?worker&url` makes Vite bundle the worker properly -- following its own
// imports -- and hand back the URL of the emitted asset, in dev and in the
// build alike. `setWorkerUrl` takes precedence over MapLibre's guess.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";
import { noLabels } from "protomaps-themes-base";

/**
 * Where the archive is served from. Relative to the deployment root, like the
 * artifacts, so the app works under a sub-path (GitHub Pages) unrebuilt.
 */
export const BASEMAP_URL = `${import.meta.env.BASE_URL}basemap/taipei.pmtiles`.replace(/\/{2,}/g, "/");

/**
 * The archive's real ceiling, declared rather than discovered.
 *
 * The Protomaps planet build stops at zoom 15 for this bbox -- a `--maxzoom=16`
 * extract came back byte-identical. Telling MapLibre so makes it overzoom the
 * z15 tiles (they are geometry, so they stay sharp) instead of requesting a z16
 * tile that does not exist and painting the gap blank.
 */
export const BASEMAP_MAX_ZOOM = 15;

/** Roughly Taipei Main Station, in GeoJSON order: [lon, lat]. */
export const TAIPEI_CENTER: [number, number] = [121.5170, 25.0478];

/** Wide enough to see the whole basin, close enough that lots are separable. */
export const INITIAL_ZOOM = 12;

/** OSM's licence requires this, and it costs one line. */
const ATTRIBUTION =
  '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';

/**
 * MapLibre's global setup: the worker it parses tiles on, and the `pmtiles://`
 * scheme the basemap is served over. Both are per-page rather than per-map, and
 * both must be in place *before* a map is constructed -- a style referencing an
 * unregistered scheme fails outright.
 */
let configured = false;
function configureMapLibre(): void {
  if (configured) return;
  setWorkerUrl(maplibreWorkerUrl);
  addProtocol("pmtiles", new Protocol().tile);
  configured = true;
}

/**
 * Which Protomaps theme to draw. Read once, when the map is built: restyling a
 * live map drops every custom source and layer with it, so a colour-scheme flip
 * mid-session keeps the basemap it started with until the next reload.
 */
function basemapTheme(): string {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export interface MapLifecycle {
  /** Attach to the element the map should fill. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The instance, once its style has loaded and it will accept layers. */
  map: MapLibreMap | null;
  /** True when this device could not give us a WebGL context at all. */
  unavailable: boolean;
}

export function useMapLibre(): MapLifecycle {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let instance: MapLibreMap;
    try {
      configureMapLibre();
      instance = new MapLibreMap({
        container,
        center: TAIPEI_CENTER,
        zoom: INITIAL_ZOOM,
        attributionControl: { compact: true },
        // North-up. A driver reads a map against street signs, and a map that
        // has quietly rotated under a two-finger gesture is worse than useless.
        dragRotate: false,
        pitchWithRotate: false,
        style: {
          version: 8,
          sources: {
            basemap: {
              type: "vector",
              url: `pmtiles://${BASEMAP_URL}`,
              maxzoom: BASEMAP_MAX_ZOOM,
              attribution: ATTRIBUTION,
            },
          },
          layers: noLabels("basemap", basemapTheme()),
        },
      });
    } catch {
      // No WebGL: an old phone, a locked-down browser, or jsdom. The ranked
      // list is the app's real output and it still works, so say so and carry
      // on rather than taking the page down with us.
      //
      // Whether this device has a WebGL context is only knowable by asking it,
      // and asking it is constructing the map -- the "synchronizing with an
      // external system" case the rule's own help text carves out. There is no
      // render-time answer to derive this from.
      // oxlint-disable-next-line react/set-state-in-effect
      setUnavailable(true);
      return;
    }

    instance.touchZoomRotate.disableRotation();

    // Publish on `style.load`, the first moment `addSource`/`addLayer` will
    // accept anything -- and *not* on `load`, which additionally waits for the
    // first full frame of tiles. Reading a cold 24 MB archive over range
    // requests takes seconds, and waiting for it would leave the user looking
    // at a basemap with none of the forecast this app exists to show on it.
    const publish = () => setMap(instance);
    instance.on("style.load", publish);

    return () => {
      instance.off("style.load", publish);
      instance.remove();
      setMap(null);
    };
  }, []);

  return { containerRef, map, unavailable };
}
