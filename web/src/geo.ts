/**
 * Distance on the ground, and how long it takes to walk it.
 *
 * Everything here is deliberately simple: a driver choosing between car parks
 * 300 m and 600 m from a restaurant does not need a routing engine, and a
 * routing engine would need a network call this app does not make. Straight-line
 * distance understates a real walk by roughly 20-30% in Taipei's grid, but it
 * understates every candidate by about the same factor, so the *ranking* is
 * barely affected even though the absolute minutes are optimistic.
 */

/** WGS84 degrees, matching `Lot.y` / `Lot.x` in `lots.json`. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** IUGG mean Earth radius, in metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Walking pace, metres per minute. 80 m/min is 4.8 km/h -- an unhurried adult
 * pace on flat pavement, which is what a driver who has just parked walks at.
 */
export const WALK_METERS_PER_MIN = 80;

const RAD = Math.PI / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the flat-Earth approximation: the arithmetic is a
 * handful of trig calls per lot and, at ~1,100 lots, still far inside the
 * 50 ms interaction budget in the spec. Exactly 0 for identical points, and
 * symmetric to the last bit -- both are tested, because a distance function
 * that is subtly asymmetric makes ranking depend on argument order.
 */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whole minutes to walk `meters`, rounded **up**.
 *
 * Up, not nearest: the cost of over-estimating is arriving early, and the cost
 * of under-estimating is being late. Those are not symmetric, so the rounding
 * should not be either.
 */
export function walkMinutes(meters: number): number {
  return Math.ceil(Math.max(0, meters) / WALK_METERS_PER_MIN);
}
