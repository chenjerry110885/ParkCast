import { describe, expect, it } from "vitest";
import { calendarCovers, holidayName, isHoliday } from "../src/holidays";

/** Taipei wall-clock moments as epoch SECONDS: UTC+8, no DST, so exact arithmetic. */
const taipei = (y: number, m: number, d: number, h = 12, min = 0) =>
  Math.floor(Date.UTC(y, m - 1, d, h, min) / 1000) - 8 * 3600;

describe("the official calendar, in the browser", () => {
  it.each([
    [2026, 9, 25],
    [2026, 9, 28],
    [2026, 10, 9],
    [2026, 10, 10],
  ])("knows %i-%i-%i is a holiday", (y, m, d) => {
    expect(isHoliday(taipei(y, m, d))).toBe(true);
  });

  it("does not take an ordinary Saturday or Thursday for one", () => {
    expect(isHoliday(taipei(2026, 10, 3))).toBe(false);
    expect(isHoliday(taipei(2026, 10, 8))).toBe(false);
  });

  it("reads Taipei's date, not UTC's", () => {
    // Both moments are chosen so that the UTC date gives the WRONG answer.
    // (00:10 on Double Tenth would not do: it is the 9th in UTC, and the 9th is
    // a compensatory holiday too, so either reading says "holiday".)
    //
    // Teachers' Day at 00:10 is still Sunday the 27th in UTC -- an ordinary day.
    expect(isHoliday(taipei(2026, 9, 28, 0, 10))).toBe(true);
    // Saturday the 26th at 07:00 is still Mid-Autumn (the 25th) in UTC.
    expect(isHoliday(taipei(2026, 9, 26, 7, 0))).toBe(false);
  });

  it("names the holiday in the UI's language", () => {
    expect(holidayName(taipei(2026, 10, 10), "en")).toBe("National Day");
    expect(holidayName(taipei(2026, 10, 10), "zh")).toBe("國慶日");
    expect(holidayName(taipei(2026, 10, 8), "en")).toBeNull();
  });

  it("claims nothing past the end of the calendar", () => {
    // Beyond coverage the app behaves exactly as it did before the calendar.
    expect(calendarCovers(taipei(2027, 12, 31))).toBe(true);
    expect(calendarCovers(taipei(2028, 1, 1))).toBe(false);
    expect(isHoliday(taipei(2028, 10, 10))).toBe(false);
    expect(holidayName(taipei(2028, 10, 10), "en")).toBeNull();
  });
});
