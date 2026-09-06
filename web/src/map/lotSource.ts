/**
 * Lots -> the single GeoJSON source that draws all 1,088 car parks.
 *
 * One source, one circle layer. Not 1,088 `Marker`s: a DOM node per lot is what
 * turns a city-wide parking map into a phone that drops frames while panning,
 * and MapLibre draws a circle layer of this size on the GPU without noticing.
 *
 * Two things here are worth being careful about.
 *
 *   - **GeoJSON is `[longitude, latitude]`.** Every other coordinate in this
 *     codebase is `{lat, lon}`, and `lots.json` calls them `y` and `x`. Getting
 *     the order backwards puts Taipei in Mongolia and is not subtle, which is
 *     exactly why it is tested rather than trusted.
 *   - **A lot with no forecast is emitted, not filtered.** It carries
 *     `probability: null` and the unknown colour. Dropping it would silently
 *     delete a real car park from a map of car parks, and a car park that is
 *     missing is invisible while one that says "no data" is not.
 *
 * The module deliberately imports nothing from `maplibre-gl`: it is a pure data
 * transform, and it stays testable in jsdom without a WebGL context.
 */
import type { Feature, FeatureCollection, Point } from "geojson";
import { colourFor } from "./colour";
import type { Lot } from "../types";

/**
 * What the map needs from a lot, and nothing else.
 *
 * Narrower than `Lot` on purpose: the map draws a dot with an identity, a
 * position and a probability, so that is the contract. Nothing in it comes from
 * the ranking -- which is exactly why the map can draw the whole city before the
 * driver has said where they are going.
 */
export interface MapLot {
  /** Feed id, e.g. `TPE0001`. The feature id, so MapLibre can key hover state. */
  id: string;
  /** Name -- Chinese in both languages, matching the signage at the car park. */
  name: string;
  district: string;
  /** WGS84 degrees, in this codebase's usual order. Swapped on the way out. */
  lat: number;
  lon: number;
  /** P(at least one space) at the arrival time, or `null` for no forecast. */
  probability: number | null;
}

/** Feature properties. A `type` alias, not an interface, so it satisfies GeoJSON's index signature. */
export type LotProperties = {
  id: string;
  name: string;
  district: string;
  /** Stays `null` when unknown -- never coerced to 0. */
  probability: number | null;
  /** Precomputed by `colourFor`, read by the layer as `["get", "colour"]`. */
  colour: string;
  /** False when `probability` is null, so the paint can also dim the unknowns. */
  known: boolean;
};

/**
 * The `Lot` -> `MapLot` projection. The one place `y`/`x` become `lat`/`lon`.
 *
 * The probability is passed in rather than looked up here: resolving a lot to
 * its grid row is `App`'s single conversion point -- through `Lot.i`, never the
 * array position -- and this module stays a pure reshape with no opinion about
 * where the number came from.
 */
export function toMapLot(lot: Lot, probability: number | null): MapLot {
  return {
    id: lot.id,
    name: lot.n,
    district: lot.a,
    lat: lot.y,
    lon: lot.x,
    probability,
  };
}

/** Every lot given, as one `FeatureCollection` ready for `setData`. */
export function toFeatureCollection(rows: readonly MapLot[]): FeatureCollection<Point, LotProperties> {
  const features: Feature<Point, LotProperties>[] = rows.map((row) => ({
    type: "Feature",
    id: row.id,
    geometry: { type: "Point", coordinates: [row.lon, row.lat] },
    properties: {
      id: row.id,
      name: row.name,
      district: row.district,
      probability: row.probability,
      colour: colourFor(row.probability),
      known: row.probability !== null,
    },
  }));
  return { type: "FeatureCollection", features };
}

/** A one-point collection for the destination pin, or an empty one. */
export function toPointCollection(at: { lat: number; lon: number } | null): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features:
      at === null
        ? []
        : [{ type: "Feature", geometry: { type: "Point", coordinates: [at.lon, at.lat] }, properties: {} }],
  };
}
