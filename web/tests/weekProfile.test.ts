import { describe, expect, it } from "vitest";
import type { WeekTable } from "../src/types";
import { WEEK_UNKNOWN } from "../src/week";
import { busiestWindow, profileRows } from "../src/weekProfile";

/**
 * A one-lot table, every cell `fill`%, with chosen buckets overridden.
 *
 * Built as a `WeekTable` directly rather than through `parseWeek`: the byte
 * layout is `week.test.ts`'s business, and this file is about reading a
 * parsed table back as a week a person can scan.
 */
function table(nBuckets: 336 | 384, fill: number, cells: Record<number, number> = {}): WeekTable {
  const bytes = new Uint8Array(nBuckets * 2);
  for (let b = 0; b < nBuckets; b++) {
    bytes[b * 2] = cells[b] ?? fill;
    bytes[b * 2 + 1] = 6;
  }
  return { nLots: 1, rosterId: 1, builtTs: 0, nBuckets, cells: bytes };
}

/**
 * Clock bucket of a Taipei day and hour. Bucket 0 is Thursday 00:00, so the
 * clock slot of a day is its offset from Thursday: Mon 4, Tue 5, Wed 6, Thu 0,
 * Fri 1, Sat 2, Sun 3.
 */
const SLOT = { thu: 0, fri: 1, sat: 2, sun: 3, mon: 4, tue: 5, wed: 6 } as const;
const bucket = (day: keyof typeof SLOT, hour: number, half: 0 | 1 = 0) => SLOT[day] * 48 + hour * 2 + half;

describe("profileRows", () => {
  it("lists Monday to Sunday, reading each from its Thursday-anchored slot", () => {
    // Monday 09:00 is clock slot 4. A reader that took row 0 as slot 0 would
    // put this dip on Thursday, and one that anchored on Sunday on Friday.
    const rows = profileRows(table(336, 80, { [bucket("mon", 9)]: 10, [bucket("mon", 9, 1)]: 10 }), 0);

    expect(rows.map((r) => r.day)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
    expect(rows[0]!.hours[9]).toBeCloseTo(0.1);
    expect(rows[0]!.hours[8]).toBeCloseTo(0.8);
    expect(rows[3]!.hours[9]).toBeCloseTo(0.8);
    expect(rows.every((r) => r.hours.length === 24)).toBe(true);
  });

  it("averages an hour's two half-hours", () => {
    const rows = profileRows(table(336, 80, { [bucket("sat", 14)]: 20, [bucket("sat", 14, 1)]: 40 }), 0);
    expect(rows[5]!.hours[14]).toBeCloseTo(0.3);
  });

  it("adds a holiday row for a version-2 table only, read from the holiday day", () => {
    const v2 = profileRows(table(384, 80, { [336 + 28]: 30, [336 + 29]: 30 }), 0);
    expect(v2.map((r) => r.day)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday"]);
    expect(v2[7]!.hours[14]).toBeCloseTo(0.3);

    expect(profileRows(table(336, 80), 0)).toHaveLength(7);
  });

  it("never turns an unknown cell into a number", () => {
    // One unknown half-hour leaves the other to speak for the hour; two leave
    // nothing, and the hour is null -- never 0, which would read "full".
    const rows = profileRows(
      table(336, 80, {
        [bucket("tue", 3)]: WEEK_UNKNOWN,
        [bucket("tue", 4)]: WEEK_UNKNOWN,
        [bucket("tue", 4, 1)]: WEEK_UNKNOWN,
      }),
      0,
    );
    expect(rows[1]!.hours[3]).toBeCloseTo(0.8);
    expect(rows[1]!.hours[4]).toBeNull();
  });

  it("reads the lot it was asked for", () => {
    const two: WeekTable = { ...table(336, 80), nLots: 2, cells: new Uint8Array([...table(336, 80).cells, ...table(336, 25).cells]) };
    expect(profileRows(two, 1)[0]!.hours[0]).toBeCloseTo(0.25);
  });
});

describe("busiestWindow", () => {
  it("finds the three-hour stretch least likely to have a space", () => {
    const dip: Record<number, number> = {};
    for (let h = 14; h < 17; h++) {
      dip[bucket("sat", h)] = 15;
      dip[bucket("sat", h, 1)] = 15;
    }
    expect(busiestWindow(profileRows(table(336, 85, dip), 0))).toEqual({ day: "sat", startHour: 14, endHour: 17 });
  });

  it("says nothing for a lot that usually has room", () => {
    expect(busiestWindow(profileRows(table(336, 90), 0))).toBeNull();
    // 0.6 is not "busy": the window must be below it.
    expect(busiestWindow(profileRows(table(336, 60), 0))).toBeNull();
  });

  it("skips a window with an hour nobody knows", () => {
    const cells: Record<number, number> = {};
    for (let h = 0; h < 24; h++) {
      cells[bucket("wed", h)] = h === 11 ? WEEK_UNKNOWN : 10;
      cells[bucket("wed", h, 1)] = h === 11 ? WEEK_UNKNOWN : 10;
    }
    const window = busiestWindow(profileRows(table(336, 90, cells), 0));
    expect(window?.day).toBe("wed");
    // Any window containing 11:00 has a hole; the first whole one is 00-03.
    expect(window).toEqual({ day: "wed", startHour: 0, endHour: 3 });
  });
});
