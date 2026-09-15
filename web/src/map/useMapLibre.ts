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
 * **The basemap is static files, not a service.** Each tile is its own file on
 * this app's origin (`basemap/tiles/{z}/{x}/{y}.pbf`), so a browser downloads only
 * the tiles actually on screen, and there is no API key, no account and no third
 * party watching the user pan around their own city -- see `docs/basemap.md`.
 *
 * **Labels are self-hosted too.** Symbol layers need glyph PBFs, which usually
 * come from a font CDN. Here they come from `basemap/fonts/` on this origin --
 * only the ranges Taipei's labels use -- and Chinese, Japanese and Korean
 * characters are drawn with the device's own fonts, so no CJK glyph files ship
 * at all. The style itself is plain data in `basemapStyle.ts`.
 */
import { useEffect, useRef, useState } from "react";
import { MapLibreMap, setWorkerUrl } from "maplibre-gl";
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
import type { Lang } from "../i18n";
import { basemapStyle } from "./basemapStyle";

/** Roughly Taipei Main Station, in GeoJSON order: [lon, lat]. */
export const TAIPEI_CENTER: [number, number] = [121.5170, 25.0478];

/** Wide enough to see the whole basin, close enough that lots are separable. */
export const INITIAL_ZOOM = 12;

/**
 * MapLibre's global setup: the worker it parses tiles on. Per-page rather than
 * per-map, and it must be in place *before* a map is constructed.
 */
let configured = false;
function configureMapLibre(): void {
  if (configured) return;
  setWorkerUrl(maplibreWorkerUrl);
  configured = true;
}

/**
 * Which Protomaps theme to draw. Read once, when the map is built: restyling a
 * live map drops every custom source and layer with it, so a colour-scheme flip
 * mid-session keeps the basemap it started with until the next reload.
 */
function basemapTheme(): "light" | "dark" {
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

export function useMapLibre(lang: Lang): MapLifecycle {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Read once, like the theme: labels keep the language the map was built in
  // until the next load, because restyling a live map drops the lot layers.
  const initialLang = useRef(lang);
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
        style: basemapStyle(basemapTheme(), initialLang.current),
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
