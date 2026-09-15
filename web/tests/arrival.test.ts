import { describe, expect, it } from "vitest";
import {
  STEP_SEC, arrivalOptions, ceilToStep, clampArrival, defaultArrival, floorToStep, formatClock, horizonFromReading, relativeMinutes,
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
