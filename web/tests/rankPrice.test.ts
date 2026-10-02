import { describe, expect, it } from "vitest";
import {
  EXPECTED_HOURS,
  MEDIAN_PRICE_FALLBACK,
  feeForStay,
  rankLots,
  rateAt,
} from "../src/rank";
import type { Price } from "../src/types";

/**
 * Taipei is UTC+8 with no DST, so a wall-clock moment there is exact integer
 * arithmetic from the epoch. 2026-10-06 is a Tuesday and 2026-10-03 a Saturday;
 * the Python side asserts the same two dates, so the two implementations cannot
 * drift about which is which.
 */
const taipeiMidnight = (y: number, m: number, d: number) =>
  Math.floor(Date.UTC(y, m - 1, d) / 1000) - 8 * 3600;
const TUESDAY = taipeiMidnight(2026, 10, 6);
const SATURDAY = taipeiMidnight(2026, 10, 3);
/** Epoch SECONDS, as every timestamp in this project is. */
const on = (day: number, h: number, min = 0) => day + (h * 60 + min) * 60;

/** 08-22 at NT$50, 22-08 at NT$10 -- the commonest shape in the corpus. */
const DAY_NIGHT: Price = {
  k: "range", lo: 10, hi: 50,
  t: [["all", 8, 22, 50], ["all", 22, 8, 10]],
};

describe("rateAt", () => {
  it("reads the rate in force at that Taipei hour", () => {
    expect(rateAt(DAY_NIGHT.t!, on(TUESDAY, 14))).toBe(50);
  });

  it("covers both sides of a segment that wraps midnight", () => {
    // `22-08` is one segment. A rule assuming start < end would drop every
    // overnight rate in the corpus.
    expect(rateAt(DAY_NIGHT.t!, on(TUESDAY, 23))).toBe(10);
    expect(rateAt(DAY_NIGHT.t!, on(TUESDAY, 3))).toBe(10);
  });

  it("uses Taipei's clock, not the machine's", () => {
    // The lots are in Taipei. A driver reading the app from London must see the
    // rate Taipei is charging, not the one their own hour would select.
    const taipeiNoon = on(TUESDAY, 12);
    expect(rateAt(DAY_NIGHT.t!, taipeiNoon)).toBe(50);
    // 04:00 Taipei is the previous evening in London; still the night rate.
    expect(rateAt(DAY_NIGHT.t!, on(TUESDAY, 4))).toBe(10);
  });

  it("tells a Saturday from a Tuesday", () => {
    const scoped: Price["t"] = [["weekday", 8, 20, 50], ["weekend", 8, 20, 60]];
    expect(rateAt(scoped!, on(TUESDAY, 14))).toBe(50);
    expect(rateAt(scoped!, on(SATURDAY, 14))).toBe(60);
  });

  it("prefers the more specific scope over `all`", () => {
    const scoped: Price["t"] = [["all", 0, 0, 30], ["weekend", 10, 20, 60]];
    expect(rateAt(scoped!, on(SATURDAY, 14))).toBe(60);
    expect(rateAt(scoped!, on(TUESDAY, 14))).toBe(30);
  });

  it("returns null for an hour no segment covers", () => {
    // Never the other scope's rate, never a midpoint: an absence is not a number.
    const scoped: Price["t"] = [["weekend", 10, 20, 60]];
    expect(rateAt(scoped!, on(SATURDAY, 9))).toBeNull();
    expect(rateAt(scoped!, on(TUESDAY, 14))).toBeNull();
  });

  it("never resolves a holiday-scoped segment", () => {
    // No calendar, no claim: any day might be a public holiday.
    const holiday: Price["t"] = [["holiday", 10, 20, 80]];
    expect(rateAt(holiday!, on(SATURDAY, 14))).toBeNull();
    expect(rateAt(holiday!, on(TUESDAY, 14))).toBeNull();
  });

  it("still resolves an ordinary Tuesday at a lot that also prices holidays", () => {
    // 87 of the 219 varying lots price holidays as their own category. Refusing
    // all of them would cost 40% of the feature to protect ten days a year.
    const both: Price["t"] = [["weekday", 8, 20, 50], ["holiday", 8, 20, 80]];
    expect(rateAt(both!, on(TUESDAY, 14))).toBe(50);
  });
});

describe("feeForStay", () => {
  it("charges the arrival rate when the whole stay sits in one segment", () => {
    expect(feeForStay(DAY_NIGHT, on(TUESDAY, 14))).toBeCloseTo(50 * EXPECTED_HOURS);
  });

  it("integrates across a rate boundary inside the stay", () => {
    // 21:00 + 2h is one hour at 50 and one at 10. The arrival rate alone would
    // say 100; the old midpoint said 60. The driver pays 60 -- for a different
    // reason, and only by coincidence on this tariff.
    expect(feeForStay(DAY_NIGHT, on(TUESDAY, 21))).toBeCloseTo(50 + 10);
  });

  it("splits a part-hour at the boundary proportionally", () => {
    // 21:30 + 2h = 30 min at 50, 90 min at 10.
    expect(feeForStay(DAY_NIGHT, on(TUESDAY, 21, 30))).toBeCloseTo(50 * 0.5 + 10 * 1.5);
  });

  it("returns null when any minute of the stay has no rate", () => {
    // Partial coverage is not partial knowledge: a fee missing an hour is a
    // different quantity, not a smaller one.
    const partial: Price = { k: "range", lo: 10, hi: 50, t: [["all", 8, 10, 50]] };
    expect(feeForStay(partial, on(TUESDAY, 9))).toBeNull();
  });

  it("returns null for a lot with no schedule at all", () => {
    expect(feeForStay({ k: "range", lo: 10, hi: 50 }, on(TUESDAY, 14))).toBeNull();
  });

  it("returns null without an arrival time", () => {
    // A caller with no clock cannot resolve a time-of-day rate, and the honest
    // answer is the range rather than a guess.
    expect(feeForStay(DAY_NIGHT, undefined)).toBeNull();
  });

  it("agrees with the midpoint only when the tariff happens to be symmetric", () => {
    // Guards against anyone "simplifying" the integral back into a midpoint:
    // on this tariff a 14:00 arrival costs 100, where the midpoint says 60.
    const midpointFee = ((DAY_NIGHT.lo! + DAY_NIGHT.hi!) / 2) * EXPECTED_HOURS;
    expect(feeForStay(DAY_NIGHT, on(TUESDAY, 14))).not.toBeCloseTo(midpointFee);
    expect(MEDIAN_PRICE_FALLBACK).toBeGreaterThan(0);
  });
});

/**
 * The ranking shift, measured on the real ranker.
 *
 * The plan called for `scripts/probe-ranker.py` here. It cannot answer this:
 * the probe REIMPLEMENTS the fee in Python and still takes the midpoint, so it
 * would report no change at all. These run `rankLots` itself.
 */
describe("the ranking responds to the arrival time", () => {
  const lot = (id: string, lat: number, p: Price) =>
    ({ i: 0, id, n: id, a: "中正區", y: lat, x: 121.52, c: 50, t: "民營停車場", p }) as never;
  const destination = { lat: 25.05, lon: 121.52 };

  /** Equally close, equally likely: price is the only thing left to sort on. */
  const cheapAtNight: Price = { k: "range", lo: 10, hi: 50,
    t: [["all", 8, 22, 50], ["all", 22, 8, 10]] };
  const flatMiddling: Price = { k: "exact", lo: 30, hi: 30 };

  const order = (arrivalTs?: number) =>
    rankLots({
      destination, horizonMin: 15, arrivalTs,
      lots: [lot("varies", 25.0502, cheapAtNight), lot("flat", 25.0502, flatMiddling)],
      probability: () => 0.9,
    }).map((r) => r.lot.id);

  it("puts the varying lot last by day and first by night", () => {
    // 14:00: the varying lot charges 50 against the flat 30, so it loses.
    expect(order(on(TUESDAY, 14))).toEqual(["flat", "varies"]);
    // 23:00: it charges 10, so it wins. The midpoint could never express this --
    // it reads 30 at both hours and calls the two lots a tie.
    expect(order(on(TUESDAY, 23))).toEqual(["varies", "flat"]);
  });

  it("falls back to the old ordering without an arrival time", () => {
    // Midpoint 30 against flat 30: a tie, broken by input order. This is exactly
    // what the app did before the schedule existed, so a caller with no clock
    // loses the feature and gains no error.
    expect(order(undefined)).toEqual(["varies", "flat"]);
  });

  it("never moves a lot whose price does not depend on the time", () => {
    const flats = rankLots({
      destination, horizonMin: 15, arrivalTs: on(TUESDAY, 3),
      lots: [lot("a", 25.0502, { k: "exact", lo: 20, hi: 20 }),
             lot("b", 25.0502, { k: "exact", lo: 40, hi: 40 })],
      probability: () => 0.9,
    }).map((r) => r.lot.id);

    expect(flats).toEqual(["a", "b"]);   // 73.4% of the roster, unmoved
  });

  it("reports a holiday lot whose marker the scope fold erased", () => {
    // **The case the `h` flag exists for, and the one a segment scan misses.**
    // The feed writes holidays inside the weekend clause, so the collector folds
    // the marker into `weekend` -- correctly, the rate does apply to Saturdays.
    // The segments then say nothing about holidays, which described 35 of the 36
    // lots that name one: each resolved a confident weekday rate on Double Tenth
    // Day with no warning at all.
    const folded: Price = {
      k: "range", lo: 10, hi: 60, h: 1,
      t: [["weekday", 8, 20, 50], ["weekend", 8, 20, 60], ["all", 20, 8, 10]],
    };
    const ranked = rankLots({
      destination, horizonMin: 15, arrivalTs: on(TUESDAY, 14),
      lots: [lot("folded", 25.0502, folded)],
      probability: () => 0.9,
    });

    expect(folded.t!.some((s) => s[0] === "holiday")).toBe(false);   // the fold stands
    expect(ranked[0]!.pricesHolidays).toBe(true);
    expect(ranked[0]!.rateAtArrival).toBe(50);   // still resolves the ordinary Tuesday
  });

  it("claims nothing about holidays for a lot the collector did not flag", () => {
    // `假日` is the corpus's ordinary word for "weekend". A note on every lot
    // that merely prices weekends is a note nobody reads.
    const ranked = rankLots({
      destination, horizonMin: 15, arrivalTs: on(TUESDAY, 14),
      lots: [lot("plain", 25.0502, cheapAtNight)],
      probability: () => 0.9,
    });

    expect(ranked[0]!.pricesHolidays).toBe(false);
  });

  it("reports the arrival rate separately from the fee", () => {
    // The card shows what the sign says; the score charges the whole stay. At
    // 21:00 those differ: the rate is 50 and the two-hour fee is 60.
    const ranked = rankLots({
      destination, horizonMin: 15, arrivalTs: on(TUESDAY, 21),
      lots: [lot("varies", 25.0502, cheapAtNight)],
      probability: () => 0.9,
    });
    expect(ranked[0]!.rateAtArrival).toBe(50);
    expect(ranked[0]!.cost).not.toBeNull();
  });
});
