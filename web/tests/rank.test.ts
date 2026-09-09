import { describe, expect, it } from "vitest";
import {
  CIRCLING_PENALTY_MIN,
  EXPECTED_HOURS,
  TIME_VALUE,
  UNKNOWN_RESERVE,
  listRows,
  rankLots,
} from "../src/rank";

const lot = (id: string, lat: number, p: unknown) =>
  ({ i: 0, id, n: id, a: "中正區", y: lat, x: 121.52, c: 50, t: "民營停車場", p }) as never;

const at = { lat: 25.05, lon: 121.52 };

describe("rankLots", () => {
  it("prefers a likelier space over a marginally closer one", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("far-likely", 25.0505, { k: "exact", lo: 50, hi: 50 }),
             lot("near-full", 25.0501, { k: "exact", lo: 50, hi: 50 })],
      probability: (i) => (i === 0 ? 0.95 : 0.05),
    });
    expect(out[0]!.id).toBe("far-likely");
  });

  it("does not reward a lot for having no price", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("unpriced", 25.05, { k: "unknown" }),
             lot("cheap", 25.05, { k: "exact", lo: 10, hi: 10 })],
      probability: () => 0.9,
    });
    expect(out[0]!.id).toBe("cheap");
  });

  it("marks an unpriced lot so the UI can say so", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("unpriced", 25.05, { k: "unknown" })],
      probability: () => 0.9,
    });
    expect(out[0]!.priceKnown).toBe(false);
    expect(out[0]!.hourly).toBeNull();
  });

  it("uses the midpoint of a price range", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("ranged", 25.05, { k: "range", lo: 20, hi: 40 })],
      probability: () => 0.9,
    });
    expect(out[0]!.hourly).toBe(30);
    expect(out[0]!.priceKnown).toBe(true);
  });

  it("keeps a lot whose probability is unknown, ranked last, not dropped", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("noprob", 25.05, { k: "exact", lo: 10, hi: 10 }),
             lot("known", 25.05, { k: "exact", lo: 10, hi: 10 })],
      probability: (i) => (i === 0 ? null : 0.5),
    });
    expect(out.map((r) => r.id)).toEqual(["known", "noprob"]);
    expect(out[1]!.probability).toBeNull();
  });

  it("exposes the components rather than only a score", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("a", 25.0505, { k: "exact", lo: 50, hi: 50 })],
      probability: () => 0.8,
    });
    expect(out[0]).toMatchObject({
      probability: 0.8, hourly: 50, priceKnown: true,
    });
    expect(out[0]!.walkMin).toBeGreaterThan(0);
    expect(out[0]!.meters).toBeGreaterThan(0);
  });
});

/**
 * The list cap, and the guarantee it used to quietly undo.
 *
 * `rankLots` keeps a lot with no forecast and sorts it behind every lot that has
 * one. Rendering only the first N rows then dropped exactly those lots -- the
 * ranker's one explicit promise, cancelled by a slice two files away. Today's
 * grid has no unknown cells, but collection gaps are expected and
 * time-correlated (see CLAUDE.md), and thin climatology buckets are what
 * produces them.
 */
describe("listRows", () => {
  /** `n` lots, all at the destination, `unknownFrom` onwards having no forecast. */
  function ranking(n: number, unknownFrom: number, spacing = 0.0001) {
    return rankLots({
      destination: at,
      horizonMin: 15,
      // Further away with each index, so distance and rank agree by default.
      lots: Array.from({ length: n }, (_unused, k) =>
        lot(`lot-${k}`, at.lat + k * spacing, { k: "exact", lo: 30, hi: 30 }),
      ),
      probability: (i) => (i >= unknownFrom ? null : 0.9),
    });
  }

  it("caps a list of known lots at the limit", () => {
    expect(listRows(ranking(50, 50), 20)).toHaveLength(20);
  });

  it("returns everything when the ranking is shorter than the limit", () => {
    expect(listRows(ranking(3, 3), 20)).toHaveLength(3);
  });

  it("makes a nearby lot with no forecast reachable past the cap", () => {
    // 25 lots. The nearest of all of them has no forecast, so the ranker puts
    // it 25th -- one row past a fixed cap of 20, and invisible.
    const ranked = rankLots({
      destination: at,
      horizonMin: 15,
      lots: [
        lot("nearest-unknown", at.lat + 0.00005, { k: "exact", lo: 30, hi: 30 }),
        ...Array.from({ length: 24 }, (_unused, k) =>
          lot(`known-${k}`, at.lat + 0.001 * (k + 1), { k: "exact", lo: 30, hi: 30 }),
        ),
      ],
      probability: (i) => (i === 0 ? null : 0.9),
    });
    expect(ranked.at(-1)!.id).toBe("nearest-unknown");

    const listed = listRows(ranked, 20);
    expect(listed.map((r) => r.id)).toContain("nearest-unknown");
    // Grown, not reordered: the 20 scored lots keep their places and their sort.
    expect(listed.slice(0, 20)).toEqual(ranked.slice(0, 20));
  });

  it("does not reach past the cap for a lot further than anything on screen", () => {
    // "Nearby" is set by the user's own list. A no-forecast lot across the city
    // is not owed a row, and appending it would make the cap meaningless.
    const ranked = rankLots({
      destination: at,
      horizonMin: 15,
      lots: [
        lot("far-unknown", at.lat + 0.5, { k: "exact", lo: 30, hi: 30 }),
        ...Array.from({ length: 24 }, (_unused, k) =>
          lot(`known-${k}`, at.lat + 0.0001 * (k + 1), { k: "exact", lo: 30, hi: 30 }),
        ),
      ],
      probability: (i) => (i === 0 ? null : 0.9),
    });
    expect(listRows(ranked, 20)).toHaveLength(20);
  });

  it("rescues at most UNKNOWN_RESERVE of them, so the list stays a list", () => {
    // 20 known lots far out, then 30 unknown ones nearer than all of them.
    const ranked = rankLots({
      destination: at,
      horizonMin: 15,
      lots: [
        ...Array.from({ length: 20 }, (_unused, k) =>
          lot(`known-${k}`, at.lat + 0.01 + 0.0001 * k, { k: "exact", lo: 30, hi: 30 }),
        ),
        ...Array.from({ length: 30 }, (_unused, k) =>
          lot(`unknown-${k}`, at.lat + 0.0001 * (k + 1), { k: "exact", lo: 30, hi: 30 }),
        ),
      ],
      probability: (i) => (i < 20 ? 0.9 : null),
    });
    const listed = listRows(ranked, 20);
    expect(listed).toHaveLength(20 + UNKNOWN_RESERVE);
    // Nearest first among the rescued, which is the only order they have.
    const rescued = listed.slice(20);
    expect(rescued.map((r) => r.id)).toEqual(["unknown-0", "unknown-1", "unknown-2", "unknown-3", "unknown-4"]);
  });

  it("adds nothing when the cap already reached the no-forecast group", () => {
    // 21 lots, the last two unknown: one is already visible at row 20, so the
    // promise is kept and there is nothing to rescue.
    const listed = listRows(ranking(21, 19), 20);
    expect(listed).toHaveLength(20);
    expect(listed.some((r) => r.probability === null)).toBe(true);
  });

  it("adds nothing when no lot has a forecast at all", () => {
    // The expired-artifact case: every row is unknown, the head *is* the group,
    // and growing the list by five arbitrary extras would help nobody.
    expect(listRows(ranking(50, 0), 20)).toHaveLength(20);
  });
});

/**
 * The failure branch.
 *
 * `cost` claims to be an expected cost in NT$, and until 2026-09-09 it was not
 * one: it charged every lot its own fee whether or not you got in, and charged
 * a failed attempt only the time spent circling -- never the trip to wherever
 * you actually ended up. The probability term was therefore capped at
 * `CIRCLING_PENALTY_MIN * TIME_VALUE`, NT$60 at the shipped constants, which is
 * also 12 minutes of walking. Being a kilometre closer cancelled being
 * certainly full, and `scripts/probe-ranker.py` found 89 orderings that said so.
 */
describe("rankLots: the cost of arriving to find no space", () => {
  const priced = (n: number) => ({ k: "exact", lo: n, hi: n });

  it("ranks a certain space above a hopeless one a kilometre nearer", () => {
    // The real inversion, reproduced: 嘟嘟房捷運北投站 at P=1% and NT$50 a visit,
    // standing where the driver is, against 復興路 at P=100%, NT$40 a visit and
    // 1,066 m away. The old model scored them 109.4 and 110.0 and put the lot
    // that is certainly full first, ninth in a list of ten.
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("hopeless-here", 25.05, priced(25)),
             lot("certain-far", 25.0596, priced(20))],
      probability: (i) => (i === 0 ? 0.01 : 1),
    });
    expect(out[0]!.id).toBe("certain-far");
  });

  it("charges a failed attempt for the trip it forces, not just for circling", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("coin-flip", 25.05, priced(30)),
             lot("certain-far", 25.0596, priced(30))],
      probability: (i) => (i === 0 ? 0.5 : 1),
    });
    const flip = out.find((r) => r.id === "coin-flip")!;
    const far = out.find((r) => r.id === "certain-far")!;
    // Half the time you pay the near lot's own cost; the other half you pay the
    // circling penalty AND the far lot's cost, having gained nothing.
    expect(flip.cost).toBeCloseTo(
      0.5 * (flip.walkMin * TIME_VALUE + 60) +
        0.5 * (CIRCLING_PENALTY_MIN * TIME_VALUE + far.cost!),
      6,
    );
  });

  it("still reduces to walking plus money for a lot that is certain", () => {
    // p = 1 removes the failure branch entirely, so the score is exactly what a
    // driver pays: the walk and the fare, and nothing speculative on top.
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("sure-thing", 25.0505, priced(45))],
      probability: () => 1,
    });
    expect(out[0]!.cost).toBeCloseTo(out[0]!.walkMin * TIME_VALUE + 45 * EXPECTED_HOURS, 6);
  });

  it("keeps working when nothing in the roster is reliable", () => {
    // No lot clears RELIABLE_P, so there is no trustworthy alternative to fall
    // back to. The ranking must still be an ordering, not a crash or a tie.
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("bad-near", 25.05, priced(50)), lot("better-near", 25.05, priced(50))],
      probability: (i) => (i === 0 ? 0.1 : 0.4),
    });
    expect(out[0]!.id).toBe("better-near");
    expect(out.every((r) => Number.isFinite(r.cost!))).toBe(true);
  });

  it("leaves a lot with no forecast out of the failure arithmetic", () => {
    // An unknown probability still means an unknown cost and last place: the
    // fallback term must not quietly manufacture a number for it.
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("no-forecast", 25.05, priced(10)), lot("known", 25.0505, priced(90))],
      probability: (i) => (i === 0 ? null : 0.95),
    });
    expect(out[0]!.id).toBe("known");
    expect(out[1]!.cost).toBeNull();
  });
});
