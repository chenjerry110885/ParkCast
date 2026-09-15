/**
 * The basemap's MapLibre style: the self-hosted tiles, the self-hosted label
 * glyphs, and the Protomaps theme drawn from them.
 *
 * Plain data, kept apart from `useMapLibre.ts` so it can be tested without a
 * WebGL context. Every URL in it is on this app's own origin: no tile server, no
 * font CDN, nothing that sees the user pan around their own city.
 */
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { layers, namedTheme } from "protomaps-themes-base";
import type { Lang } from "../i18n";

/**
 * Relative to the deployment root, like the artifacts, so the app works under a
 * sub-path unrebuilt.
 *
 * Only the seam between base and path is normalised. Collapsing *every* run of
 * slashes -- what this used to do -- turns an absolute base's `https://` into
 * `https:/`, a break that cannot appear in dev because the base has no scheme
 * there. Same hazard, same shape, as `artifactsBase` in `artifacts.ts`.
 */
const base = import.meta.env.BASE_URL.replace(/\/+$/, "");

/**
 * Where the tiles are served from: one static file per tile, unpacked from the
 * extract by `scripts/unpack-tiles.mjs`. Not a `.pmtiles` archive -- reading one
 * needs HTTP Range requests, and Cloudflare's static hosting ignores Range.
 * Absolute, because MapLibre fetches tiles from inside its worker.
 */
const origin = typeof window === "undefined" ? "" : window.location.origin;
export const TILES_URL = `${origin}${base}/basemap/tiles/{z}/{x}/{y}.pbf`;

/**
 * The extract's bounding box, [west, south, east, north] -- the BBOX in
 * `scripts/build-basemap.mjs`, which a script test holds this to. MapLibre asks
 * for no tile outside it, so panning past the edge requests nothing that 404s.
 */
export const BASEMAP_BOUNDS: [number, number, number, number] = [121.4433, 24.9576, 121.6405, 25.1999];

/**
 * Where the label glyphs are served from: one file per font per 256 codepoints,
 * and only the ranges Taipei's labels use (`scripts/select-glyphs.mjs`). Chinese,
 * Japanese and Korean characters never hit this URL -- MapLibre draws those with
 * the device's own fonts (`localIdeographFontFamily`, on by default).
 */
export const GLYPHS_URL = `${base}/basemap/fonts/{fontstack}/{range}.pbf`;

/**
 * The archive's real ceiling, declared rather than discovered.
 *
 * The Protomaps planet build stops at zoom 15 for this bbox -- a `--maxzoom=16`
 * extract came back byte-identical. Telling MapLibre so makes it overzoom the
 * z15 tiles (they are geometry, so they stay sharp) instead of requesting a z16
 * tile that does not exist and painting the gap blank.
 */
export const BASEMAP_MAX_ZOOM = 15;

/** OSM's licence requires this, and it costs one line. */
const ATTRIBUTION =
  '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';

/** The Protomaps label language for the app's language: Taiwan's own script, or English. */
export function labelLang(lang: Lang): string {
  return lang === "zh" ? "zh-Hant" : "en";
}

/**
 * The layers minus their POI icons. Icons come from a sprite sheet, which this
 * app does not ship; without one MapLibre warns once per missing image and draws
 * the label alone anyway. Dropping `icon-image` draws the same map, silently.
 */
function withoutIcons(list: LayerSpecification[]): LayerSpecification[] {
  return list.map((layer) => {
    if (layer.type !== "symbol" || layer.layout?.["icon-image"] === undefined) return layer;
    const { "icon-image": _icon, ...layout } = layer.layout;
    return { ...layer, layout };
  });
}

export function basemapStyle(theme: "light" | "dark", lang: Lang): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      basemap: {
        type: "vector",
        tiles: [TILES_URL],
        minzoom: 0,
        maxzoom: BASEMAP_MAX_ZOOM,
        bounds: BASEMAP_BOUNDS,
        attribution: ATTRIBUTION,
      },
    },
    layers: withoutIcons(layers("basemap", namedTheme(theme), { lang: labelLang(lang) })),
  };
}
