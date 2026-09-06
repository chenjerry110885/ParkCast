/**
 * How a ranked row becomes words on a phone.
 *
 * These three functions carry the whole truthfulness contract of the screen,
 * which is why they live apart from the component that calls them: they are
 * pure, they are the part that can lie, and they are tested through the
 * rendered row in `tests/app.test.tsx`.
 *
 * Each rule exists because the honest output and the convenient one differ:
 *
 *   - A null probability is "no data", never "0%". "We don't know" and
 *     "certainly full" are opposite claims about the same car park, and only
 *     one of them will make a driver give up on a space that was there.
 *   - An unpriced lot shows the words and no number at all. Not 0, not "free",
 *     and above all not the median rate `rank.ts` had to charge it to score it
 *     -- the user must never read a number the fare parser did not produce.
 *   - A per-entry (計次) fare is shown per entry. Branching on `hourly` alone
 *     would print "price unknown" over the 21 lots that charge per visit, whose
 *     price is perfectly well known and merely is not hourly.
 */
import type { Strings } from "./i18n";
import type { Ranked } from "./rank";

/** U+2013, the range dash: `NT$20–40` reads as a span, `NT$20-40` as a subtraction. */
const EN_DASH = "–";

/** Metres at or above which a distance reads better in kilometres. */
const KM_THRESHOLD = 1000;

/**
 * P(a space) as a percentage, or the "no data" string.
 *
 * The null branch is the reason this is a function and not a template in the
 * JSX: `${p * 100}%` on a null renders "0%", the one thing this screen must
 * never say when what it means is "unknown".
 */
export function formatProbability(probability: number | null, s: Strings): string {
  if (probability === null) return s.noData;
  return `${Math.round(probability * 100)}%`;
}

/** Straight-line distance, in whichever unit keeps it glanceable. */
export function formatDistance(meters: number, s: Strings): string {
  if (meters >= KM_THRESHOLD) return `${(meters / KM_THRESHOLD).toFixed(1)} ${s.kilometersUnit}`;
  return `${Math.round(meters)} ${s.metersUnit}`;
}

/** `NT$60`, or `NT$20–40` for a range. Null when the fare carries no number. */
function amount(lo: number | null | undefined, hi: number | null | undefined): string | null {
  const a = typeof lo === "number" ? lo : hi;
  const b = typeof hi === "number" ? hi : lo;
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return low === high ? `NT$${low}` : `NT$${low}${EN_DASH}${high}`;
}

/**
 * The fare, read off the lot's own parsed price rather than off the ranker's
 * `hourly` midpoint -- a range must render as the range the parser found, not
 * as the single number the cost model happened to score it with.
 *
 * `priceKnown` is the ranker's verdict and this defers to it, so a lot the
 * ranker had to charge the median fallback to still says "price unknown" here.
 * The number that ranked a lot is never the number shown for it.
 */
export function formatPrice(row: Ranked, s: Strings): string {
  if (!row.priceKnown) return s.priceUnknown;
  const price = row.lot.p;
  const text = amount(price.lo, price.hi);
  if (text === null) return s.priceUnknown;
  return `${text} ${price.k === "entry" ? s.perEntry : s.perHour}`;
}
