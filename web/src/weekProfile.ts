/**
 * A car park's typical week, read back out of `week.bin` as something a
 * person can scan: seven days of 24 hours (plus public holidays, on a
 * version-2 table), and the one stretch it is usually hardest to park in.
 *
 * This is the climatology the app already forecasts from past the grid's
 * window -- shown, rather than consulted one cell at a time. Nothing here
 * re-derives a probability: every hour is the mean of two cells the
 * collector wrote, and an unknown cell stays unknown.
 */
import type { WeekTable } from "./types";
import { WEEK_UNKNOWN } from "./week";

export type ProfileDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | "holiday";

export interface ProfileRow {
  day: ProfileDay;
  /** 24 hours, each P(a space) in 0..1, or `null` where neither half-hour is known. */
  hours: (number | null)[];
}

export interface BusyWindow {
  day: ProfileDay;
  /** First hour of the window, 0..21. */
  startHour: number;
  /** One past its last hour: a window from 14 to 17 covers 14:00-16:59. */
  endHour: number;
}

/** Half-hours in a day. */
const PER_DAY = 48;
/** Days in the clock week; slot 7, on a version-2 table, is the holiday day. */
const CLOCK_DAYS = 7;
const HOLIDAY_SLOT = 7;
/** Display order, Monday first. */
const WEEK: readonly ProfileDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** Hours in a busy window. */
const WINDOW_HOURS = 3;
/**
 * A window is "busy" only below this mean chance of a space. Above it, a
 * driver usually finds room, and naming the lot's least-bad stretch as its
 * busiest would be inventing a warning.
 */
const BUSY_BELOW = 0.6;

/**
 * Clock slot of a display row. The week table's bucket 0 is Thursday 00:00
 * Taipei (the Unix epoch fell on a Thursday), so Monday -- display row 0 --
 * is slot 4.
 */
function slotOf(displayRow: number): number {
  return (displayRow + 4) % CLOCK_DAYS;
}

/** P(a space) at one bucket of one lot, or `null` for the unknown sentinel. */
function cell(table: WeekTable, row: number, bucket: number): number | null {
  const percent = table.cells[(row * table.nBuckets + bucket) * 2]!;
  return percent === WEEK_UNKNOWN ? null : percent / 100;
}

/** One day of a lot: 24 hourly means read from the slot's 48 half-hours. */
function day(table: WeekTable, row: number, slot: number): (number | null)[] {
  const hours: (number | null)[] = [];
  for (let h = 0; h < 24; h++) {
    const known = [cell(table, row, slot * PER_DAY + h * 2), cell(table, row, slot * PER_DAY + h * 2 + 1)].filter(
      (p): p is number => p !== null,
    );
    hours.push(known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length);
  }
  return hours;
}

/**
 * Monday to Sunday, then -- only on a version-2 table -- public holidays.
 *
 * `row` is the lot's grid row (`Lot.i`), the same index every other
 * `week.bin` lookup uses.
 */
export function profileRows(table: WeekTable, row: number): ProfileRow[] {
  const rows: ProfileRow[] = WEEK.map((name, r) => ({ day: name, hours: day(table, row, slotOf(r)) }));
  if (table.nBuckets > CLOCK_DAYS * PER_DAY) rows.push({ day: "holiday", hours: day(table, row, HOLIDAY_SLOT) });
  return rows;
}

/**
 * The three hours, within one day, a driver is least likely to find a space
 * -- or `null` when even that stretch usually has room (mean at or above
 * 0.6). A window with an unknown hour is skipped rather than averaged over
 * the hours that are known: a hole is not evidence of a quiet hour. On a tie
 * the earlier day and hour win, so the answer is stable.
 */
export function busiestWindow(rows: readonly ProfileRow[]): BusyWindow | null {
  let best: { window: BusyWindow; mean: number } | null = null;
  for (const { day: name, hours } of rows) {
    for (let start = 0; start + WINDOW_HOURS <= hours.length; start++) {
      const span = hours.slice(start, start + WINDOW_HOURS);
      if (span.some((p) => p === null)) continue;
      const mean = (span as number[]).reduce((a, b) => a + b, 0) / WINDOW_HOURS;
      if (best === null || mean < best.mean) {
        best = { window: { day: name, startHour: start, endHour: start + WINDOW_HOURS }, mean };
      }
    }
  }
  return best !== null && best.mean < BUSY_BELOW ? best.window : null;
}
