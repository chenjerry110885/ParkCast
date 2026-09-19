/**
 * 機車 and 充電: what a car park says about scooter spaces and EV charging,
 * and the one distinction this whole feature exists to keep.
 *
 * `lots.json` carries `m` (scooter capacity) and `e` (charging points) as
 * *optional* keys. `src/parkcast/artifacts.py` writes each one only when the
 * feed actually reported it, so there are three states per field and not two:
 *
 *   - **a count** -- this car park has that many;
 *   - **`0`** -- the feed reported it and the answer is none. A measurement;
 *   - **absent** -- nobody said. Not a measurement, and *not* a zero.
 *
 * Collapsing the last two is the failure this module is here to prevent, and
 * it is the same failure the collector refuses at the other end of the wire
 * (`quality.clean_count`, and `-9 -> NULL, never 0` before it). A car park
 * that reports no scooter bays is a car park a scooter rider should not drive
 * to; a car park that never said is one nobody has checked. Rendering the
 * second as the first is how an app tells a driver something it does not know.
 *
 * `typeof x === "number"` rather than `x !== undefined`, deliberately. The
 * encoder never writes `null` for either key -- absent is how it says "no
 * value" -- but a `null` arriving from a hand-edited artifact or a future
 * schema must read as *unknown* and never as a count, which is exactly what
 * `LotCard` already does with `f`.
 *
 * Nothing here knows about React, the map, or the ranking: `Reported` is the
 * only vocabulary the card and the filter share, so the tile a driver reads
 * and the row the filter keeps can never disagree about what a lot said.
 */
import type { Lot } from "./types";

/** The two fields a driver can ask about. */
export type Amenity = "scooter" | "charging";

/** Every `Amenity`, in the order the filter row and the card's tiles use. */
export const AMENITIES: readonly Amenity[] = ["scooter", "charging"];

/**
 * What one lot said about one amenity.
 *
 * `count: 0` is a reported zero and is deliberately *inside* `known`: it is a
 * fact the feed published, and the card says so in words. `known: false` is
 * the absence of a report, which the card says nothing at all about.
 */
export type Reported = { known: true; count: number } | { known: false };

const UNKNOWN: Reported = { known: false };

/** The key `Amenity` lives under in `lots.json`. */
function key(amenity: Amenity): "m" | "e" {
  return amenity === "scooter" ? "m" : "e";
}

/** What `lot` reports for `amenity` -- a count, a reported zero, or nothing. */
export function reported(lot: Lot, amenity: Amenity): Reported {
  const value = lot[key(amenity)];
  return typeof value === "number" ? { known: true, count: value } : UNKNOWN;
}

/**
 * The amenities at least one of `lots` has actually answered about.
 *
 * A filter is a question put to a roster, and a question nothing in the roster
 * can answer should not be asked. `lots.json` carries `m` and `e` only from a
 * collector built after `edc980b`; against an older roster every lot reads as
 * *unknown*, and a chip pressed there can only ever produce an empty list over
 * a dimmed city with a hidden count that stands for the whole of it. True in
 * every word, and useless.
 *
 * This is a statement about the data on hand, never about a car park, so it
 * does not touch the distinction the rest of this module exists to keep: a
 * reported `0` is an answer and keeps its chip on screen, exactly as a
 * reported 40 does. Only "nobody anywhere said" takes the chip away.
 */
export function answerable(lots: readonly Lot[]): Amenity[] {
  return AMENITIES.filter((amenity) => lots.some((lot) => reported(lot, amenity).known));
}

/** Whether `lot` actually has some of `amenity`. A reported zero does not. */
export function hasAmenity(lot: Lot, amenity: Amenity): boolean {
  const r = reported(lot, amenity);
  return r.known && r.count > 0;
}

/**
 * Why a filter left a lot out of the list, or `null` if it kept it.
 *
 * Two reasons, never one, because they are two different facts about the car
 * park and a driver has to be able to tell them apart:
 *
 *   - `"none"` -- at least one active filter's field is a reported zero. We
 *     know this car park does not have what was asked for.
 *   - `"unknown"` -- no active filter ruled it out, but at least one has
 *     nothing to go on. We do not know, and saying "none" here would be
 *     inventing the measurement.
 *
 * A definite no outranks an unknown, which is why the two loops are not one:
 * a car park with no scooter bays that says nothing about charging is hidden
 * because it has no scooter bays -- a fact -- and counting it among the
 * "doesn't say" would understate what we actually know.
 *
 * With no filters active this returns `null` for every lot, so the caller
 * needs no special case for the unfiltered screen.
 */
export type Exclusion = "none" | "unknown";

export function exclusionFor(lot: Lot, active: readonly Amenity[]): Exclusion | null {
  let unknown = false;
  for (const amenity of active) {
    const r = reported(lot, amenity);
    if (r.known) {
      if (r.count === 0) return "none";
    } else {
      unknown = true;
    }
  }
  return unknown ? "unknown" : null;
}

/** How many of `lots` each exclusion reason accounts for. Kept rows are in neither. */
export interface HiddenTally {
  /** Reported zero of something that was asked for. */
  none: number;
  /** Said nothing about something that was asked for. */
  unknown: number;
}

/**
 * The tally the list reports beside itself, over whatever rows it is handed.
 *
 * The *caller* decides the scope, and `App` hands it the rows the list would
 * have shown with no filter on -- see `hiddenByFilters` there. Counting the
 * whole 1,089-lot roster would be arithmetic about a city rather than an
 * explanation of a list that just got shorter.
 */
export function tallyHidden(lots: readonly Lot[], active: readonly Amenity[]): HiddenTally {
  const tally: HiddenTally = { none: 0, unknown: 0 };
  if (active.length === 0) return tally;
  for (const lot of lots) {
    const reason = exclusionFor(lot, active);
    if (reason !== null) tally[reason] += 1;
  }
  return tally;
}

/** `amenity` added to `active`, or removed from it. Order follows `AMENITIES`. */
export function toggleAmenity(active: readonly Amenity[], amenity: Amenity): Amenity[] {
  const next = active.includes(amenity)
    ? active.filter((a) => a !== amenity)
    : [...active, amenity];
  return AMENITIES.filter((a) => next.includes(a));
}
