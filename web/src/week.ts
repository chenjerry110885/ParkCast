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
 * No probability at all for this cell -- the encoder was handed `None`.
 *
 * Emphatically *not* zero, exactly as `./artifacts.ts`'s `UNKNOWN` is not zero
 * for the grid: zero is a claim -- "reliably full at this hour" -- and this is
 * the absence of one. `probabilityAt` returns `null` here and never a number.
 *
 * **This is a defensive path, not the routine one, and it does not mean "we
 * have never watched this lot at this hour."** No `week.bin` the collector
 * publishes today can contain a 255 anywhere: `Climatology.predict`
 * (`src/parkcast/forecast.py`) returns `None` only when the city's corpus is
 * empty *in total* -- `counts.glob[1] == 0` -- and `scheduler.publish_city`
 * returns before building anything unless at least one lot has been observed.
 * The sentinel is therefore all-or-nothing across a whole artifact, and the
 * "all" case is unreachable through the publish path.
 *
 * A lot-hour nobody has watched ships as a **real number** instead: the
 * shrinkage chain falls back bucket -> lot -> citywide Jeffreys rate, so the
 * cell carries the citywide figure with `support = 0`. The ignorance is
 * carried by the **support byte**, which `confidence.ts` grades
 * `{level: "low", reason: "thin"}` -- "we have not watched this lot at this
 * time of week often enough yet" -- never by the probability byte. See
 * `build_week_cells` in `src/parkcast/week.py`, which states the same thing
 * from the encoder's side.
 *
 * The handling stays regardless, and so do the tests that pin it: 255 is a
 * real capability of the format that a future encoder could legitimately
 * emit -- a city on its first day, with nothing observed anywhere -- and a
 * decoder that stopped special-casing it would render that cell as 255%.
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
      `week.bin declares ${nBuckets} buckets at ${bucketMin} min, this client reads ${N_BUCKETS} at ${BUCKET_MIN} min -- ` +
        `this file was built by a different version of the encoder than this client understands; rebuild week.bin ` +
        `with a matching encoder, or update this client to the bucket geometry it now writes.`,
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
 * `p` is `null` only when the cell holds `WEEK_UNKNOWN`, and a real number
 * (including `0`) otherwise. A bucket nobody has watched is **not** one of
 * those nulls -- it reads the citywide fallback with `support = 0`, and no
 * published table contains a 255 at all; see `WEEK_UNKNOWN` for why that path
 * is defensive rather than routine. `support` is the raw observation count
 * behind that bucket, capped at 255 by the encoder, and a `0` there beside a
 * perfectly real `p` is the *normal* shape of an unwatched cell, not a
 * contradiction: an empty bucket still falls back through the lot and citywide
 * tiers. It is `support`, not `p`, that says how much we actually know here.
 *
 * `ts` is validated for the same reason `lotIndex` is: `weekBucket` does no
 * range-checking of its own and happily turns a non-finite `ts` into a
 * non-finite bucket, which the lookup below would then read as `cells[NaN]`
 * -- `undefined`, not a thrown error -- and hand back a `NaN` `p`. `typeof
 * NaN === "number"`, so that `NaN` would clear every "is this a real
 * probability" check a caller writes and reach a driver as a confident
 * forecast, exactly the failure `WEEK_UNKNOWN` exists to prevent. `ts` is not
 * reachable from anywhere in this app yet, but the time picker that will
 * drive it reads an HTML `<select>`, and a malformed or empty selection is
 * precisely how a `NaN` timestamp would arrive here. Throwing catches that
 * at the seam instead of laundering it into a plausible-looking number.
 */
export function probabilityAt(
  table: WeekTable,
  lotIndex: number,
  ts: number,
): { p: number | null; support: number } {
  if (!Number.isInteger(lotIndex) || lotIndex < 0 || lotIndex >= table.nLots) {
    throw new RangeError(`lot index ${lotIndex} is outside 0..${table.nLots - 1}`);
  }
  if (!Number.isFinite(ts)) {
    throw new RangeError(`ts ${ts} is not a finite timestamp`);
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
 *
 * `climatologyP`, by contrast, is a plain `number` -- this signature has no
 * way to say "no climatology either." `probabilityAt` can return `p: null`
 * for a `WEEK_UNKNOWN` cell, and `App.tsx`'s `probabilityForLot` has no cell
 * to read at all when the table is absent or the lot sits off the end of its
 * roster; a caller sitting at that seam must resolve the `null` *before*
 * reaching this function, never
 * by passing it through as `p ?? 0`. Zero is a claim -- "reliably full at
 * this hour" -- and coercing an absence of history into that claim is the
 * same honesty violation `WEEK_UNKNOWN` exists to prevent, just moved one
 * function over. Python's `Blend.predict` can express the symmetric case
 * directly: when its `far` (climatology) is `None`, it returns `near`
 * (persistence) outright, with no blending at all. `blend`'s signature
 * cannot represent "climatology unavailable" as an input, so that fallback
 * is the caller's to implement -- resolve to persistence alone (or to no
 * prediction, if `observedFree` is unavailable too) before ever calling
 * `blend`, rather than inventing a climatology figure to hand it.
 *
 * `minutesFromReading` is clamped to `0` here, which is a deliberate
 * divergence from `Blend.predict`: the server only ever calls it with a
 * horizon from `grid.horizons()`, a fixed schedule of positive step
 * multiples, so a negative horizon never reaches the Python side and it does
 * not guard against one. This client's caller is a user-driven time picker,
 * which can legitimately be pointed at a moment before the reading it is
 * blending against. Left unclamped, a negative `minutesFromReading` drives
 * `weight` above `1` (`blend(5, 0.2, -60)` returns `3.4`), a "probability"
 * greater than one that is exactly the kind of dishonest number this module
 * exists to refuse. Clamping the horizon to `0` instead reads as "no earlier
 * than the reading itself" -- the most confidence the reading can ever lend
 * -- rather than extrapolating false certainty backwards in time.
 */
export function blend(observedFree: number | null, climatologyP: number, minutesFromReading: number): number {
  if (observedFree === null) return climatologyP;
  const weight = Math.pow(0.5, Math.max(0, minutesFromReading) / BLEND_HALF_LIFE_MIN);
  const near = observedFree >= 1 ? 1 : 0;
  return weight * near + (1 - weight) * climatologyP;
}
