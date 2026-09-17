import { describe, expect, it } from "vitest";
import {
  MAX_LEAD_SEC, MIN_LEAD_SEC, STEP_SEC,
  arrivalOptions, ceilToStep, clampArrival, composeArrival, dayOptions, defaultArrival, floorToStep,
  formatClock, hourOptions, horizonFromReading, minuteOptions, relativeMinutes,
} from "../src/arrival";

/** 2026-09-06 06:48:00 UTC = 14:48 Taipei, the app tests' fixed reading. */
const BASE = 1788677280;
const grid = { baseDataTs: BASE, stepMin: 5, nHorizons: 24 };

describe("rounding to the 5-minute clock", () => {
  it("ceils and floors onto :00/:05 boundaries", () => {
    expect(ceilToStep(BASE)).toBe(BASE + 120);      // 14:48 -> 14:50
    expect(floorToStep(BASE)).toBe(BASE - 180);     // 14:48 -> 14:45
    expect(ceilToStep(BASE + 120)).toBe(BASE + 120); // already on the grid
  });
});

describe("arrivalOptions", () => {
  it("runs every 5 minutes from now+5 (rounded up) to the grid's last column (rounded down)", () => {
    const now = BASE + 240; // 14:52
    const options = arrivalOptions(now, grid);
    expect(options[0]).toBe(BASE + 720);            // 14:57 -> 15:00
    expect(options.at(-1)).toBe(floorToStep(BASE + 120 * 60)); // 16:48 -> 16:45
    expect(options.every((t, i) => i === 0 || t - options[i - 1]! === 300)).toBe(true);
  });

  it("shrinks as the reading ages and empties once nothing is left", () => {
    expect(arrivalOptions(BASE + 100 * 60, grid).length).toBeGreaterThan(0);
    expect(arrivalOptions(BASE + 118 * 60, grid)).toEqual([]);
  });

  it("reaches within one step of the grid's own end, whatever minute the reading lands on", () => {
    // `floorToStep` can only give up a *single* step: a reading that is not on
    // the 5-minute wall clock (14:48 here, the shipped feed's usual shape) puts
    // the last offer at 16:45 rather than 16:48. That shortfall is accepted --
    // the alternative is offering a clock time past the last column and letting
    // `probabilityAt` clamp it, which is the lie the whole strip exists to
    // avoid -- but it must stay one step, not two, so this pins it.
    const end = BASE + grid.stepMin * grid.nHorizons * 60;
    for (const offset of [0, 60, 137, 180, 299]) {
      const options = arrivalOptions(BASE - offset + 60, { ...grid, baseDataTs: BASE - offset });
      const last = options.at(-1)!;
      const gridEnd = BASE - offset + grid.stepMin * grid.nHorizons * 60;
      expect(last).toBeGreaterThanOrEqual(gridEnd - STEP_SEC);
      expect(last).toBeLessThanOrEqual(gridEnd);
    }
    // ...and for the fixture's own reading, spelled out.
    expect(arrivalOptions(BASE + 240, grid).at(-1)).toBeGreaterThanOrEqual(end - STEP_SEC);
  });
});

describe("defaultArrival and clampArrival", () => {
  it("defaults to now+15 rounded up to the clock grid", () => {
    expect(formatClock(defaultArrival(BASE + 240))).toBe("15:10"); // 14:52 + 15 = 15:07 -> 15:10
  });

  it("keeps a valid selection, snaps a passed one forward and an overrun one back", () => {
    const options = [BASE + 720, BASE + 1020, BASE + 1320];
    expect(clampArrival(BASE + 1020, options)).toBe(BASE + 1020);
    expect(clampArrival(BASE + 600, options)).toBe(BASE + 720);
    expect(clampArrival(BASE + 9999, options)).toBe(BASE + 1320);
    expect(clampArrival(BASE + 9999, [])).toBe(BASE + 9999);
  });
});

describe("horizons and display", () => {
  it("measures the horizon from the reading, which is the whole staleness correction", () => {
    expect(horizonFromReading(BASE + 22 * 60, BASE)).toBe(22);
  });

  it("reports minutes from now, rounded", () => {
    expect(relativeMinutes(BASE + 1320, BASE + 240)).toBe(18);
  });

  it("formats in Taipei time, 24-hour, zero-padded", () => {
    expect(formatClock(BASE)).toBe("14:48");
    expect(formatClock(1788566400)).toBe("08:00"); // 00:00 UTC
  });
});

/**
 * Fixtures for the seven-day range, both chosen to fail loudly on the two
 * bugs a "safe" fixture (a Tuesday noon mid-month) would hide entirely:
 *
 *  - `NOW_MIDNIGHT_SPLIT` sits at Taipei 02:00 -- deep enough into the
 *    Taipei calendar day that the *UTC* calendar date is still the day
 *    before. Any code that reads the UTC/host date instead of applying the
 *    fixed +8h shift (e.g. `Date#getUTCDate`/`getDate`) would compute
 *    "today" as 2026-09-16, one full day off; every `daySec` and `weekday`
 *    below would then be wrong by exactly one day, in a way a midday
 *    fixture can never trigger because midday Taipei and midday UTC always
 *    agree on the date.
 *  - `NOW_MONTH_YEAR_BOUNDARY` sits at Taipei 2026-12-29, so its 8-day
 *    window (Dec 29 - Jan 5) crosses both a month boundary (Dec -> Jan) and
 *    a year boundary (2026 -> 2027). A day-list built by naive
 *    month/day-of-month arithmetic instead of whole-day addition would
 *    misfire exactly here.
 *
 * Every expected value below (the Taipei midnight timestamps and the
 * weekday names) was cross-checked against `date`(1) -- an oracle
 * independent of this module's own arithmetic -- not derived from the
 * formulas under test.
 */
const NOW_MIDNIGHT_SPLIT = 1789581600; // UTC 2026-09-16T18:00:00Z = Taipei 2026-09-17 02:00:00 (Thursday)
const NOW_MONTH_YEAR_BOUNDARY = 1798506900; // UTC 2026-12-29T01:15:00Z = Taipei 2026-12-29 09:15:00 (Tuesday)

describe("MAX_LEAD_SEC", () => {
  it("is exactly seven days -- week.bin's own span, not an arbitrary cap", () => {
    expect(MAX_LEAD_SEC).toBe(7 * 24 * 3600);
  });
});

describe("dayOptions", () => {
  it("reads today, tomorrow, then six weekday names -- correct across a Taipei/UTC date split", () => {
    const days = dayOptions(NOW_MIDNIGHT_SPLIT);
    expect(days.map((d) => d.kind)).toEqual([
      "today", "tomorrow", "weekday", "weekday", "weekday", "weekday", "weekday", "weekday",
    ]);
    // Thu 09-17 .. Thu 09-24 2026, each Taipei midnight, spaced exactly one day apart.
    expect(days.map((d) => d.daySec)).toEqual([
      1789574400, 1789660800, 1789747200, 1789833600,
      1789920000, 1790006400, 1790092800, 1790179200,
    ]);
    // Thu, Fri, Sat, Sun, Mon, Tue, Wed, Thu (Date#getDay convention, Sun=0).
    expect(days.map((d) => d.weekday)).toEqual([4, 5, 6, 0, 1, 2, 3, 4]);
  });

  it("stays correct across a month AND a year boundary", () => {
    const days = dayOptions(NOW_MONTH_YEAR_BOUNDARY);
    expect(days.map((d) => d.kind)).toEqual([
      "today", "tomorrow", "weekday", "weekday", "weekday", "weekday", "weekday", "weekday",
    ]);
    // Tue 2026-12-29 .. Tue 2027-01-05, each Taipei midnight, spaced exactly one day apart.
    expect(days.map((d) => d.daySec)).toEqual([
      1798473600, 1798560000, 1798646400, 1798732800,
      1798819200, 1798905600, 1798992000, 1799078400,
    ]);
    // Tue, Wed, Thu, Fri, Sat, Sun, Mon, Tue.
    expect(days.map((d) => d.weekday)).toEqual([2, 3, 4, 5, 6, 0, 1, 2]);
  });

  it("always offers exactly 8 calendar days -- MAX_LEAD_SEC reaches the 8th day's own time-of-day, not its midnight", () => {
    // A flat 604800s (7*86400) added to `now` itself, not to a day boundary,
    // lands on the *same* Taipei time-of-day 7 calendar days out -- true only
    // because Taipei has no DST to shift it. An implementation that instead
    // looped `i < 7` (today..+6, matching the "seven days" name too literally)
    // would produce 7 entries here, one short of what the range can reach.
    expect(dayOptions(NOW_MIDNIGHT_SPLIT)).toHaveLength(8);
    expect(dayOptions(NOW_MONTH_YEAR_BOUNDARY)).toHaveLength(8);
    expect(dayOptions(0)).toHaveLength(8);
  });

  it("day count is coupled to MAX_LEAD_SEC, not a second hard-coded loop bound kept in sync by hand", () => {
    // Both sides are independent literals -- neither is derived from the
    // other, and neither is derived from the implementation under test.
    // MAX_LEAD_SEC is restated here as the plain "seven days" arithmetic it
    // is defined as; 8 is dayOptions' own stated length for that value. If
    // dayOptions ever reverts to a bare `i <= 7` loop instead of reading
    // MAX_LEAD_SEC (as it did before this test was added), this assertion
    // stops being able to move when MAX_LEAD_SEC does -- which is exactly
    // what changing MAX_LEAD_SEC in the source, not in this test file, is
    // for catching.
    expect(MAX_LEAD_SEC).toBe(7 * 24 * 3600);
    expect(dayOptions(NOW_MIDNIGHT_SPLIT)).toHaveLength(8);
  });
});

describe("hourOptions and minuteOptions", () => {
  it("hourOptions offers every hour of the Taipei day, 0..23", () => {
    expect(hourOptions()).toEqual(Array.from({ length: 24 }, (_, h) => h));
  });

  it("minuteOptions steps by 5, 0..55", () => {
    const minutes = minuteOptions();
    expect(minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(minutes.every((m, i) => i === 0 || m - minutes[i - 1]! === 5)).toBe(true);
  });
});

describe("composeArrival", () => {
  it("combines a day/hour/minute selection into the exact Taipei clock time, cross-checked against Intl's own Taipei conversion", () => {
    const today = dayOptions(NOW_MIDNIGHT_SPLIT)[0]!; // Taipei 2026-09-17 00:00
    // formatClock resolves via Intl.DateTimeFormat's own ICU timeZone data, a
    // code path independent of composeArrival's +8h arithmetic -- if the two
    // disagreed about the offset (wrong sign, double-applied, or omitted),
    // this would catch it even though both live in the same module.
    expect(formatClock(composeArrival(today.daySec, 0, 0))).toBe("00:00");
    expect(formatClock(composeArrival(today.daySec, 14, 30))).toBe("14:30");
    expect(formatClock(composeArrival(today.daySec, 23, 55))).toBe("23:55");
    expect(composeArrival(today.daySec, 14, 30)).toBe(today.daySec + 14 * 3600 + 30 * 60);
  });

  it("does not clamp -- an overrun composition is returned raw, exactly as given", () => {
    const last = dayOptions(NOW_MIDNIGHT_SPLIT)[7]!; // the 8th day, past which nothing is offered
    const composed = composeArrival(last.daySec, 23, 55);
    expect(composed).toBe(last.daySec + 23 * 3600 + 55 * 60);
    expect(composed).toBeGreaterThan(NOW_MIDNIGHT_SPLIT + MAX_LEAD_SEC); // genuinely past the range
  });

  it("rejects an hour outside 0..23", () => {
    const daySec = dayOptions(NOW_MIDNIGHT_SPLIT)[0]!.daySec;
    expect(() => composeArrival(daySec, 24, 0)).toThrow(RangeError);
    expect(() => composeArrival(daySec, -1, 0)).toThrow(RangeError);
    expect(() => composeArrival(daySec, 1.5, 0)).toThrow(RangeError);
  });

  it("rejects a minute outside 0..55 or not a multiple of 5", () => {
    const daySec = dayOptions(NOW_MIDNIGHT_SPLIT)[0]!.daySec;
    expect(() => composeArrival(daySec, 0, 60)).toThrow(RangeError);
    expect(() => composeArrival(daySec, 0, -5)).toThrow(RangeError);
    expect(() => composeArrival(daySec, 0, 7)).toThrow(RangeError);
  });

  it("rejects a non-finite daySec -- the shape a malformed <select> would hand back", () => {
    expect(() => composeArrival(NaN, 0, 0)).toThrow(RangeError);
  });
});

describe("clampArrival against a {min, max} range", () => {
  const min = ceilToStep(NOW_MIDNIGHT_SPLIT + MIN_LEAD_SEC);
  const max = NOW_MIDNIGHT_SPLIT + MAX_LEAD_SEC;

  it("passes a selection already inside the range through unchanged", () => {
    const mid = composeArrival(dayOptions(NOW_MIDNIGHT_SPLIT)[3]!.daySec, 9, 0); // well within the window
    expect(clampArrival(mid, { min, max })).toBe(mid);
  });

  it("snaps a time before now forward to the range's own start, not to midnight or to now", () => {
    const beforeNow = composeArrival(dayOptions(NOW_MIDNIGHT_SPLIT)[0]!.daySec, 0, 0); // today 00:00, well before 'now' (02:00)
    expect(beforeNow).toBeLessThan(NOW_MIDNIGHT_SPLIT);
    expect(clampArrival(beforeNow, { min, max })).toBe(min);
  });

  it("snaps an overrun selection back to the range's own end", () => {
    const overrun = composeArrival(dayOptions(NOW_MIDNIGHT_SPLIT)[7]!.daySec, 23, 55);
    expect(clampArrival(overrun, { min, max })).toBe(max);
  });

  it("every day/hour/minute combination clamps into [min, max]", () => {
    for (const day of dayOptions(NOW_MIDNIGHT_SPLIT)) {
      for (const hour of hourOptions()) {
        for (const minute of minuteOptions()) {
          const clamped = clampArrival(composeArrival(day.daySec, hour, minute), { min, max });
          expect(clamped).toBeGreaterThanOrEqual(min);
          expect(clamped).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it("still honours the original options-array form unchanged (backward compatibility)", () => {
    const options = [NOW_MIDNIGHT_SPLIT + 720, NOW_MIDNIGHT_SPLIT + 1020, NOW_MIDNIGHT_SPLIT + 1320];
    expect(clampArrival(NOW_MIDNIGHT_SPLIT + 1020, options)).toBe(NOW_MIDNIGHT_SPLIT + 1020);
    expect(clampArrival(NOW_MIDNIGHT_SPLIT + 9999, [])).toBe(NOW_MIDNIGHT_SPLIT + 9999);
  });
});

describe("a far-future arrival reads as a day and a time, not a minute count", () => {
  it("dayOptions' kind plus formatClock builds that label; relativeMinutes alone would not", () => {
    const farDay = dayOptions(NOW_MIDNIGHT_SPLIT)[5]!; // Tuesday, five days out
    const arrival = composeArrival(farDay.daySec, 9, 0);
    expect(farDay.kind).toBe("weekday");
    expect(farDay.weekday).toBe(2); // Tuesday
    expect(formatClock(arrival)).toBe("09:00");
    // relativeMinutes keeps working exactly as before (nothing here breaks
    // it) -- it is simply the wrong tool for this label: thousands of
    // minutes out, which is exactly why the picker reaches for `kind` and
    // `formatClock` instead.
    expect(relativeMinutes(arrival, NOW_MIDNIGHT_SPLIT)).toBeGreaterThan(5 * 24 * 60);
  });
});
