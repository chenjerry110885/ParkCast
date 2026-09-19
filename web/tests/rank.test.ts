import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { haversineMeters } from "../src/geo";
import {
  CIRCLING_PENALTY_MIN,
  DELAY_VALUE,
  DRIVE_MIN_PER_KM,
  EXPECTED_HOURS,
  PREFERENCES,
  UNKNOWN_RESERVE,
  WALK_VALUE,
  listRows,
  notUpdating,
  rankLots,
  type Preference,
} from "../src/rank";

const lot = (id: string, lat: number, p: unknown) =>
  ({ i: 0, id, n: id, a: "中正區", y: lat, x: 121.52, c: 50, t: "民營停車場", p }) as never;

/**
 * The same lot with its feed marked stopped. `u` is the collector's liveness
 * stamp (`src/parkcast/liveness.py`): present only for a lot that has not
 * moved in at least 24 hours, absent otherwise.
 */
const stalled = (l: unknown, u = 1_789_000_000) => ({ ...(l as object), u }) as never;

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

  /* ------------------------------------------------------------------ *
   * A car park whose feed has stopped. Past `grid.bin`'s +120 min window
   * `week.bin` answers for it as readily as for a live one -- climatology
   * does not depend on whether a feed reported today -- so before `group`
   * existed a lot nobody had heard from in thirty hours could top the list
   * and wear the "Best pick" badge. The number is honest; the
   * recommendation was not. See `group` in `rank.ts`.
   * ------------------------------------------------------------------ */

  it("ranks a car park whose feed has stopped below one we can still see", () => {
    const out = rankLots({
      destination: at, horizonMin: 200,
      lots: [stalled(lot("dead-but-likely", 25.05, { k: "exact", lo: 10, hi: 10 })),
             lot("live-but-worse", 25.05, { k: "exact", lo: 10, hi: 10 })],
      // The stalled lot wins on every term the cost model can see: same walk,
      // same fare, and nineteen times the chance of a space.
      probability: (i) => (i === 0 ? 0.95 : 0.05),
    });
    expect(out.map((r) => r.id)).toEqual(["live-but-worse", "dead-but-likely"]);
  });

  it("keeps the demoted lot's number and its score, not just its row", () => {
    // The opposite fault would be to blank it. The climatology is a real
    // answer about what this car park usually has free at this hour, and the
    // card says the feed has stopped among the lot's own facts.
    const out = rankLots({
      destination: at, horizonMin: 200,
      lots: [stalled(lot("dead", 25.05, { k: "exact", lo: 10, hi: 10 })),
             lot("live", 25.05, { k: "exact", lo: 10, hi: 10 })],
      probability: () => 0.95,
    });
    expect(out[1]!.id).toBe("dead");
    expect(out[1]!.probability).toBe(0.95);
    expect(out[1]!.cost).not.toBeNull();
  });

  it("still ranks a stalled lot above one with no forecast at all", () => {
    // Three groups, not two. "A number we will not vouch for" is better
    // evidence than "nothing", and collapsing the two would undo the
    // no-forecast rule this file already pins.
    const out = rankLots({
      destination: at, horizonMin: 200,
      lots: [lot("noprob", 25.05, { k: "exact", lo: 10, hi: 10 }),
             stalled(lot("dead", 25.05, { k: "exact", lo: 10, hi: 10 })),
             lot("live", 25.05, { k: "exact", lo: 10, hi: 10 })],
      probability: (i) => (i === 0 ? null : 0.5),
    });
    expect(out.map((r) => r.id)).toEqual(["live", "dead", "noprob"]);
  });

  it("sorts stalled lots among themselves by cost, like every other group", () => {
    const out = rankLots({
      destination: at, horizonMin: 200,
      lots: [stalled(lot("dead-dear", 25.05, { k: "exact", lo: 90, hi: 90 })),
             stalled(lot("dead-cheap", 25.05, { k: "exact", lo: 10, hi: 10 }))],
      probability: () => 0.5,
    });
    expect(out.map((r) => r.id)).toEqual(["dead-cheap", "dead-dear"]);
  });
});

describe("notUpdating", () => {
  it("is true only for a lot carrying a real last-update stamp", () => {
    // `u` is absent for a live lot, so there is no value to misread -- and the
    // guard matches `format.notUpdatingHours`'s exactly, so the lots demoted
    // in the ranking are the same lots whose cards read "Not updating".
    expect(notUpdating(lot("live", 25.05, { k: "unknown" }))).toBe(false);
    expect(notUpdating(stalled(lot("dead", 25.05, { k: "unknown" })))).toBe(true);
    expect(notUpdating(stalled(lot("nan", 25.05, { k: "unknown" }), Number.NaN))).toBe(false);
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
 * `CIRCLING_PENALTY_MIN * DELAY_VALUE`, NT$60 at the shipped constants, which is
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
    // circling penalty, the drive over to the far lot AND its cost, having
    // gained nothing.
    const km = haversineMeters({ lat: 25.05, lon: 121.52 }, { lat: 25.0596, lon: 121.52 }) / 1000;
    expect(flip.cost).toBeCloseTo(
      0.5 * (flip.walkMin * WALK_VALUE + 60) +
        0.5 * (CIRCLING_PENALTY_MIN * DELAY_VALUE + DRIVE_MIN_PER_KM * DELAY_VALUE * km + far.cost!),
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
    expect(out[0]!.cost).toBeCloseTo(out[0]!.walkMin * WALK_VALUE + 45 * EXPECTED_HOURS, 6);
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

/**
 * The drive a failure forces.
 *
 * Until 2026-09-14 the failure branch charged circling plus the fallback's cost,
 * and nothing for getting from the car park that turned you away to the one you
 * fall back to. As `p` falls towards zero a lot's own position then stops
 * mattering: every hopeless car park in the city scored about the same, cheaper
 * than a certain space a kilometre out, and they filled the tail of the list
 * from kilometres away. On the 09:43 grid, 797 of 1,090 destinations had a lot
 * under 50% more than 1.5 km away in their top 20.
 */
describe("rankLots: the drive a failure forces", () => {
  const priced = (n: number) => ({ k: "exact", lo: n, hi: n });
  /** The latitude `km` kilometres north of the destination, on its meridian. */
  const north = (km: number) => at.lat + km / 111.195;

  it("does not let a hopeless lot across the city outrank a sure space nearer", () => {
    // The Shilin case in miniature: a lot at 2% 5.9 km away ranked above lots
    // certain to have a space 1.2-1.7 km away. Without the drive it scored
    // circling plus the fallback, NT$146, against NT$160 for the sure lot.
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("fallback", north(0.3), priced(30)),
             lot("hopeless-far", north(5.9), priced(30)),
             lot("sure-nearer", north(1.55), priced(30))],
      probability: (i) => (i === 1 ? 0.02 : 1),
    });
    expect(out.map((r) => r.id)).toEqual(["fallback", "sure-nearer", "hopeless-far"]);
  });

  it("measures that drive from the lot that failed to the lot it falls back to", () => {
    // Two lots equally far from the destination, equally priced and equally
    // unlikely, on opposite sides of it. One is beside the car park a driver
    // would go on to; failing at the other means driving back across town.
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("wrong-side", north(-0.8), priced(30)),
             lot("beside-fallback", north(0.8), priced(30)),
             lot("fallback", north(1.0), priced(30))],
      probability: (i) => (i === 2 ? 1 : 0.3),
    });
    const order = out.map((r) => r.id);
    expect(order.indexOf("beside-fallback")).toBeLessThan(order.indexOf("wrong-side"));
  });

  it("charges the fallback lot nothing for driving to itself", () => {
    // A roster of one: the lot is its own fallback, and a failure there costs
    // circling and a second try, not a drive of zero kilometres priced as more.
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("only", north(1.0), priced(30))],
      probability: () => 0.95,
    });
    const only = out[0]!;
    const certain = only.walkMin * WALK_VALUE + 30 * EXPECTED_HOURS;
    const fallback = certain + (1 - 0.95) * CIRCLING_PENALTY_MIN * DELAY_VALUE;
    expect(only.cost).toBeCloseTo(
      0.95 * certain + (1 - 0.95) * (CIRCLING_PENALTY_MIN * DELAY_VALUE + fallback),
      6,
    );
  });
});

/**
 * `WALK_VALUE` and `DELAY_VALUE` price different things -- the whole point of
 * splitting them out of what used to be one constant, `TIME_VALUE`, is that a
 * later preference can move one without moving the other.
 *
 * Every other test in this file, and `rank.ts` itself, ships both constants
 * at 5. That is deliberate -- the split must not change today's ranking --
 * but it also means no test that only reads the shipped values can tell
 * `WALK_VALUE` and `DELAY_VALUE` apart: 5 and 5 produce the same arithmetic
 * regardless of which name prices which term, so a bug that swapped them
 * (the walk term charged at `DELAY_VALUE`, the failure branch at
 * `WALK_VALUE`) would still pass every assertion elsewhere in this file.
 *
 * The only way to actually catch that is to run the real formula with the
 * two constants pulled apart. This loads a byte-patched copy of `rank.ts` --
 * identical except that `WALK_VALUE` and `DELAY_VALUE` are declared with two
 * different numbers -- and checks that the walk term tracks the first and
 * the failure branch tracks the second, and that neither term matches what
 * the *other* constant would have produced.
 */
describe("rankLots: WALK_VALUE and DELAY_VALUE price independently", () => {
  it("charges the walk term at WALK_VALUE and the failure branch at DELAY_VALUE, not swapped", async () => {
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(testsDir, "../src/rank.ts");
    const source = readFileSync(srcPath, "utf8");

    // Distinct, easy-to-tell-apart values -- nothing here matches the
    // shipped 5, so any arithmetic that reads the wrong constant lands on a
    // visibly wrong number instead of coincidentally the right one.
    const WALK_VALUE_TEST = 3;
    const DELAY_VALUE_TEST = 11;

    const patchDeclaration = (text: string, name: string, value: number): string => {
      const re = new RegExp(`export const ${name} = \\d+(?:\\.\\d+)?;`);
      if (!re.test(text)) {
        throw new Error(
          `fixture is stale: "export const ${name} = <number>;" not found in rank.ts`,
        );
      }
      return text.replace(re, `export const ${name} = ${value};`);
    };

    let patched = patchDeclaration(source, "WALK_VALUE", WALK_VALUE_TEST);
    patched = patchDeclaration(patched, "DELAY_VALUE", DELAY_VALUE_TEST);
    // The copy lives one directory further from `src/geo` and `src/types`
    // than the original does.
    patched = patched
      .replace('from "./geo"', 'from "../src/geo"')
      .replace('from "./types"', 'from "../src/types"');

    const genDir = join(testsDir, "../.dev-artifacts");
    mkdirSync(genDir, { recursive: true });
    const genPath = join(genDir, "rank.swap-check.generated.ts");
    writeFileSync(genPath, patched, "utf8");

    try {
      // A cache-busting query so a second run of this test (or a watch
      // rebuild) does not get served a stale module from Vite's cache.
      const variant = (await import(
        /* @vite-ignore */ `../.dev-artifacts/rank.swap-check.generated.ts?t=${Date.now()}`
      )) as { rankLots: typeof rankLots };

      const destination = { lat: 25.05, lon: 121.52 };
      // Close enough to have a short, unambiguous walk; far enough apart
      // from each other that the drive between them is not a rounding error.
      const reliablePos = { lat: destination.lat + 0.002, lon: destination.lon };
      const failingPos = { lat: destination.lat + 0.02, lon: destination.lon };

      const lots = [
        {
          i: 0, id: "reliable", n: "reliable", a: "中正區",
          y: reliablePos.lat, x: reliablePos.lon, c: 50, t: "民營停車場",
          p: { k: "exact", lo: 40, hi: 40 },
        },
        {
          i: 1, id: "failing", n: "failing", a: "中正區",
          y: failingPos.lat, x: failingPos.lon, c: 50, t: "民營停車場",
          p: { k: "exact", lo: 40, hi: 40 },
        },
      ] as never;

      const out = variant.rankLots({
        destination,
        horizonMin: 15,
        // A certain space (p = 1, so it is also the only reliable lot and
        // therefore the ranking's one fallback) and a certain failure (p = 0,
        // so its own walk and fare are weighted away entirely).
        lots,
        probability: (i) => (i === 0 ? 1 : 0),
      });

      const reliableRow = out.find((r) => r.id === "reliable")!;
      const failingRow = out.find((r) => r.id === "failing")!;
      expect(reliableRow.cost).not.toBeNull();
      expect(failingRow.cost).not.toBeNull();
      expect(reliableRow.hourly).not.toBeNull();

      // p = 1 removes the failure branch entirely, so `reliable`'s cost is
      // exactly the walk term: walkMin * WALK_VALUE_TEST + fee. Computed from
      // the row's own reported `walkMin`/`hourly` rather than from `.cost`
      // itself, so this check cannot be fooled by a bug in the same formula.
      const reliableCertain =
        reliableRow.walkMin * WALK_VALUE_TEST + reliableRow.hourly! * EXPECTED_HOURS;
      expect(reliableRow.cost).toBeCloseTo(reliableCertain, 6);
      // Discriminating half: had the walk term instead read DELAY_VALUE, this
      // wrong-constant reading is what it would have produced.
      const reliableCertainIfSwapped =
        reliableRow.walkMin * DELAY_VALUE_TEST + reliableRow.hourly! * EXPECTED_HOURS;
      expect(reliableRow.cost).not.toBeCloseTo(reliableCertainIfSwapped, 6);

      // p = 0 removes `failing`'s own walk and fare from its score entirely,
      // leaving only the failure branch: circling and the drive to the
      // fallback, both at DELAY_VALUE_TEST, plus the fallback's own (already
      // independently checked) cost.
      const km = haversineMeters(failingPos, reliablePos) / 1000;
      const expectedFailing =
        DELAY_VALUE_TEST * (CIRCLING_PENALTY_MIN + DRIVE_MIN_PER_KM * km) + reliableCertain;
      expect(failingRow.cost).toBeCloseTo(expectedFailing, 6);
      // Discriminating half: had the failure branch instead read WALK_VALUE,
      // this wrong-constant reading is what it would have produced.
      const expectedFailingIfSwapped =
        WALK_VALUE_TEST * (CIRCLING_PENALTY_MIN + DRIVE_MIN_PER_KM * km) + reliableCertain;
      expect(failingRow.cost).not.toBeCloseTo(expectedFailingIfSwapped, 6);
    } finally {
      rmSync(genPath, { force: true });
    }
  });
});

/**
 * The three preferences, and the floor that keeps them safe.
 *
 * A preference is not a new formula: it is a different price for a minute of
 * walking, which is a number the cost model already had. What is not obvious --
 * and what these tests pin -- is the second half of the rule,
 * `DELAY_VALUE = max(5, WALK_VALUE)`. Both halves overturned a simpler design
 * when they were measured against the live 1,090-lot roster (spec section 5):
 *
 *   - **Pinning `DELAY_VALUE` at 5** makes *Closer* unsafe: 35 availability
 *     inversions against Balanced's 11, the worst reaching position #2, because
 *     raising the price of walking penalises the **far** lot -- which is the
 *     reliable one -- while the risky lot sits at the destination paying nothing.
 *   - **Coupling the two symmetrically** repairs Closer and breaks *Cheaper*: 19
 *     inversions where pinning gave 0, because a delay priced at NT$2 a minute
 *     makes being turned away cost almost nothing.
 *
 * So the failure branch's price is checked here as carefully as the walk's, and
 * each arithmetic assertion carries a paired `.not` against exactly what the
 * overturned design would have produced.
 */
describe("rankLots: the three preferences", () => {
  const priced = (n: number) => ({ k: "exact", lo: n, hi: n });
  const lotAt = (id: string, lat: number, lon: number, hourly: number) =>
    ({ i: 0, id, n: id, a: "中正區", y: lat, x: lon, c: 50, t: "民營停車場", p: priced(hourly) }) as never;
  /** The latitude `km` kilometres north of the destination, on its meridian. */
  const north = (km: number) => at.lat + km / 111.195;

  it("prices the delay at the walk's value only when that is the higher of the two", () => {
    // DELAY_VALUE = max(5, WALK_VALUE). Never below 5, so a preference cannot
    // make being turned away cheap; above it when walking is dear, so making the
    // walk expensive does not relatively cheapen failure. Both halves were
    // measured: pinning breaks Closer, symmetric coupling breaks Cheaper.
    expect(PREFERENCES.cheaper).toEqual({ walk: 2, delay: 5 });
    expect(PREFERENCES.balanced).toEqual({ walk: 5, delay: 5 });
    expect(PREFERENCES.closer).toEqual({ walk: 12, delay: 12 });
    // Balanced *is* the shipped pair, which is what makes the regression below
    // possible at all: it is not merely equal to 5/5 by coincidence.
    expect(PREFERENCES.balanced).toEqual({ walk: WALK_VALUE, delay: DELAY_VALUE });
  });

  /**
   * A roster wide enough that a change of order would show: 40 car parks spread
   * over ~2.7 km and NT$10-66 an hour, at a spread of probabilities, with every
   * seventh carrying no forecast at all. Deterministic -- index arithmetic, not
   * a random seed -- so a failure is the same failure on every machine.
   */
  const roster = Array.from({ length: 40 }, (_unused, k) =>
    lotAt(`lot-${k}`, north(((k * 37) % 40) * 0.07), 121.52 + ((k * 19) % 40) * 0.0004, 10 + ((k * 13) % 9) * 7),
  );
  const rosterInput = {
    destination: at,
    horizonMin: 15,
    lots: roster,
    probability: (i: number) => (i % 7 === 3 ? null : ((i * 17) % 100) / 100),
  };

  it("ranks identically to the shipped constants when balanced", () => {
    // The regression that matters most: a driver who never opens the control
    // must see no change whatsoever. Compared against the un-preferenced call,
    // so it also pins the default.
    expect(rankLots({ ...rosterInput, preference: "balanced" })).toEqual(rankLots(rosterInput));
  });

  it("on a roster the other two presets do reorder, so that equality means something", () => {
    // Without this, the test above would pass just as happily on a fixture no
    // preference could ever reorder -- three lots in a line, say -- and would be
    // proving nothing about Balanced.
    const balanced = rankLots(rosterInput).map((r) => r.id);
    expect(rankLots({ ...rosterInput, preference: "cheaper" }).map((r) => r.id)).not.toEqual(balanced);
    expect(rankLots({ ...rosterInput, preference: "closer" }).map((r) => r.id)).not.toEqual(balanced);
  });

  it("gives three different orders for the same three car parks", () => {
    // All three are certain to have a space, so each score is exactly its walk
    // term and the arithmetic is visible:
    //
    //            walk   fare   cheaper (2)   balanced (5)   closer (12)
    //   door      0 min   120          120            120           120
    //   middling  8 min    70           86            110           166
    //   far      20 min    25           65            125           265
    //
    // Three presets, three different orders, and every pair separated by at
    // least NT$5 -- so this fails on a real change of behaviour, not on rounding.
    const lots = [
      lotAt("at-the-door", at.lat, 121.52, 60),
      lotAt("middling", north(0.6), 121.52, 35),
      lotAt("far-and-cheap", north(1.56), 121.52, 12.5),
    ] as never;
    const order = (preference: Preference) =>
      rankLots({ destination: at, horizonMin: 15, lots, preference, probability: () => 1 }).map((r) => r.id);

    expect(order("cheaper")).toEqual(["far-and-cheap", "middling", "at-the-door"]);
    expect(order("balanced")).toEqual(["middling", "at-the-door", "far-and-cheap"]);
    expect(order("closer")).toEqual(["at-the-door", "middling", "far-and-cheap"]);
  });

  it("charges the walk at the preset's price and the failure branch at its delay price", () => {
    // Two lots: one certain (p = 1, so its cost is exactly the walk term, and it
    // is also the ranking's only reliable fallback) and one certain to fail
    // (p = 0, so its own walk and fare weigh nothing and its cost is exactly the
    // failure branch). That separates the two prices completely.
    const reliableAt = { lat: north(0.2), lon: 121.52 };
    const failingAt = { lat: north(2), lon: 121.52 };
    const lots = [
      lotAt("reliable", reliableAt.lat, reliableAt.lon, 40),
      lotAt("failing", failingAt.lat, failingAt.lon, 40),
    ] as never;
    const km = haversineMeters(failingAt, reliableAt) / 1000;

    // The second number is the delay price the design this preset overturned
    // would have used: symmetric coupling for Cheaper, pinning for Closer.
    const cases = [
      { preference: "cheaper", overturnedDelay: 2 },
      { preference: "closer", overturnedDelay: 5 },
    ] as const;

    for (const { preference, overturnedDelay } of cases) {
      const values = PREFERENCES[preference];
      const out = rankLots({
        destination: at, horizonMin: 15, lots, preference,
        probability: (i) => (i === 0 ? 1 : 0),
      });
      const reliable = out.find((r) => r.id === "reliable")!;
      const failing = out.find((r) => r.id === "failing")!;
      expect(reliable.hourly).not.toBeNull();

      // Computed from the row's own reported `walkMin`/`hourly` rather than from
      // `.cost`, so the check cannot be fooled by the formula it is checking.
      const certain = reliable.walkMin * values.walk + reliable.hourly! * EXPECTED_HOURS;
      expect(reliable.cost).toBeCloseTo(certain, 6);
      // Discriminating half: what an inert preference -- one that took the
      // argument and went on using the shipped constant -- would have produced.
      expect(reliable.cost).not.toBeCloseTo(reliable.walkMin * WALK_VALUE + reliable.hourly! * EXPECTED_HOURS, 6);

      const delayed = CIRCLING_PENALTY_MIN + DRIVE_MIN_PER_KM * km;
      expect(failing.cost).toBeCloseTo(values.delay * delayed + certain, 6);
      // Discriminating half: what the overturned design would have charged for
      // being turned away. This is the assertion that holds the floor in place.
      expect(failing.cost).not.toBeCloseTo(overturnedDelay * delayed + certain, 6);
    }
  });

  it("never prices a delay below the shipped DELAY_VALUE, whatever the preset", () => {
    // The invariant in one line: a preference may make walking dearer, and may
    // make being turned away dearer with it, but may never make being turned
    // away cheaper than it is today. That is what stops a preference from
    // quietly eroding the availability signal it is not supposed to touch.
    for (const values of Object.values(PREFERENCES)) {
      expect(values.delay).toBeGreaterThanOrEqual(DELAY_VALUE);
      expect(values.delay).toBe(Math.max(DELAY_VALUE, values.walk));
    }
  });
});
