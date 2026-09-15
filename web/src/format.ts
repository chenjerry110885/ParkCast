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
 *   - A lot whose feed is not updating says so, with how long, rather than "no
 *     data": the car park is real, and "its numbers stopped moving a day ago"
 *     is something a driver can act on.
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
 * never say when what it means is "unknown". `ProbabilityRing` -- the only
 * place a probability is drawn now -- goes through here rather than formatting
 * its own, so that rule has exactly one owner.
 *
 * `Pick<Strings, "noData">` and not the whole bag: the ring is handed the
 * unknown *text* rather than a language, because a lot whose feed has stopped
 * moving says "not updating" in that slot instead of "no data" (see
 * `notUpdatingHours`). Either way the caller names the string; this decides
 * when it is used.
 */
export function formatProbability(probability: number | null, s: Pick<Strings, "noData">): string {
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

/** Seconds in an hour. */
const HOUR_S = 3600;

/**
 * Whole hours a lot's feed has gone without an update, or `null` when the row
 * should show a probability, or plain "no data", instead.
 *
 * Both conditions are load-bearing:
 *
 *   - **The grid must have no forecast either.** The two files are fetched
 *     separately and `lots.json` may come from an earlier tick, so a stale `u`
 *     can sit beside a fresh grid in which the lot has started moving again.
 *     The grid is the fresher file; when it has a number, the number wins.
 *   - **Measured to the reading, not to now.** `u` and `baseDataTs` both
 *     describe the feed; how long ago the reading was is the staleness line's
 *     business. Counting to now would claim the lot stayed unchanged through
 *     time nobody observed.
 *
 * Floored, so the number shown never exceeds what was observed.
 */
export function notUpdatingHours(row: Ranked, baseDataTs: number): number | null {
  const u = row.lot.u;
  if (row.probability !== null || typeof u !== "number" || !Number.isFinite(u)) return null;
  return Math.max(0, Math.floor((baseDataTs - u) / HOUR_S));
}
