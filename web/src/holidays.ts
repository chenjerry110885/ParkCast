/**
 * Which Taipei dates are public holidays, from the government's own calendar.
 *
 * `holidaysTw.json` is written by `scripts/build-calendar.py` from
 * 行政院人事行政總處's 中華民國政府行政機關辦公日曆表, byte-for-byte the same
 * file the collector reads (`src/parkcast/holidays_tw.json`; a Python test
 * keeps them identical). See that script for the rule: a day off that is a
 * weekday, or a named day off on a weekend. An ordinary Saturday is not one.
 *
 * **Past the end of the calendar, nothing is claimed.** `isHoliday` answers
 * `false` for a date the file does not cover, because every caller's fallback
 * for "unknown" is what the app did before this existed, and that is the
 * behaviour to keep when the file runs out. `calendarCovers` is for the callers
 * that need to tell the two apart.
 *
 * Timestamps are epoch **seconds**, like every other one in this app, and the
 * date is Taipei's: UTC's would file the first eight hours of every holiday
 * under the day before it.
 */
import calendar from "./holidaysTw.json";
import type { Lang } from "./i18n";

/** `date -> [zh, en]`. Read as a plain array: JSON carries no tuple type. */
const HOLIDAYS: Record<string, readonly string[]> = calendar.holidays;
const [FIRST, LAST] = calendar.covers as [string, string];
const TAIPEI_OFFSET_SEC = 8 * 3600;

/** `YYYY-MM-DD` of the Taipei calendar date `ts` falls on. */
function taipeiDate(ts: number): string {
  return new Date((ts + TAIPEI_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

export function calendarCovers(ts: number): boolean {
  const day = taipeiDate(ts);
  return day >= FIRST && day <= LAST;
}

export function isHoliday(ts: number): boolean {
  return taipeiDate(ts) in HOLIDAYS;
}

/** The holiday's name in the UI's language, or `null` for any other day. */
export function holidayName(ts: number, lang: Lang): string | null {
  const names = HOLIDAYS[taipeiDate(ts)];
  if (names === undefined) return null;
  return names[lang === "zh" ? 0 : 1] ?? null;
}
