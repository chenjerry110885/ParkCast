/// <reference types="node" />
/**
 * The seam: `grid.bin` and `week.bin` must agree where they meet.
 *
 * ParkCast answers "will there be a space when I arrive?" from two different
 * places. Inside +120 min the answer is read straight out of `grid.bin`, a
 * number the server already computed. Past +120 min there is no grid column
 * left, so the client computes its own from the climatology table:
 *
 *     blend(f, probabilityAt(week, lotIndex, t).p, minutesFromReading)
 *
 * At exactly +120 min both are defined. If they disagree, a driver dragging
 * the arrival time across the two-hour mark watches the number jump -- not
 * because anything changed about the parking, but because the app switched
 * sources mid-drag. That is the failure this file exists to prevent.
 *
 * Every byte compared here was written by Python
 * (`scripts/build-seam-fixture.py`, guarded against rot by
 * `tests/test_seam_fixture.py`) through the same `forecast.Blend`,
 * `grid.build_grid`/`artifacts.encode_grid` and
 * `week.build_week_cells`/`artifacts.encode_week` that build the published
 * artifacts. Nothing in this file constructs either blob. A fixture built in
 * TypeScript could only ever prove the client agrees with itself -- the
 * client's arithmetic would sit on both sides of the equals sign, and a
 * client that computes the seam differently from the server is exactly what
 * this test is looking for.
 *
 * It is also the first place this suite reads bytes the Python encoder
 * actually wrote, which makes it the only guard on **cross-language layout
 * agreement**. `week.test.ts` exercises `parseWeek` hard, but against tables
 * its own `makeWeek` helper lays out by hand -- a second, independent
 * statement of the wire format that never consults `artifacts.encode_week`.
 * So a change to the encoder's layout is invisible to it: add a pad byte to
 * `WEEK_HEADER_FORMAT` in `src/parkcast/artifacts.py` (`"<4sBIHHBI"` ->
 * `"<4sBIHHBxI"`) and regenerate the fixtures, and the entire Python suite
 * stays green -- it is comparing the encoder against itself -- and every
 * `week.test.ts` test stays green too, because it is comparing the client
 * against itself. Only this file fails. That gap, not any one constant, is
 * what reading encoder-written bytes closes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { horizonColumn, parseGrid, probabilityAt as gridProbabilityAt } from "../src/artifacts";
import { blend, parseWeek, probabilityAt as weekProbabilityAt } from "../src/week";

// Resolved through `fileURLToPath` rather than `new URL("...", import.meta.url)`:
// Vite rewrites that literal pattern at transform time into an asset URL, which
// here would resolve to `http://localhost/...` and never reach the disk. Same
// pattern `tests/week.test.ts` and `tests/icons.test.ts` use.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * One fixture file as its own `ArrayBuffer`.
 *
 * The bytes are copied rather than handed over as `buffer.buffer`: for small
 * files `readFileSync` returns a view into Node's shared allocation pool, so
 * that property is the whole pool, not this file. `parseGrid` and `parseWeek`
 * both validate `byteLength` against the header, and would see a wildly wrong
 * length -- or, worse, a plausible one holding another file's bytes.
 */
function readFixture(name: string): ArrayBuffer {
  const bytes = readFileSync(join(FIXTURES, name));
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Only what is needed to *index* the two blobs. Deliberately no expected
 * probability and no bucket number: every value this file compares has to
 * come back out of the encoder's bytes, or the test would be checking the
 * generator's arithmetic against itself.
 */
const seam: { lot_index: number; lot_id: string; f: number; base_data_ts: number } = JSON.parse(
  readFileSync(join(FIXTURES, "seam.json"), "utf8"),
);

const grid = parseGrid(readFixture("seam-grid.bin"));
const week = parseWeek(readFixture("seam-week.bin"));

/** The horizon the seam sits at: the grid's last column, and the first arrival the week table has to answer for. */
const HORIZON_MIN = 120;

/**
 * The whole permitted disagreement, in percentage points, and it is
 * *arithmetic* rather than slack. Both sides compute
 * `weight * persistence + (1 - weight) * climatology` from identical inputs;
 * the only thing that can separate them is that each side stores a rounded
 * byte at a different point in that expression:
 *
 *   - the grid rounds the finished blend once      -> <= 0.5      pp
 *   - the week cell rounds the climatology first,
 *     and the client then scales that error by
 *     `1 - weight` = 0.9375, since
 *     `weight = 0.5 ** (120/30)` = 0.0625:
 *     `0.5 * 0.9375`                               -> <= 0.46875  pp
 *                                                     ---------
 * so nothing honest can exceed                        0.96875  pp,
 *
 * which leaves **0.03125 pp of headroom** under this gate -- about a
 * thirtieth of it. That is the whole reason the breakdown is written out
 * here: any extra rounding introduced anywhere in the client's path has more
 * than enough room to break this test legitimately.
 *
 * Do NOT widen this to make a failure go away. At this horizon a wrong
 * `weight`, a wrong bucket, a wrong row, or a swapped cell byte all land 10
 * to 42 pp outside it, nowhere near the boundary -- a failure a percentage
 * point or two out is a real bug in the arithmetic, not a tolerance that
 * needs air. The fix is in the code, not here.
 */
const TOLERANCE_PP = 1;

describe("the grid/week seam at +120 min", () => {
  it("indexes one roster across both artifacts", () => {
    // If the two files described different lot orderings, every assertion
    // below would be comparing one lot's grid row against another lot's
    // climatology -- plausibly, and wrongly. `rosterId` is the CRC32 of the
    // ordered ids both encoders derive from the rows they actually wrote.
    expect(week.rosterId).toBe(grid.rosterId);
    expect(week.nLots).toBe(grid.nLots);
    expect(seam.lot_index).toBeGreaterThanOrEqual(0);
    expect(seam.lot_index).toBeLessThan(grid.nLots);
    // The horizon is measured from the reading, never from `Date.now()`, so
    // the fixture's `base_data_ts` has to be the grid's own.
    expect(grid.baseDataTs).toBe(seam.base_data_ts);
  });

  it("puts +120 min in the grid's final column", () => {
    // The premise of the whole file: the last column IS the seam. If the grid
    // geometry ever changed (more columns, a different step), this test's
    // arrival time would silently stop being the boundary.
    expect(grid.stepMin * grid.nHorizons).toBe(HORIZON_MIN);
    // Asserted as an INDEX, and it has to be. By +115 min the persistence
    // weight has decayed to 0.0625 and the blend has converged, so the last
    // two columns hold the same byte for every lot in this fixture (17|17,
    // 79|79, 37|37, 47|47). Any check that compares what the client's grid
    // accessor *returns* against the last column's value is therefore blind
    // to an off-by-one in the column index: `horizonColumn`'s `- 1` becoming
    // `- 2` reads column 22 and agrees to 0.0 pp. No choice of fixture lot
    // fixes that -- the blind spot is the convergence, not the sampling --
    // so the index is what gets asserted.
    expect(horizonColumn(grid, HORIZON_MIN)).toBe(grid.nHorizons - 1);
  });

  it("has a real climatology in the fixture lot's arrival bucket", () => {
    // There is one legitimate divergence at this seam that is NOT what this
    // file measures: when the server's climatology has no answer but the live
    // reading does, `Blend` returns pure persistence and the grid stores 0 or
    // 100, while the week cell stores 255 and the client honestly renders "no
    // data". That is intended, in the honest direction. Asserting the cell
    // here means the seam test can never quietly degenerate into passing
    // because both sides had nothing to say.
    const cell = weekProbabilityAt(week, seam.lot_index, seam.base_data_ts + HORIZON_MIN * 60);
    expect(cell.p).not.toBeNull();
    // Observations of this lot in this bucket specifically -- so the
    // probability is a real time-of-week rate, not the lot or citywide tier
    // showing through an empty bucket.
    expect(cell.support).toBeGreaterThan(0);
    expect(gridProbabilityAt(grid, seam.lot_index, HORIZON_MIN)).not.toBeNull();
  });

  it("computes the same number the grid's last column already holds", () => {
    const lastColumn = grid.cells[(seam.lot_index + 1) * grid.nHorizons - 1]!;
    // A value cross-check only: that the client's grid accessor hands back
    // this byte as a probability without mangling it. Whether it landed on
    // the right COLUMN is settled by the `horizonColumn` assertion above,
    // which this comparison cannot see -- the last two columns are the same
    // byte. The raw byte, not the accessor's float, is what the seam is
    // measured against below, so no round-trip creeps into the comparison.
    expect(gridProbabilityAt(grid, seam.lot_index, HORIZON_MIN)).toBeCloseTo(lastColumn / 100, 10);

    const cell = weekProbabilityAt(week, seam.lot_index, seam.base_data_ts + HORIZON_MIN * 60);
    const client = blend(seam.f, cell.p!, HORIZON_MIN) * 100;

    expect(
      Math.abs(client - lastColumn),
      `week path says ${client} pp, grid's last column says ${lastColumn} pp`,
    ).toBeLessThanOrEqual(TOLERANCE_PP);
  });

  it("would miss by far more than the tolerance if it bucketed on the reading instead of the arrival", () => {
    // Proof that the assertion above has teeth. The fixture lot's history is
    // built so its 19:2x bucket and its 21:2x bucket disagree sharply, so a
    // client that reused the reading's own time of week -- the easiest way to
    // get `probabilityAt`'s `ts` wrong, and one that passes every test that
    // only checks a single bucket -- is tens of points out, not fractions.
    const lastColumn = grid.cells[(seam.lot_index + 1) * grid.nHorizons - 1]!;
    const readingsBucket = weekProbabilityAt(week, seam.lot_index, seam.base_data_ts);
    const wrong = blend(seam.f, readingsBucket.p!, HORIZON_MIN) * 100;
    expect(Math.abs(wrong - lastColumn)).toBeGreaterThan(TOLERANCE_PP * 10);
  });
});
