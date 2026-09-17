/**
 * How much to trust a forecast -- graded on the evidence behind it, not on
 * how far away the arrival is.
 *
 * An earlier version of this module derived the level from horizon alone: a
 * number three hours out was always "low", even for a lot with a month of
 * consistent history at exactly that half-hour of the week. That conflated
 * two different questions -- "how far away is this?" and "how much have we
 * watched this lot at this hour?" -- and answered only the first while
 * labelling the answer as if it were the second. A half-hour bucket that has
 * seen four weeks of Tuesday-21:20s is not a guess merely because tomorrow
 * hasn't happened yet.
 *
 * Two kinds of evidence can now earn a grade, and either is enough on its
 * own:
 *
 *   - A fresh **live reading**, close enough in time to the arrival that the
 *     blend (`week.ts`'s `blend`, `config.BLEND_HALF_LIFE_MIN`) is still
 *     mostly persistence rather than climatology. `HIGH_MAX_MIN` /
 *     `MEDIUM_MAX_MIN` mirror the blend's own thresholds so the label never
 *     disagrees with the number next to it, and `READING_FRESH_MAX_MIN` /
 *     `READING_RECENT_MAX_MIN` bound how stale the reading itself may be --
 *     a reading taken hours ago cannot lend the confidence of a reading
 *     taken minutes ago just because the arrival happens to be soon.
 *   - Accumulated **support**: the raw observation count behind this
 *     half-hour-of-week cell (`week.ts`'s `probabilityAt`). A 30-minute
 *     bucket at a five-minute cadence sees `WEEKLY_OBSERVATIONS` samples a
 *     week, so `support / WEEKLY_OBSERVATIONS`, floored, is roughly how many
 *     weeks of this exact time slot the climatology rests on.
 *
 * `reason` says which kind of evidence earned the grade, and carries the
 * number behind it (weeks, or the reading's age) so the UI can say so in
 * words instead of just asserting a level. A `"thin"` reason means neither
 * kind of evidence cleared even the medium bar -- not "far away", but "we
 * have not watched this lot at this hour often enough yet".
 *
 * The two kinds of evidence are checked independently per level, so both can
 * be true for the same input -- e.g. a five-minute-old reading ten minutes
 * out *and* five weeks of support both clear the high bar on their own. The
 * level is the same either way ("high"), but the reason is not, and which
 * one the function reports is a real choice, not an accident of source
 * order:
 *
 *   - **At the high bar, the reading wins.** A reading is a direct
 *     observation of *this* prediction, taken moments ago; a month of
 *     history is a claim about *other* weeks. When both clear the bar, the
 *     freshest, most specific evidence is the more informative thing to
 *     tell the driver, so it is cited first.
 *   - **At the medium bar, the weeks win.** A medium-strength reading is
 *     inherently borderline -- it is exactly the one that will drop out as
 *     the horizon ticks past `MEDIUM_MAX_MIN` a few minutes later, or as the
 *     reading itself ages past `READING_RECENT_MAX_MIN` -- while accumulated
 *     support for this half-hour does not change minute to minute. Citing
 *     the reading here would make the popover's own explanation flap
 *     between "a live reading" and "history" as the clock runs, for a grade
 *     that has not itself changed; citing the more durable claim instead
 *     keeps the explanation as stable as the level it is attached to.
 *
 * This is why the branches below check reading-then-weeks at the high tier
 * and weeks-then-reading at the medium tier -- the order is load-bearing,
 * not merely a transcription of the spec table's row order, and a test
 * pins each pairing (see `confidence.test.ts`'s "collision" tests).
 *
 * Silence is still a valid answer: with no forecast, a non-finite
 * probability (an unknown value, never a real one -- see `WEEK_UNKNOWN` in
 * `week.ts` for the same discipline), or for a lot whose feed has stopped
 * updating, there is nothing here to grade -- `null`, not a guess.
 */
export type Confidence = "high" | "medium" | "low";

/** Names the evidence behind a `Confidence` grade, with the number the UI reports it by. */
export type ConfidenceReason =
  | { kind: "reading"; ageMin: number }
  | { kind: "weeks"; weeks: number }
  | { kind: "thin" };

export interface ConfidenceInput {
  /** Minutes from the reading behind the forecast to the arrival time being graded. */
  minutesFromReading: number;
  /**
   * Minutes since the live reading itself was taken -- how stale the reading
   * is, independent of how far the arrival being graded happens to be.
   */
  readingAgeMin: number;
  /** Raw observation count behind this half-hour-of-week cell (`week.ts`'s `probabilityAt`), capped at 255. */
  support: number;
  /** Whether the lot's feed is still updating; a stalled feed has nothing left to grade. */
  updating: boolean;
  /** The forecast probability itself; `null` means there is nothing to grade. */
  probability: number | null;
}

/** The blend halves its weight on the live reading every 30 min of horizon (config.BLEND_HALF_LIFE_MIN). */
export const HIGH_MAX_MIN = 30;   // persistence weight >= 1/2
export const MEDIUM_MAX_MIN = 75; // persistence weight >= ~1/6

/** How old the live reading itself may be to still lend `"high"` confidence at `HIGH_MAX_MIN`. */
export const READING_FRESH_MAX_MIN = 15;
/** How old the live reading itself may be to still lend `"medium"` confidence at `MEDIUM_MAX_MIN`. */
export const READING_RECENT_MAX_MIN = 30;

/** Support (in raw observations) at or above which a cell reads `"high"` -- about 4 weeks of this half-hour. */
export const SUPPORT_HIGH_MIN = 24;
/** Support at or above which a cell reads `"medium"` -- about 1 week of this half-hour. */
export const SUPPORT_MEDIUM_MIN = 6;

/** Observations a 30-minute bucket collects per week at the collector's 5-minute cadence. */
export const WEEKLY_OBSERVATIONS = 6;

export function confidenceFor({
  minutesFromReading,
  readingAgeMin,
  support,
  updating,
  probability,
}: ConfidenceInput): { level: Confidence; reason: ConfidenceReason } | null {
  // `typeof NaN === "number"`, so an unknown probability must be refused by
  // value, not merely by `!== null` -- see `228ce2f` on this branch for the
  // same guard closing the same class of bug in `probabilityAt`.
  if (probability === null || !Number.isFinite(probability) || !updating) return null;

  const weeks = Math.floor(support / WEEKLY_OBSERVATIONS);

  if (readingAgeMin <= READING_FRESH_MAX_MIN && minutesFromReading <= HIGH_MAX_MIN) {
    return { level: "high", reason: { kind: "reading", ageMin: readingAgeMin } };
  }
  if (support >= SUPPORT_HIGH_MIN) {
    return { level: "high", reason: { kind: "weeks", weeks } };
  }
  if (support >= SUPPORT_MEDIUM_MIN) {
    return { level: "medium", reason: { kind: "weeks", weeks } };
  }
  if (readingAgeMin <= READING_RECENT_MAX_MIN && minutesFromReading <= MEDIUM_MAX_MIN) {
    return { level: "medium", reason: { kind: "reading", ageMin: readingAgeMin } };
  }
  return { level: "low", reason: { kind: "thin" } };
}
