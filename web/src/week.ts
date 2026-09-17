/**
 * Read `week.bin`, the per-lot x half-hour-of-week climatology table, and
 * blend it with a live reading to answer questions past `grid.bin`'s
 * +120 min horizon.
 *
 * The binary layout is fixed by `src/parkcast/artifacts.py`'s
 * `WEEK_HEADER_FORMAT = "<4sBIHHBI"` -- little-endian, no alignment padding --
 * so the offsets below are byte-identical to little-endian `DataView` reads.
 * This module mirrors `./artifacts.ts`'s `parseGrid` discipline throughout:
 * validate the header against the body it came with, and throw rather than
 * hand back something half-trusted.
 */
import type { WeekTable } from "./types";

/** `magic(4) version(1) builtTs(4) nLots(2) nBuckets(2) bucketMin(1) rosterId(4)`. */
export const HEADER_SIZE = 18;

/** The schema version this client knows how to read. Shared with `grid.bin`. */
export const VERSION = 1;

const MAGIC = "PCW1";

/**
 * Buckets covering a full week at `BUCKET_MIN`-minute width: `7 * 24 * 60 / 30`,
 * matching `config.WEEK_BUCKETS`. `weekBucket` and `probabilityAt` hard-code
 * this shape rather than reading it back out of a parsed `WeekTable` on every
 * call -- `parseWeek` is what makes hard-coding it safe, by refusing to parse
 * a header that declares anything else.
 */
const N_BUCKETS = (7 * 24 * 60) / 30;

/** Minutes per bucket, matching `config.CLIMATOLOGY_BUCKET_MIN`. */
const BUCKET_MIN = 30;

/**
 * No observation for this lot in this bucket.
 *
 * Emphatically *not* zero, exactly as `./artifacts.ts`'s `UNKNOWN` is not zero
 * for the grid: zero is a claim -- "reliably full at this hour" -- and this is
 * the absence of one. `probabilityAt` returns `null` here and never a number.
 */
export const WEEK_UNKNOWN = 255;

/**
 * How fast a live reading's influence decays toward climatology as the
 * horizon grows, in minutes: the reading's weight halves every this many
 * minutes. Matches `config.BLEND_HALF_LIFE_MIN`, which `Blend.predict` in
 * `src/parkcast/forecast.py` uses for the same formula server-side.
 */
export const BLEND_HALF_LIFE_MIN = 30;

/**
 * Parse `week.bin`, validating that the header describes the body it came
 * with -- see `parseGrid` in `./artifacts.ts` for why this matters: a
 * truncated download and a full one are otherwise indistinguishable, and a
 * half-trusted table indexed against the wrong roster would attach every
 * lot's forecast to the wrong lot, silently and plausibly.
 */
export function parseWeek(buf: ArrayBuffer): WeekTable {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error(`week.bin is ${buf.byteLength} bytes, shorter than its ${HEADER_SIZE}-byte header`);
  }
  const dv = new DataView(buf);
  const magic = new TextDecoder("ascii").decode(new Uint8Array(buf, 0, 4));
  if (magic !== MAGIC) {
    throw new Error(`week.bin has magic ${JSON.stringify(magic)}, expected ${MAGIC}`);
  }
  const version = dv.getUint8(4);
  if (version !== VERSION) {
    throw new Error(`week.bin is schema version ${version}, this client reads ${VERSION}`);
  }

  const builtTs = dv.getUint32(5, true);
  const nLots = dv.getUint16(9, true);
  const nBuckets = dv.getUint16(11, true);
  const bucketMin = dv.getUint8(13);
  // roster_id is an unsigned 32-bit value; getUint32 (not a bitwise op, which
  // would return it signed) keeps it that way.
  const rosterId = dv.getUint32(14, true);

  // weekBucket and probabilityAt both hard-code this shape (N_BUCKETS above);
  // a header declaring a different one would silently misalign every lookup
  // rather than fail loudly, so it is refused here instead.
  if (nBuckets !== N_BUCKETS || bucketMin !== BUCKET_MIN) {
    throw new Error(
      `week.bin declares ${nBuckets} buckets at ${bucketMin} min, this client reads ${N_BUCKETS} at ${BUCKET_MIN} min`,
    );
  }

  const expected = nLots * N_BUCKETS * 2;
  const body = buf.byteLength - HEADER_SIZE;
  if (body !== expected) {
    throw new Error(
      `week.bin body is ${body} bytes, header declares ${nLots} lots x ${N_BUCKETS} buckets x 2 = ${expected}`,
    );
  }

  return {
    nLots,
    rosterId,
    builtTs,
    cells: new Uint8Array(buf, HEADER_SIZE, expected),
  };
}

/**
 * Index of the Taipei time-of-week bucket containing `ts`, 0..335.
 *
 * Must agree exactly with `forecast.week_bucket` in `src/parkcast/forecast.py`:
 *
 *     local_min = (ts + 8*3600) // 60
 *     bucket    = (local_min // 30) % 336
 *
 * That function anchors on the bare Unix epoch and does no calendar
 * arithmetic. 1970-01-01 was a **Thursday**, so **bucket 0 is Thursday 00:00
 * Taipei, not Monday** -- an earlier draft of this plan asserted a
 * Monday-anchored table, which would have disagreed with Python by 192
 * buckets (four days) while still passing a test written to match it.
 *
 * Python's `//` floors, including for negative operands (needed because
 * bucket 0's own representative timestamp, ~-28800, is negative); JS's
 * `Math.trunc` / `|0` truncate toward zero instead, which gives the wrong
 * bucket for every negative `ts`. `Math.floor` is used here for exactly that
 * reason, on both divisions, with a final normalisation so the result is
 * never negative even when the intermediate `% 336` is (JS `%` keeps the
 * sign of its left operand; Python's does not).
 */
export function weekBucket(ts: number): number {
  const localMin = Math.floor((ts + 8 * 3600) / 60);
  const raw = Math.floor(localMin / BUCKET_MIN) % N_BUCKETS;
  return raw < 0 ? raw + N_BUCKETS : raw;
}

/**
 * The climatology probability and support for one lot at the time-of-week
 * `ts` falls in.
 *
 * `p` is `null` when the bucket has no observation for this lot -- see
 * `WEEK_UNKNOWN` -- and a real number (including `0`) otherwise. `support` is
 * the raw observation count behind that bucket, capped at 255 by the encoder;
 * it is `0` whether or not `p` is `null`, since an unshrunk bucket still
 * falls back through the lot and citywide tiers and can carry a probability
 * with zero of its own support.
 */
export function probabilityAt(
  table: WeekTable,
  lotIndex: number,
  ts: number,
): { p: number | null; support: number } {
  if (!Number.isInteger(lotIndex) || lotIndex < 0 || lotIndex >= table.nLots) {
    throw new RangeError(`lot index ${lotIndex} is outside 0..${table.nLots - 1}`);
  }
  const bucket = weekBucket(ts);
  const offset = (lotIndex * N_BUCKETS + bucket) * 2;
  const percent = table.cells[offset]!;
  const support = table.cells[offset + 1]!;
  return { p: percent === WEEK_UNKNOWN ? null : percent / 100, support };
}

/**
 * Blend a live reading toward climatology as the horizon grows, matching
 * `Blend.predict` in `src/parkcast/forecast.py`:
 *
 *     weight = 0.5 ** (minutesFromReading / BLEND_HALF_LIFE_MIN)
 *     p      = weight * (observedFree >= 1 ? 1 : 0) + (1 - weight) * climatologyP
 *
 * `minutesFromReading` must be measured from the shard's `base_data_ts` --
 * the reading -- never from `Date.now()`. The server's horizon is measured
 * from `history.latest_ts`, which is exactly what `base_data_ts` carries;
 * measuring from the wall clock would pass every unit test here and still be
 * wrong in the field by however long ago the last reading was.
 *
 * `observedFree === null` means no live reading exists for this lot at all
 * (as opposed to a reading of `0`, a genuinely full lot) -- there is nothing
 * for the reading term to contribute, so this falls back to climatology
 * alone, exactly as `Blend.predict` returns `far` outright when its own
 * `near` is `None`.
 */
export function blend(observedFree: number | null, climatologyP: number, minutesFromReading: number): number {
  if (observedFree === null) return climatologyP;
  const weight = Math.pow(0.5, minutesFromReading / BLEND_HALF_LIFE_MIN);
  const near = observedFree >= 1 ? 1 : 0;
  return weight * near + (1 - weight) * climatologyP;
}
