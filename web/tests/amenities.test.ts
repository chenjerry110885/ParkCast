/**
 * The three states of `m` and `e`, kept three.
 *
 * Every test here is written so that it fails for the *specific* collapse it
 * is guarding against, not merely for "something changed". The collapse that
 * matters is absent -> 0: a suite that only ever asserts what a reported zero
 * does will pass unchanged against code that treats an unreported field as a
 * reported zero, because both then take the same branch. So each case below
 * puts a zero and an absence side by side and asserts they *differ*.
 */
import { describe, expect, it } from "vitest";
import {
  AMENITIES,
  exclusionFor,
  hasAmenity,
  reported,
  tallyHidden,
  toggleAmenity,
} from "../src/amenities";
import type { Lot } from "../src/types";

const lot = (over: Partial<Lot> = {}): Lot => ({
  i: 0, id: "TPE1", n: "測試停車場", a: "中正區", y: 25.04, x: 121.51,
  c: 100, t: "民營停車場", p: { k: "exact", lo: 60, hi: 60 }, ...over,
});

describe("reported", () => {
  it("reads a count as a count", () => {
    expect(reported(lot({ m: 120 }), "scooter")).toEqual({ known: true, count: 120 });
    expect(reported(lot({ e: 8 }), "charging")).toEqual({ known: true, count: 8 });
  });

  it("reads a published zero as a measurement and an absent key as no measurement", () => {
    // The pair, in one assertion block, because either one alone is satisfied
    // by code that maps both to the same thing.
    expect(reported(lot({ m: 0 }), "scooter")).toEqual({ known: true, count: 0 });
    expect(reported(lot({}), "scooter")).toEqual({ known: false });
    expect(reported(lot({ m: 0 }), "scooter")).not.toEqual(reported(lot({}), "scooter"));
  });

  it("reads each amenity out of its own key, never the other one's", () => {
    // `m` and `e` are one character apart in a hand-written object literal, and
    // a swap would be invisible in every test that sets both to the same value.
    const scooterOnly = lot({ m: 5 });
    expect(reported(scooterOnly, "scooter")).toEqual({ known: true, count: 5 });
    expect(reported(scooterOnly, "charging")).toEqual({ known: false });
  });

  it("treats a null as unknown, because a null is not a count", () => {
    // The encoder never writes one -- absence is how it says "no value" -- but
    // a null arriving from anywhere must not read as zero, which is what a
    // `!== undefined` check would have done.
    expect(reported(lot({ m: null as unknown as number }), "scooter")).toEqual({ known: false });
  });
});

describe("hasAmenity", () => {
  it("is true only for a positive published count", () => {
    expect(hasAmenity(lot({ m: 1 }), "scooter")).toBe(true);
    expect(hasAmenity(lot({ m: 0 }), "scooter")).toBe(false);
    expect(hasAmenity(lot({}), "scooter")).toBe(false);
  });
});

describe("exclusionFor", () => {
  it("keeps every lot when nothing is filtered on", () => {
    for (const l of [lot({ m: 0 }), lot({}), lot({ m: 9 })]) {
      expect(exclusionFor(l, [])).toBeNull();
    }
  });

  it("keeps a match, and gives the two non-matches different reasons", () => {
    expect(exclusionFor(lot({ m: 9 }), ["scooter"])).toBeNull();
    expect(exclusionFor(lot({ m: 0 }), ["scooter"])).toBe("none");
    expect(exclusionFor(lot({}), ["scooter"])).toBe("unknown");
  });

  it("lets a definite no outrank an unknown, rather than the other way round", () => {
    // No scooter bays *and* nothing said about charging: we know why this lot
    // is out, and filing it under "doesn't say" would understate that.
    expect(exclusionFor(lot({ m: 0 }), ["scooter", "charging"])).toBe("none");
    // The mirror image, so the order of the loop cannot be what decides it.
    expect(exclusionFor(lot({ e: 0 }), ["scooter", "charging"])).toBe("none");
  });

  it("needs every active filter to match, not just one of them", () => {
    expect(exclusionFor(lot({ m: 4, e: 2 }), ["scooter", "charging"])).toBeNull();
    expect(exclusionFor(lot({ m: 4, e: 0 }), ["scooter", "charging"])).toBe("none");
    expect(exclusionFor(lot({ m: 4 }), ["scooter", "charging"])).toBe("unknown");
  });
});

describe("tallyHidden", () => {
  it("counts the two reasons separately and leaves matches out of both", () => {
    const lots = [
      lot({ id: "a", m: 3 }),
      lot({ id: "b", m: 0 }),
      lot({ id: "c", m: 0 }),
      lot({ id: "d" }),
    ];
    // Deliberately unequal counts: a tally that put an unknown in the wrong
    // bucket would still sum to 3 and would still be wrong.
    expect(tallyHidden(lots, ["scooter"])).toEqual({ none: 2, unknown: 1 });
  });

  it("hides nothing at all when no filter is on", () => {
    expect(tallyHidden([lot({ m: 0 }), lot({})], [])).toEqual({ none: 0, unknown: 0 });
  });
});

describe("toggleAmenity", () => {
  it("adds, removes, and keeps the row's own order", () => {
    expect(toggleAmenity([], "charging")).toEqual(["charging"]);
    expect(toggleAmenity(["charging"], "scooter")).toEqual([...AMENITIES]);
    expect(toggleAmenity([...AMENITIES], "scooter")).toEqual(["charging"]);
    expect(toggleAmenity(["scooter"], "scooter")).toEqual([]);
  });

  it("does not mutate the list it was given", () => {
    const active: readonly ("scooter" | "charging")[] = ["scooter"];
    toggleAmenity(active, "charging");
    expect(active).toEqual(["scooter"]);
  });
});
