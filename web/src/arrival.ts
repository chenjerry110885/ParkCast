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
 *
 * `dayOptions`/`hourOptions`/`minuteOptions`/`composeArrival` are the second
 * half of this seam, added once `week.bin` gave the app something to answer
 * with beyond `grid.bin`'s own +120 min horizon: a day/hour/minute picker
 * needs the driver's intent decomposed into independently-choosable parts,
 * not one flat list of every 5-minute mark across seven days. `MAX_LEAD_SEC`
 * bounds how far out that picker may honestly reach -- see its own comment.
 */

export const STEP_SEC = 300;                 // 5-minute wall-clock grid
export const MIN_LEAD_SEC = 5 * 60;          // the nearest arrival offered
export const DEFAULT_LEAD_SEC = 15 * 60;
export const TIME_ZONE = "Asia/Taipei";

/**
 * The farthest arrival the day/hour/minute picker offers: seven days ahead
 * of now, in seconds.
 *
 * This is not an arbitrary cap -- it is the honest limit of what `week.bin`
 * (see `./week.ts`) can express at all. That table has exactly `N_BUCKETS`
 * (336, matching server-side `config.WEEK_BUCKETS`) half-hour buckets
 * covering one week and no more; past seven days out it simply repeats the
 * same 336 buckets, so a date further out would look like a distinct answer
 * while actually just replaying this week's Tuesday onto next month's.
 * Offering it would claim knowledge of a specific future event -- a
 * holiday, a closure, a one-off surge -- that the climatology has never
 * seen and cannot see from this artifact alone.
 */
export const MAX_LEAD_SEC = 7 * 24 * 3600;

/** Seconds in a day, used only for whole Taipei calendar days below. */
const DAY_SEC = 24 * 3600;

/**
 * Taipei's fixed offset from UTC, in seconds.
 *
 * Taipei is UTC+8 **with no DST** -- the same fact `forecast.week_bucket`'s
 * docstring in `src/parkcast/forecast.py` states, and the one `weekBucket`
 * in `./week.ts` relies on for `week.bin` to mean anything at all. A fixed
 * shift is exact for every instant this app will ever see, including across
 * a month or year boundary (see `dayOptions`'s tests): do not "fix" this by
 * reaching for a DST-aware calendar library, here or anywhere else that
 * touches Taipei time in this codebase.
 */
const TAIPEI_OFFSET_SEC = 8 * 3600;

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

/**
 * Keeps a valid selection, snaps a passed one forward and an overrun one
 * back -- against either shape of bound:
 *
 *  - a `readonly number[]`, the discrete list `arrivalOptions` builds for
 *    the 2-hour grid strip: clamped to its own first/last entry, and an
 *    empty list still passes `arrivalTs` through unchanged, exactly as
 *    before -- this is the original behaviour, untouched.
 *  - a plain `{ min, max }` range, the day/hour/minute picker's bound for
 *    the 7-day climatology range (`ceilToStep(now + MIN_LEAD_SEC)` through
 *    `now + MAX_LEAD_SEC`) -- never materialised as a list of the ~2,016
 *    five-minute marks it would otherwise take to cover seven days, since
 *    the picker composes a candidate from independent day/hour/minute
 *    choices (`composeArrival`) rather than picking one entry off a flat
 *    list.
 */
export function clampArrival(arrivalTs: number, bounds: readonly number[] | { min: number; max: number }): number {
  let first: number;
  let last: number;
  if ("min" in bounds) {
    first = bounds.min;
    last = bounds.max;
  } else {
    if (bounds.length === 0) return arrivalTs;
    first = bounds[0]!;
    last = bounds[bounds.length - 1]!;
  }
  if (arrivalTs < first) return first;
  if (arrivalTs > last) return last;
  return arrivalTs;
}

/**
 * Floor `ts` to the most recent Taipei local midnight, returned as a Unix
 * timestamp in seconds.
 *
 * Plain integer arithmetic on the fixed `TAIPEI_OFFSET_SEC` shift -- the
 * same trick `weekBucket` in `./week.ts` uses for time-of-week -- rather
 * than a `Date`'s own local-time methods, which read the *host* machine's
 * timezone, not Taipei's. A day is always exactly `DAY_SEC` long here
 * because Taipei has no DST to lengthen or shorten one; that is what makes
 * this floor exact across a month or year boundary with no calendar-aware
 * library involved.
 */
function taipeiMidnight(ts: number): number {
  return Math.floor((ts + TAIPEI_OFFSET_SEC) / DAY_SEC) * DAY_SEC - TAIPEI_OFFSET_SEC;
}

/**
 * `Date#getDay()` convention (Sunday = 0 .. Saturday = 6) for the Taipei
 * calendar day that the Taipei local midnight `daySec` (e.g. from
 * `taipeiMidnight`) begins.
 *
 * Computed the same way as `weekBucket` in `./week.ts`: pure integer
 * arithmetic counting whole days off the bare Unix epoch, never
 * `Date#getDay`, which would answer for the host machine's own calendar day
 * rather than Taipei's. Epoch day 0 (1970-01-01) was a **Thursday** -- the
 * same fact that makes `week.bin` bucket 0 Thursday, not Monday -- so
 * `epochDay + 4` lines epoch day 0 up with weekday index 4. That anchor is
 * `week.bin`'s own, reused here only because it is arithmetically
 * convenient; nothing about the day list itself is Monday- or
 * Thursday-anchored -- it always starts from "today", whatever weekday that
 * happens to be.
 */
function weekdayOf(daySec: number): number {
  const epochDay = Math.round((daySec + TAIPEI_OFFSET_SEC) / DAY_SEC);
  const raw = (epochDay + 4) % 7;
  return raw < 0 ? raw + 7 : raw;
}

/** How a `DayOption` should read in the picker: today and tomorrow get their own words, everything else a weekday name. */
export type DayKind = "today" | "tomorrow" | "weekday";

export interface DayOption {
  /** Taipei local midnight for this calendar day, as a Unix timestamp in seconds -- pass straight through to `composeArrival`. */
  daySec: number;
  /** Which label this entry should read as. */
  kind: DayKind;
  /**
   * `Date#getDay()` convention (Sun = 0 .. Sat = 6) for this calendar day in
   * Taipei time. Filled in for every entry, not only `"weekday"` ones, so a
   * caller never has to special-case which entries carry it -- but
   * `"today"`/`"tomorrow"` entries have their own words and are not expected
   * to use it for a label.
   */
  weekday: number;
}

/**
 * The calendar days a day/hour/minute picker should offer for `nowSec`:
 * Taipei "today" through the Taipei day containing `nowSec + MAX_LEAD_SEC`,
 * inclusive.
 *
 * The day count is *derived* from `MAX_LEAD_SEC`, not a second hard-coded
 * "7" kept in sync by hand: `spanDays` is `taipeiMidnight(now +
 * MAX_LEAD_SEC)` minus `taipeiMidnight(now)`, in whole days, so a future
 * change to `MAX_LEAD_SEC` (say if `week.bin`'s own span ever changed)
 * changes this list's length too, rather than silently drifting apart from
 * it -- that coupling is what an earlier draft's comment claimed without
 * the code actually doing it.
 *
 * For today's `MAX_LEAD_SEC` -- a flat 7-day duration added to `nowSec`
 * itself, not to a day boundary -- `spanDays` always comes out to 7: the
 * farthest reachable moment falls on the *same* Taipei time-of-day as
 * `nowSec`, seven calendar days later (this only holds because Taipei has
 * no DST to shift it by an hour -- see `TAIPEI_OFFSET_SEC`). So the list is
 * 8 entries long, not 7: today (i = 0), tomorrow (i = 1), then weekday
 * names (i = 2..spanDays).
 */
export function dayOptions(nowSec: number): DayOption[] {
  const start = taipeiMidnight(nowSec);
  const end = taipeiMidnight(nowSec + MAX_LEAD_SEC);
  const spanDays = Math.round((end - start) / DAY_SEC);
  const days: DayOption[] = [];
  for (let i = 0; i <= spanDays; i++) {
    const daySec = start + i * DAY_SEC;
    const kind: DayKind = i === 0 ? "today" : i === 1 ? "tomorrow" : "weekday";
    days.push({ daySec, kind, weekday: weekdayOf(daySec) });
  }
  return days;
}

/** Every hour a picker can select within a Taipei calendar day, 0..23. Independent of `nowSec` -- `composeArrival` and `clampArrival` do the range clamping, not this list. */
export function hourOptions(): number[] {
  return Array.from({ length: 24 }, (_, h) => h);
}

/** `STEP_SEC` expressed in minutes -- the width `minuteOptions` and `composeArrival` step by, derived rather than a second hard-coded "5" kept in sync by hand with the grid `ceilToStep`/`floorToStep` round onto. */
const STEP_MIN = STEP_SEC / 60;

/** Every mark within an hour on the `STEP_SEC` grid, 0..(60 - `STEP_MIN`). */
export function minuteOptions(): number[] {
  const out: number[] = [];
  for (let m = 0; m < 60; m += STEP_MIN) out.push(m);
  return out;
}

/**
 * Build an absolute Unix timestamp from a day/hour/minute picker's own
 * selection: `daySec` (a Taipei local midnight, from `dayOptions`), plus an
 * hour (0..23) and minute (a multiple of `STEP_MIN`, from `minuteOptions`)
 * within that Taipei calendar day.
 *
 * Taipei's fixed, DST-free offset (`TAIPEI_OFFSET_SEC`) is exactly what
 * makes plain addition correct here: `daySec + hour*3600 + minute*60` never
 * needs a calendar library to know whether an hour got skipped or repeated,
 * because in Taipei none ever is.
 *
 * `hour` and `minute` are validated because this is the exact seam
 * `probabilityAt` in `./week.ts` warns about: a picker built on HTML
 * `<select>`s can hand back a malformed or empty selection, and a `NaN`
 * composed here would otherwise pass every "is this a real timestamp" check
 * downstream all the way to a driver reading a confident-looking forecast.
 * `daySec` itself is only checked for finiteness -- it is meant to be an
 * opaque value threaded through from `dayOptions`, not re-derived here.
 *
 * The result is not clamped into the app's selectable range -- that is
 * `clampArrival`'s job, called separately, so a caller can inspect the raw
 * composed time before deciding whether to snap it.
 */
export function composeArrival(daySec: number, hour: number, minute: number): number {
  if (!Number.isFinite(daySec)) {
    throw new RangeError(`daySec ${daySec} is not a finite timestamp`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`hour ${hour} is outside 0..23`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute >= 60 || minute % STEP_MIN !== 0) {
    throw new RangeError(`minute ${minute} is outside 0..${60 - STEP_MIN} in steps of ${STEP_MIN}`);
  }
  return daySec + hour * 3600 + minute * 60;
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
