/**
 * How much to trust a forecast at a given horizon.
 *
 * The blend behind `probabilityAt` fades the live reading toward the
 * historical baseline as the horizon grows (`config.BLEND_HALF_LIFE_MIN`
 * halves the reading's weight every 30 minutes). A number 3 hours out is
 * mostly climatology wearing the live reading's clothes, and a driver
 * deciding whether to trust it needs that distinction spelled out in words,
 * not buried in a blend weight they never see. `confidenceFor` mirrors the
 * blend's own thresholds so the label never disagrees with the number next
 * to it.
 *
 * Silence is a valid answer: with no forecast, or for a lot whose feed has
 * stopped updating, there is nothing here to grade -- `null`, not a guess.
 */
export type Confidence = "high" | "medium" | "low";

/** The blend halves its weight on the live reading every 30 min of horizon (config.BLEND_HALF_LIFE_MIN). */
export const HIGH_MAX_MIN = 30;   // persistence weight >= 1/2
export const MEDIUM_MAX_MIN = 75; // persistence weight >= ~1/6

export function confidenceFor(horizonFromReadingMin: number, updating: boolean, probability: number | null): Confidence | null {
  if (probability === null || !updating) return null;
  if (horizonFromReadingMin <= HIGH_MAX_MIN) return "high";
  if (horizonFromReadingMin <= MEDIUM_MAX_MIN) return "medium";
  return "low";
}
