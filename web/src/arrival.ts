/**
 * "Arrive at" as a clock time, not a horizon slider.
 *
 * The forecast grid is indexed by minutes-ahead-of-the-reading, but a driver
 * does not think in horizons -- they think "I'll be there around 15:10".
 * This module is the seam between the two: it rounds the driver's intent onto
 * the same 5-minute wall-clock grid the collector writes, converts a clock
 * time back into the horizon `probabilityAt` needs, and keeps the picker's
 * options bounded by what the grid actually covers so a stale reading empties
 * the list rather than offering a time the model never forecast.
 *
 * Grid time, not now, is truth: `horizonFromReading` measures from
 * `baseDataTs` because that is what the forecast was computed against, and
 * the gap between "now" and "when the reading was taken" is exactly the
 * staleness a caller may want to surface separately, not fold in here.
 */

export const STEP_SEC = 300;                 // 5-minute wall-clock grid
export const MIN_LEAD_SEC = 5 * 60;          // the nearest arrival offered
export const DEFAULT_LEAD_SEC = 15 * 60;
export const TIME_ZONE = "Asia/Taipei";

export interface GridSpan { baseDataTs: number; stepMin: number; nHorizons: number }

export function ceilToStep(ts: number, stepSec = STEP_SEC): number {
  return Math.ceil(ts / stepSec) * stepSec;
}

export function floorToStep(ts: number, stepSec = STEP_SEC): number {
  return Math.floor(ts / stepSec) * stepSec;
}

/** Every clock time the strip offers: now+5 rounded up, through the grid's last column rounded down. */
export function arrivalOptions(nowSec: number, grid: GridSpan): number[] {
  const first = ceilToStep(nowSec + MIN_LEAD_SEC);
  const last = floorToStep(grid.baseDataTs + grid.stepMin * grid.nHorizons * 60);
  const out: number[] = [];
  for (let t = first; t <= last; t += STEP_SEC) out.push(t);
  return out;
}

export function defaultArrival(nowSec: number): number {
  return ceilToStep(nowSec + DEFAULT_LEAD_SEC);
}

export function clampArrival(arrivalTs: number, options: readonly number[]): number {
  if (options.length === 0) return arrivalTs;
  const first = options[0]!;
  const last = options[options.length - 1]!;
  if (arrivalTs < first) return first;
  if (arrivalTs > last) return last;
  return arrivalTs;
}

/** Minutes between the reading behind the forecast and the arrival: the age is inside this number. */
export function horizonFromReading(arrivalTs: number, baseDataTs: number): number {
  return (arrivalTs - baseDataTs) / 60;
}

export function relativeMinutes(arrivalTs: number, nowSec: number): number {
  return Math.round((arrivalTs - nowSec) / 60);
}

const clockFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE,
});

export function formatClock(ts: number): string {
  return clockFormat.format(new Date(ts * 1000));
}
