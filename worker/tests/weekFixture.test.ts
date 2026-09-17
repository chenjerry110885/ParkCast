/**
 * The third edge of the wire-format triangle: the Python encoder against the
 * Worker's reader, over bytes Python actually wrote.
 *
 * `week.bin`'s layout is stated three independent times --
 * `struct.pack("<4sBIHHBI")` in `src/parkcast/artifacts.py`, this Worker's
 * `DataView` offsets in `src/validate.ts`, and the client's in
 * `web/src/week.ts` -- and all three have to agree or the artifact never
 * reaches a driver. Two of those pairs were already pinned by real encoder
 * bytes: `web/tests/seam.test.ts` reads `web/tests/fixtures/seam-week.bin`, and
 * `tests/test_seam_fixture.py` asserts that regenerating it is byte-identical,
 * so it cannot rot.
 *
 * Python <-> Worker was pinned by nothing. Every other file in this directory
 * builds its own blob: `fakes.ts`'s `makeWeek` hand-transcribes `18` and every
 * offset as literals, and `src/validate.ts`'s `WEEK_HEADER_SIZE = 18` is a
 * second hand-copy of the same Python constant -- so the Worker suite was
 * comparing the Worker against itself, and would not have noticed the day the
 * encoder moved.
 *
 * **What that costs, if it ever happens.** Add a pad byte to
 * `WEEK_HEADER_FORMAT` (`"<4sBIHHBI"` -> `"<4sBIHHBxI"`) and regenerate: the
 * header grows to 19 bytes, `validateWeek`'s length check fails, the Worker
 * answers `422`, and `UploadGuard.record` routes a 422 to its back-off branch
 * and retries the identical bytes forever. `week.bin` never lands,
 * `scripts/smoke-live.mjs` only *warns* about a missing one by design, and the
 * feature is silently absent while the collector, the Worker and every test
 * suite look healthy. Fail-safe -- no wrong number ever reaches a driver -- but
 * silent, which is this branch's signature failure shape.
 *
 * So this file reads the fixture that already exists, is already written by the
 * real `artifacts.encode_week`, and is already kept fresh by the Python suite,
 * and drives the Worker's real `validateWeek` / `parseWeekHeader` over those
 * exact bytes. Nothing here constructs a blob, and every expectation below is
 * a value Python chose. Verified by mutation: with the pad byte in place and
 * the fixture regenerated, this file fails and the rest of the Worker suite
 * does not.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WEEK_BUCKETS,
  WEEK_BUCKET_MIN,
  WEEK_HEADER_SIZE,
  WEEK_VERSION,
  checkWeekRoster,
  parseWeekHeader,
  validateWeek,
} from "../src/validate";

// Resolved through `fileURLToPath` rather than `new URL("...", import.meta.url)`:
// Vite rewrites that literal pattern at transform time into an asset URL, which
// would resolve to `http://localhost/...` and never reach the disk. Same reason
// `web/tests/seam.test.ts` spells it this way.
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "web", "tests", "fixtures", "seam-week.bin",
);

/**
 * The fixture's bytes, copied out of Node's read buffer.
 *
 * `readFileSync` can return a view into a shared allocation pool for a small
 * file, so handing `.buffer` straight to a `DataView` would describe the whole
 * pool rather than this file -- and `validateWeek` checks `byteLength` against
 * the header, which would then be measuring the wrong thing. Copying is 2.7 KB.
 */
function seamWeek(): Uint8Array {
  return Uint8Array.from(readFileSync(FIXTURE));
}

/**
 * What `scripts/build-seam-fixture.py` wrote into that header, read back out of
 * the committed file.
 *
 * Every number is Python's, not a restatement of the Worker's own constants:
 * four synthetic lots, `built_ts` at 2026-09-16 04:00 Taipei, and a `roster_id`
 * that is the CRC32 over `SEAM0001..SEAM0004` and lands deliberately above
 * `2 ** 31`, so an accidental signed read shows up as a negative number here
 * rather than waiting for a real roster to cross the boundary in production.
 */
const EXPECTED = {
  version: 1,
  builtTs: 1789502400,
  nLots: 4,
  nBuckets: 336,
  bucketMin: 30,
  rosterId: 2444777626,
} as const;

describe("week.bin, as the Python encoder writes it", () => {
  it("passes the Worker's real validateWeek", () => {
    const result = validateWeek(seamWeek());
    expect(result.ok).toBe(true);
  });

  it("reads every header field at the offset struct.pack put it", () => {
    // A single deep comparison rather than seven assertions: a layout shift
    // moves several fields at once, and the diff then names all of them.
    expect(parseWeekHeader(seamWeek())).toEqual(EXPECTED);
  });

  it("has the body length the Worker's own constants predict", () => {
    // The check `validateWeek` fails on when the header size drifts, spelled
    // out so a failure says which of the two sides moved.
    const week = seamWeek();
    expect(week.byteLength).toBe(WEEK_HEADER_SIZE + EXPECTED.nLots * WEEK_BUCKETS * 2);
    expect(week.byteLength).toBe(2706);
  });

  it("carries the version, bucket count and bucket width the Worker demands", () => {
    // `validateWeek` rejects on any of these, so a fixture that drifted would
    // otherwise fail the first test with no indication of which constant moved.
    const header = parseWeekHeader(seamWeek());
    expect(header?.version).toBe(WEEK_VERSION);
    expect(header?.nBuckets).toBe(WEEK_BUCKETS);
    expect(header?.bucketMin).toBe(WEEK_BUCKET_MIN);
  });

  it("reads roster_id unsigned past the int32 boundary, off real bytes", () => {
    const header = parseWeekHeader(seamWeek());
    expect(header?.rosterId).toBe(EXPECTED.rosterId);
    expect(header?.rosterId).toBeGreaterThan(2 ** 31);
  });

  it("matches a stored pair on its own roster id and nothing else", () => {
    // The roster check driven by an encoder-written id rather than a literal:
    // `roster_id` is the one header field whose value comes out of a hash, so
    // it is the one most likely to be read at the wrong offset and still look
    // plausible.
    const result = validateWeek(seamWeek());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(checkWeekRoster(result.header, EXPECTED.rosterId)).toBeNull();
    expect(checkWeekRoster(result.header, EXPECTED.rosterId + 1)).toBe("roster-mismatch");
    expect(checkWeekRoster(result.header, null)).toBe("no-pair");
  });

  it("stops being valid the moment a byte moves", () => {
    // The negative half, so the tests above cannot pass by accepting anything:
    // one byte inserted into the header is exactly the pad-byte mutation, and
    // `validateWeek` must refuse it rather than reading a plausible table out
    // of shifted bytes.
    const real = seamWeek();
    const padded = new Uint8Array(real.byteLength + 1);
    padded.set(real.subarray(0, WEEK_HEADER_SIZE - 4), 0);
    padded.set(real.subarray(WEEK_HEADER_SIZE - 4), WEEK_HEADER_SIZE - 3);
    expect(validateWeek(padded).ok).toBe(false);
    // ...and truncation, the other way the length can disagree with the header.
    expect(validateWeek(real.subarray(0, real.byteLength - 1)).ok).toBe(false);
  });
});
