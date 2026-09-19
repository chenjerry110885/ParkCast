/**
 * The expected-cost ranker -- the product's actual judgment.
 *
 * Every other parking app answers "is there a space right now?". The question a
 * driver has is "where should I park, given I arrive in 18 minutes?", which is a
 * decision under uncertainty rather than a lookup. This module makes that
 * decision explicit: it prices the three things a driver trades off in their
 * head -- how likely a space is, how far they then walk, and what it costs --
 * into one comparable number, in NT$.
 *
 *     cost = p * (walkMin * WALK_VALUE + fee)
 *          + (1 - p) * (CIRCLING_PENALTY_MIN * DELAY_VALUE
 *                       + DRIVE_MIN_PER_KM * DELAY_VALUE * km to the fallback lot
 *                       + the fallback lot's own cost)
 *
 * The second line is the one that converts a probability into a decision: it
 * charges a lot for the risk of arriving to find nothing, and for everything
 * that failure then forces. See `rankLots`.
 *
 * The two prices in that formula are the one thing a driver can move: see
 * `Preference` and `PREFERENCES`, which hold three pairs of them. The default
 * pair is `WALK_VALUE` / `DELAY_VALUE` exactly, so a driver who never opens the
 * control gets the ranking this module produced before preferences existed.
 *
 * `cost` is a *sort key*, not something the UI shows. The spec is explicit that
 * P, walking time and price appear as three separate visible columns and are
 * never collapsed into a single opaque score -- users do not trust magic
 * rankings, and should not -- so every input to the score is on the `Ranked`
 * row individually.
 */
import { haversineMeters, walkMinutes, type LatLon } from "./geo";
import type { Lot, Price } from "./types";

/* ------------------------------------------------------------------ *
 * The cost model. Every number here is a judgment call rather than a
 * measurement -- so they live here, named, where a reader can find
 * them and argue with them, instead of inline in an expression where
 * they would quietly become folklore.
 * ------------------------------------------------------------------ */

/**
 * NT$ a minute of the driver's own time is worth while walking from the car
 * park to the destination. NT$5/min is NT$300/hour, about 1.5x Taiwan's
 * minimum wage -- the usual multiplier for out-of-vehicle time, which people
 * dislike more than time spent sitting in the car.
 *
 * Split from what used to be one constant, `TIME_VALUE`, which priced the
 * walk and a failed attempt at the same rate despite them being different
 * quantities. `DELAY_VALUE` now prices the failure branch on its own, so a
 * later preference can move what a driver's time is worth on foot without
 * moving what a failed attempt costs. Both start at 5, so the split changes
 * no ranking by itself -- only a future difference between the two will.
 *
 * Only the *ratios* between these five constants change any ranking; scaling
 * all of them together changes nothing.
 *
 * This is the **Balanced** price, and the one the app shipped with. The other
 * two presets move it -- NT$2 for Cheaper, NT$12 for Closer -- and nothing else
 * in this file moves with it except `DELAY_VALUE`'s floor. See `PREFERENCES`.
 */
export const WALK_VALUE = 5;

/**
 * NT$ a minute is worth when it is lost to a failed attempt: circling after
 * arriving to find no space (`CIRCLING_PENALTY_MIN`), and the drive to
 * wherever the trip actually ends up (`DRIVE_MIN_PER_KM`). Same NT$5/min
 * out-of-vehicle rate as `WALK_VALUE`, and the same reasoning -- see there
 * for why the two are priced separately instead of sharing one constant.
 *
 * A preference can raise this but never lower it: it is the **floor** in
 * `DELAY_VALUE = max(5, WALK_VALUE)`, which is what stops a driver who asked
 * for a cheaper car park from quietly buying a weaker availability signal.
 * See `PREFERENCES` for why the rule has that shape and what was measured to
 * settle it.
 */
export const DELAY_VALUE = 5;

/**
 * How long we assume the visit lasts, in hours. Two hours is the shape of a
 * typical Taipei short-stay: a meal, a film, a shopping trip. It converts an
 * hourly rate into the money actually spent, so a cheap lot's advantage is
 * weighed at the size it really has.
 *
 * A consequence, raised as a question and **ratified 2026-09-07**: at two hours,
 * price outweighs walking distance for most realistic pairs of lots. That is
 * deliberate. Between two car parks that both have a space, a driver takes the
 * cheaper one, and the measured spread bears the ordering out -- across four
 * real destinations the top ten differ by at most 9 points of probability but by
 * a factor of three in price, so price and walking *are* the live variables and
 * a ranking that ignored them would be ignoring the whole decision.
 *
 * This says nothing about price versus *probability*. See
 * `CIRCLING_PENALTY_MIN`, and `scripts/probe-ranker.py`, which measures it.
 */
export const EXPECTED_HOURS = 2;

/**
 * Minutes lost on the spot when you arrive and there is no space: noticing,
 * re-routing, and circling again once you reach the next candidate. Twelve
 * minutes is a middling estimate for dense Taipei; it is the most opinionated
 * number here, because it sets the floor of what a failed attempt costs -- NT$60,
 * or 12 minutes of walking, before the drive to the next candidate and that
 * candidate's own cost are added.
 *
 * The drive is *not* in here. Until 2026-09-14 this comment said it was, but no
 * single number can hold it -- it is a few hundred metres in Xinyi and several
 * kilometres on Yangmingshan -- and nothing charged it by distance. It is now
 * priced separately: see `DRIVE_MIN_PER_KM`.
 */
export const CIRCLING_PENALTY_MIN = 12;

/**
 * Minutes of driving per kilometre of straight-line distance: what a failed
 * attempt is charged for getting from the car park that turned you away to the
 * one you fall back to.
 *
 * Failing leaves you where that car park is, not where you were going, so what
 * failing costs grows with how far away it is. Leaving the drive out made a
 * hopeless lot's position irrelevant: as `p` falls towards zero its score tends
 * to circling plus the fallback, the same anywhere in the city and cheaper than a
 * certain space a kilometre out. On the 2026-09-14 09:43 grid, 797 of 1,090
 * destinations had a lot under 50% more than 1.5 km away in their top 20, and
 * 13 had one under 10% more than 3 km away in their top three.
 *
 * 2.4 minutes a straight-line kilometre is 25 km/h as the crow flies -- about
 * 30 km/h on streets a fifth longer than the straight line, the quick end of
 * driving across Taipei, so close to the least this drive can cost. A straight
 * line because the ranker has no road network; the constant absorbs the detour.
 * The minutes are priced at `DELAY_VALUE`, like circling. That rate is meant for
 * time out of the car and overstates time behind the wheel, while fuel is not
 * counted at all; one time value keeps the exchange rate with circling where it
 * was set.
 *
 * Like the rest, a judgment and not a measurement, and not one to tune towards
 * a metric. It is not a knife-edge either: `scripts/probe-ranker.py` reports
 * what NT$15 and NT$20 a kilometre would do beside it.
 */
export const DRIVE_MIN_PER_KM = 2.4;

/**
 * The chance at or above which a car park counts as somewhere you can *plan* to
 * end up, and so can serve as the fallback a failed attempt falls back to.
 *
 * Something has to play that role. Without it the model has no way to say what
 * arriving to find no space actually costs, and has to guess a flat penalty --
 * which is what it used to do, and why a lot at P=1% could outrank one at
 * P=100% a kilometre away. Ninety per cent is where a driver stops hedging: the
 * measured roster is bimodal, 15.6% of lots below 50% and 81.7% at or above
 * 90%, with only 2.7% in between, so the threshold sits in the empty middle and
 * nothing lands near enough to it for the exact value to decide an ordering.
 */
export const RELIABLE_P = 0.9;

/**
 * The rate an unpriced lot is *scored* at: NT$/hour, the citywide median of the
 * 1,040 lots whose fare text does parse (measured over the shipped `lots.json`,
 * 2026-09-06).
 *
 * Emphatically not zero. About 2.5% of lots have no parseable price, and
 * scoring them free would float every one of them to the top of the list -- a
 * systematic bias in favour of exactly the lots we know least about. Charging
 * them the median makes "we do not know" cost what a typical lot costs, which
 * is the honest prior.
 *
 * The row still reports `priceKnown: false` and `hourly: null`, so the UI tells
 * the user the truth even though the ranking had to assume something.
 */
export const MEDIAN_PRICE_FALLBACK = 77.5;

/* ------------------------------------------------------------------ *
 * What the driver is asking of the ranking. Not a second scoring
 * scheme -- just a different price for a minute on foot, which is a
 * number the cost model already had and has already been calibrated
 * against the live roster.
 * ------------------------------------------------------------------ */

/**
 * Which way a driver wants the ranking to lean.
 *
 * Comparatives on purpose. "Cheaper" and "closer" describe a lean, not a
 * promise: under every one of them the ranker still puts a likely space above
 * an unlikely bargain, and neither the copy nor this type should suggest that
 * choosing one buys a guarantee about the car park at the top of the list.
 */
export type Preference = "cheaper" | "balanced" | "closer";

/**
 * What a driver who has never touched the control is ranked by -- and what a
 * stored value we cannot read falls back to (see `preference.ts`).
 *
 * Balanced is the pair the app shipped with, so this default is not merely a
 * sensible choice among three: it is the guarantee that this whole feature
 * changes nothing for a driver who ignores it.
 */
export const DEFAULT_PREFERENCE: Preference = "balanced";

/** The floor rule, in one place: a preference may raise the price of a delay, never lower it. */
function pricesFor(walk: number): { walk: number; delay: number } {
  return { walk, delay: Math.max(DELAY_VALUE, walk) };
}

/**
 * The two prices each preference pays for a minute, in NT$.
 *
 * `delay` is not a free parameter. It is `max(DELAY_VALUE, walk)` -- floor
 * coupled -- and that rule is **measured, not reasoned**. It looks arbitrary
 * next to the two obvious alternatives, and both of those were tried first and
 * found unsafe, at opposite ends, against the live roster:
 *
 *   - **Pinning `delay` at 5 regardless of the preference makes Closer
 *     unsafe.** Every inversion this produces has the shape *near, cheap,
 *     unlikely* beating *far, expensive, likely*: raising `walk` penalises
 *     only the **far** lot -- which is the reliable one -- while the risky
 *     lot, sitting at the destination, pays nothing extra.
 *   - **Coupling the two symmetrically (`delay = walk`) repairs Closer and
 *     breaks Cheaper instead.** A delay of NT$2/min makes being turned away
 *     almost free, so the preset a price-conscious driver reaches for buys a
 *     weaker availability signal along with it.
 *   - **The floor is the only shape that holds both ends**, because it can
 *     only rise: the delay price can never fall below today's value, so a
 *     preference cannot erode the penalty for being sent away, and it rises
 *     with `walk` so that making walking expensive does not *relatively*
 *     cheapen being turned away.
 *
 * Do not quote an inversion count in this comment. `scripts/probe-ranker.py`'s
 * own sweep found the counts swing by a factor of five on the same code and
 * the same roster, purely from which snapshot was measured or which forecast
 * column was read -- see the 2026-09-19 correction in the design spec's §5.
 * What reproduced everywhere measured instead: Cheaper is the safest
 * direction by a wide margin; floor-coupled Closer is safer than Balanced on
 * inversion count in both samples measured, though not always on worst
 * position -- that is a real trade for asking to walk less, visible to the
 * driver on the card, not a defect to tune away; and, the one invariant this
 * module actually depends on, **no preset has ever put an inversion at #1**.
 * Run the probe for a current number with its provenance -- it parses these
 * constants out of this file rather than copying them, precisely so it cannot
 * report a stale sweep as the current one.
 *
 * The invariant this protects is the app's central claim: it ranks by how
 * likely you are to get a space. A preference is allowed to change what the
 * walk and the fare are worth beside that; it is not allowed to erode it. If a
 * later sweep finds an inversion at #1, the answer is to narrow the range of
 * these presets, not to widen what counts as acceptable.
 *
 * The score built from these numbers is a sort key and is still never shown.
 * The control names a preference, not a number -- no card gains a "NT$142".
 */
export const PREFERENCES: Record<Preference, { walk: number; delay: number }> = {
  cheaper: pricesFor(2),
  balanced: pricesFor(WALK_VALUE),
  closer: pricesFor(12),
};

/**
 * One ranked candidate. Every component of the score is here separately and on
 * purpose (see the module comment): the list renders them as columns.
 */
export interface Ranked {
  /** The source row, for the name, district and map pin. */
  lot: Lot;
  /** Feed id, lifted out because the list keys on it. */
  id: string;
  /**
   * Position in the input array, and what `probability` was called with.
   *
   * Not necessarily the grid row: `fetchLots` may have dropped an unusable row,
   * so the caller resolves the row through `Lot.i`. See `App.tsx`.
   */
  index: number;
  /** P(at least one space) at the arrival time, or `null` if we have none. */
  probability: number | null;
  /** NT$/hour. `null` when the fare did not parse, and for per-entry lots. */
  hourly: number | null;
  /** NT$ for one visit, for lots that charge a flat entry fee. Else `null`. */
  perEntry: number | null;
  /** False only when we have no usable price at all -- not merely no *hourly* one. */
  priceKnown: boolean;
  /** Straight-line metres from the destination. */
  meters: number;
  /** Whole minutes to walk `meters`, rounded up. */
  walkMin: number;
  /**
   * Expected cost in NT$, or `null` when `probability` is unknown: without P
   * the risk term is undefined, and a cost missing that term is a different
   * quantity that must not be compared with a complete one. Sorting keeps the
   * two apart rather than pretending otherwise.
   */
  cost: number | null;
}

export interface RankInput {
  /** Where the driver is actually going -- not where they are now. */
  destination: LatLon;
  /**
   * Minutes until arrival, passed through to `probability` untouched.
   *
   * Measured from the *reading* the forecast was built on, not from the wall
   * clock: the app passes `horizonFromReadingMin`, which `arrival.ts` measures
   * from the shard's `base_data_ts`. This module never interprets the number,
   * so the choice belongs to the caller -- but the two must not be confused,
   * because a stale reading makes them differ by however long ago it was
   * taken. See `probabilityForLot` in `App.tsx`.
   */
  horizonMin: number;
  /** Candidates, in grid-row order. */
  lots: readonly Lot[];
  /**
   * P(space) for the lot at `lotIndex`, or `null` for "no forecast".
   *
   * A callback rather than a `Grid` so that ranking -- the part with the
   * product judgment in it -- stays testable without building binary buffers.
   * In the app this is
   * `(i, h) => (withheld ? null : probabilityForLot(g, week, rows[i], h, arrivalTs))`
   * (`App.tsx`), which reads `grid.bin` inside its +120 min window and
   * `week.bin` past it. So a `null` here can mean "no grid cell", "no week
   * table", "no cell in it for this lot", or "the reading is too old to answer
   * from at all" -- and this module deliberately does not care which. It knows
   * only "we have a number" and "we do not".
   */
  probability: (lotIndex: number, horizonMin: number) => number | null;
  /**
   * Which way the driver asked the ranking to lean. Omitted means
   * `DEFAULT_PREFERENCE`, which is Balanced, which is the pair of prices this
   * module used before the option existed -- so every existing caller, and
   * every test written before this, keeps the ordering it had.
   *
   * Optional rather than required for exactly that reason: a caller that has
   * no opinion should not have to state one, and should not be able to change
   * today's behaviour by forgetting to.
   */
  preference?: Preference;
}

/** What a parsed fare costs us, and what we can honestly say about it. */
interface Money {
  hourly: number | null;
  perEntry: number | null;
  priceKnown: boolean;
  /** NT$ this lot is charged in the score for one visit. */
  fee: number;
}

/** The midpoint of a parsed fare, or `null` if it carries no usable number. */
function midpoint(price: Price): number | null {
  const lo = price.lo ?? price.hi;
  const hi = price.hi ?? price.lo;
  if (typeof lo !== "number" || typeof hi !== "number") return null;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < 0) return null;
  return (lo + hi) / 2;
}

/**
 * Turn a parsed fare into the money term of the score.
 *
 * A `range` becomes its midpoint. An `entry` fare is a flat charge per visit,
 * so it enters the score once and is *not* multiplied by `EXPECTED_HOURS` --
 * charging NT$50-a-visit as if it were NT$50-an-hour would push all 21 such
 * lots to the bottom of every list. It is reported as `perEntry` rather than
 * folded into `hourly`, so the UI never invents a per-hour rate that no sign at
 * the car park displays.
 */
function priceOf(price: Price | undefined): Money {
  const mid = price === undefined ? null : midpoint(price);
  if (price === undefined || mid === null || price.k === "unknown") {
    return {
      hourly: null,
      perEntry: null,
      priceKnown: false,
      fee: MEDIAN_PRICE_FALLBACK * EXPECTED_HOURS,
    };
  }
  if (price.k === "entry") {
    return { hourly: null, perEntry: mid, priceKnown: true, fee: mid };
  }
  return { hourly: mid, perEntry: null, priceKnown: true, fee: mid * EXPECTED_HOURS };
}

/**
 * A probability we are willing to do arithmetic with, or `null`.
 *
 * A value outside 0..1 would mean a corrupt grid; clamping keeps it from
 * producing a *negative* risk term, which would rank the corrupt lot first --
 * the worst possible response to bad data.
 */
function usableProbability(p: number | null): number | null {
  if (p === null || !Number.isFinite(p)) return null;
  return Math.min(1, Math.max(0, p));
}

/**
 * This car park's feed has stopped, so we will not *recommend* it.
 *
 * `Lot.u` is published only for the lots `src/parkcast/liveness.py` found not
 * updating -- the same reading, or no reading, for at least 24 hours -- and is
 * absent for a live one, so there is no value to misread. The guard matches
 * `format.notUpdatingHours`'s exactly, so the lots demoted here are the same
 * lots whose cards read "Not updating".
 */
export function notUpdating(lot: Lot): boolean {
  return typeof lot.u === "number" && Number.isFinite(lot.u);
}

/**
 * Which of three ordering groups a scored row belongs to; lower sorts first.
 *
 * `0` a forecast we can stand behind, `1` a forecast for a car park we have
 * not heard from, `2` no forecast at all. Inside a group the sort key is the
 * expected cost, as it always was.
 *
 * **Group 1 is Stage A's doing, and it is a ranking rule rather than an honesty
 * one.** `grid.bin` is built through `liveness.Withholding`, so inside its
 * +120 min window a stalled lot has no forecast at all and falls into group 2
 * exactly as it did before this existed. `week.bin` has no such wrapper, on
 * purpose: what a car park usually has free at 21:20 on a Thursday does not
 * depend on whether its feed answered today, and blanking that would throw a
 * good answer away to fix a presentation problem -- and would change the
 * published artifact for every consumer. So past the window a stalled lot
 * carries a full, legitimate climatology figure, and until this group existed
 * it could out-rank every car park we can actually see and wear the "Best
 * pick" badge with no confidence pill beside it.
 *
 * The number is honest; the *recommendation* was not. A lot nobody has heard
 * from in thirty hours may simply be closed, and neither artifact can tell us.
 * So the figure stays, the row stays, and only the endorsement goes: below
 * every comparable live lot, and never `bestId` (`App.tsx`). Suppressing the
 * number or dropping the row would be the opposite fault -- see `listRows` on
 * why a missing car park is worse than an honest one.
 *
 * Read off `Lot.u` rather than off where the probability came from, because
 * this module does not know: see `RankInput.probability`. The two can only
 * disagree in a state production cannot produce -- `u` is emitted only for
 * lots whose grid row is UNKNOWN in every column, so a grid-sourced number and
 * a `u` never coexist -- and if one ever did, declining to crown a lot is the
 * cheap side of that bet. The number is unaffected either way.
 *
 * `fallbackCost` is deliberately left alone: it asks what the neighbourhood
 * costs, not where to send the driver, and the answer feeds every lot's score
 * equally. Changing it would move published-looking numbers for lots that have
 * nothing wrong with them, to no benefit this finding asked for.
 */
function group(row: Ranked): number {
  if (row.cost === null) return 2;
  return notUpdating(row.lot) ? 1 : 0;
}

/**
 * What a failed attempt forces you to do next, in NT$.
 *
 * The cost of arriving to find no space is not just the time spent circling --
 * you still have to get to a car park that does have one, and pay for it. That
 * second half varies enormously by where you are: failing in Xinyi costs a
 * couple of minutes, failing in Beitou can cost a kilometre. A single tuned
 * constant cannot express that, which is why this is derived from the roster
 * being ranked rather than chosen.
 *
 * The cheapest *reliable* lot, scored the simple way. Preferring a reliable one
 * matters: a fallback you might also be turned away from is not a fallback, and
 * the recursion that would properly account for that has to stop somewhere.
 * Stopping after one step is the honest approximation, and it is a conservative
 * one -- the true cost of a chain of failures is higher, never lower.
 *
 * When nothing clears `RELIABLE_P` the cheapest lot with any forecast is used
 * instead. That is an incoherent fallback in principle -- it may itself be full
 * -- but it is the best available, and it keeps the ordering meaningful in the
 * one situation where the ranking matters most, which is a neighbourhood where
 * everything is nearly full.
 *
 * It returns where that lot is as well as what it costs, because a failure is
 * also charged the drive to it -- see `DRIVE_MIN_PER_KM`. One lot for the whole
 * ranking rather than the best alternative from each lot tried: which reliable
 * lot is cheapest is decided mostly by its walk to the destination, so it is the
 * same lot either way, and finding it per lot would compare every pair of car
 * parks on every move of the time slider.
 *
 * Note that the best reliable lot's own fallback is itself. That is harmless:
 * the drive to itself is zero, and the rest is weighted by `1 - p`, which is at
 * most `1 - RELIABLE_P` for exactly the lots this can happen to, so it can move
 * that lot's score by no more than a tenth of one circling penalty. Paying for a
 * second pass to remove a rounding error would be the wrong trade.
 *
 * `delay` is the preference's price for a minute lost, and `certain` already
 * carries its price for a minute walked, so which lot the ranking falls back to
 * can itself change with the preference -- as it should: the driver's own
 * arithmetic is what decides where they would go instead.
 */
function fallbackCost(
  scored: readonly { probability: number | null; certain: number; position: LatLon }[],
  delay: number,
): { cost: number; at: LatLon | null } {
  let reliable: { cost: number; at: LatLon | null } = { cost: Infinity, at: null };
  let anyForecast: { cost: number; at: LatLon | null } = { cost: Infinity, at: null };
  for (const s of scored) {
    if (s.probability === null) continue;
    const simple = s.certain + (1 - s.probability) * CIRCLING_PENALTY_MIN * delay;
    if (simple < anyForecast.cost) anyForecast = { cost: simple, at: s.position };
    if (s.probability >= RELIABLE_P && simple < reliable.cost) {
      reliable = { cost: simple, at: s.position };
    }
  }
  if (reliable.at !== null) return reliable;
  if (anyForecast.at !== null) return anyForecast;
  // Nothing has a forecast at all, so every lot is about to score `null` anyway
  // and this value reaches no arithmetic that survives.
  return { cost: 0, at: null };
}

/**
 * Score every lot and sort by ascending expected cost.
 *
 * `cost` is the expected cost of the whole trip in NT$, and is meant literally:
 * with probability `p` you park here and pay the walk and the fare, and with
 * probability `1 - p` you pay the circling penalty, the drive from here to
 * somewhere that has a space, and the cost of parking there. That is one
 * arithmetic statement of what a driver is choosing between, and it is why the
 * two branches carry different money -- you do not pay this car park's fare for
 * a space it did not have.
 *
 * It did not always say that. Until 2026-09-09 the score was `walk + fare +
 * (1 - p) x circling`: it charged the fare unconditionally and never charged
 * the trip a failure forces, so the entire probability range was worth one
 * circling penalty -- NT$60, which is also 12 minutes of walking. Being a
 * kilometre closer therefore cancelled being certainly full, and
 * `scripts/probe-ranker.py` found 89 orderings in the live roster that said so,
 * including a lot at P=1% ranked above one at P=100%. For a project whose whole
 * claim is that it ranks by probability, that was the wrong bug to have.
 *
 * The new form reduces to the old one exactly where it should: at `p = 1` the
 * failure branch vanishes and the score is the walk plus the fare, which is
 * simply what the driver pays.
 *
 * It was still missing a piece until 2026-09-14: the failure branch charged the
 * fallback's cost but not the drive to it, as if every failure happened at the
 * destination. As `p` fell towards zero a lot's own position stopped mattering,
 * and car parks the model thought hopeless, kilometres away, filled the tail of
 * 797 of 1,090 lists while the top of every one stayed right -- which is all
 * the probe was checking. Charging the drive by distance put that at 366, and a
 * lot under 10% more than 3 km away in a top three at 1 destination instead of
 * 13, while changing first place for 1. See `DRIVE_MIN_PER_KM`.
 *
 * Price still outweighs walking distance for most realistic pairs, which is
 * deliberate and ratified -- see `EXPECTED_HOURS`. Neither change touched it:
 * both live in the failure branch, which a certain space never reaches.
 *
 * Lots with no forecast are kept and ranked last -- never dropped. Silently
 * removing a car park is a worse failure than showing it with "no data": the
 * user may know something we do not, and a missing row is invisible while an
 * honest one is not. They sort among themselves by the part of the cost we can
 * still compute, walking plus money.
 *
 * A car park whose feed has stopped sits between the two: it keeps its number
 * and its row, but sorts below every lot we have actually heard from. See
 * `group`, which is where the three-way ordering is argued.
 *
 * `input.preference` changes two numbers in the arithmetic above and nothing
 * else -- not the grouping, not the fallback rule, not what any row reports.
 * Omitting it ranks by Balanced, which is the pair of prices this function used
 * before the option existed, so the default is a promise rather than a taste:
 * the driver who never opens the control sees exactly what they saw before.
 */
export function rankLots(input: RankInput): Ranked[] {
  // The only thing a preference changes: what a minute on foot costs, and what
  // a minute lost to a failed attempt costs. Every other constant, and the
  // shape of the formula, is the same under all three. See `PREFERENCES`.
  const price = PREFERENCES[input.preference ?? DEFAULT_PREFERENCE];

  const scored = input.lots.map((lot, index) => {
    const position = { lat: lot.y, lon: lot.x };
    const meters = haversineMeters(input.destination, position);
    const walkMin = walkMinutes(meters);
    const money = priceOf(lot.p);
    const probability = usableProbability(input.probability(index, input.horizonMin));
    // What parking *here* costs once you are in: the whole story for a lot whose
    // probability is unknown, and the sort key within that group.
    const certain = walkMin * price.walk + money.fee;
    return { lot, index, position, meters, walkMin, money, probability, certain };
  });

  // One fallback for the whole ranking, found before any lot is scored.
  const fallback = fallbackCost(scored, price.delay);
  // NT$ to drive from a lot that turned you away to the fallback lot.
  const drive = (from: LatLon): number =>
    fallback.at === null
      ? 0
      : (DRIVE_MIN_PER_KM * price.delay * haversineMeters(from, fallback.at)) / 1000;

  const rows = scored.map((s) => {
    const row: Ranked = {
      lot: s.lot,
      id: s.lot.id,
      index: s.index,
      probability: s.probability,
      hourly: s.money.hourly,
      perEntry: s.money.perEntry,
      priceKnown: s.money.priceKnown,
      meters: s.meters,
      walkMin: s.walkMin,
      cost:
        s.probability === null
          ? null
          : s.probability * s.certain +
            (1 - s.probability) *
              (CIRCLING_PENALTY_MIN * price.delay + drive(s.position) + fallback.cost),
    };
    return { row, certain: s.certain };
  });

  rows.sort((a, b) => {
    const ga = group(a.row);
    const gb = group(b.row);
    if (ga !== gb) return ga - gb;
    return (a.row.cost ?? a.certain) - (b.row.cost ?? b.certain);
  });

  return rows.map((r) => r.row);
}

/**
 * How many no-forecast lots the list will grow by to keep the ranker's promise.
 * A handful, so the rescue stays a footnote on the list rather than a second one.
 */
export const UNKNOWN_RESERVE = 5;

/**
 * How far from the destination the list still reaches, in metres.
 *
 * The cap below is a rendering budget, not a judgment about where a driver
 * would park -- but for as long as it was the list's only bound, it was being
 * read as one. The owner reported the symptom: *"I always see lots around
 * that's green but didn't see it in the list if I'd like to know the detail
 * about it."* A car park drawn on the map a few hundred metres away, plainly
 * free, with no row to open -- because twenty rows are chosen by expected
 * *cost*, and a near lot can lose that race on price alone.
 *
 * So the list is bounded by distance, and the cap now only decides where the
 * expander goes. 1,500 m is about a nineteen-minute walk at `WALK_METERS_PER_MIN`,
 * and it is sized against the roster rather than picked. Sampling 120
 * destinations drawn from lot positions in the 1,089-lot Taipei roster:
 *
 * | Radius | Walk | Median lots | 90th pct | Worst |
 * |---|---|---|---|---|
 * | 1.0 km | 12 min | 38 | 70 | 76 |
 * | **1.5 km** | **19 min** | **74** | **148** | **156** |
 * | 2.0 km | 25 min | 126 | 245 | 254 |
 *
 * What those figures are *of* matters more than their digits, so: the count of
 * car parks within the radius of one destination, over 120 destinations taken
 * from lot positions in `web/.dev-artifacts/lots.json` (2026-09-18, 1,089
 * lots), evenly spaced through the roster array. Drawing the destinations from
 * lots rather than from a grid is deliberate and makes the numbers *high* --
 * a point where a car park already stands is a point car parks cluster around
 * -- which is the conservative side to be on for a rendering budget. A
 * different sample moves the median by single digits and the worst case by
 * about a lot; it does not move the conclusion.
 *
 * The radius is therefore not the constraint; rendering is. Laying out 156
 * cards at once is exactly the cost this project has already been told about,
 * which is why everything past the cap sits in `ListRows.nearby` behind an
 * expander, and a phone pays only for what the driver opens. Distant lots sink
 * to the tail under the ranking anyway, so the order that budget is spent in is
 * already the right one.
 *
 * Well inside `App`'s `COVERAGE_RADIUS_M`, which is the distance past which a
 * tapped lot gets no card at all -- so every row this radius admits is one
 * whose detail the app can actually show.
 */
export const NEARBY_RADIUS_M = 1500;

/**
 * What the list draws, and what it can reach from there.
 *
 * Two arrays rather than one, because they are bounded by different things and
 * cost different amounts to render. `head` is the ranked list as it has always
 * been -- the cap, plus the rescue -- and is drawn unconditionally. `nearby` is
 * the rest of the neighbourhood, up to a hundred and fifty rows of it, and is
 * drawn only when the driver asks.
 */
export interface ListRows {
  /**
   * The ranked head: the first `limit` rows, plus any nearer no-forecast lots
   * the cap would otherwise have dropped. Exactly what the list drew before
   * `nearby` existed, which is the promise this split has to keep.
   */
  head: Ranked[];
  /**
   * Every other car park within `NEARBY_RADIUS_M`, **in the ranker's order** --
   * the same ordering `head` is in, continued, not a second sort. Disjoint from
   * `head` by construction.
   *
   * Sorting this by distance instead would be the easy mistake and a quiet
   * contradiction: the twenty rows above it are ordered by expected cost, and a
   * tail that changed the rule halfway down would be two rankings stacked on
   * top of each other with nothing saying so.
   */
  nearby: Ranked[];
}

/**
 * The head of the ranking, plus any nearer no-forecast lots the cap would drop.
 *
 * `rankLots` keeps a lot with no forecast and sorts it behind every lot that has
 * one -- deliberately: a cost missing its risk term is a different quantity, and
 * comparing the two would float exactly the lots we know least about to the top.
 * Rendering only the first N rows then undoes that promise *precisely*: the rows
 * the ranker refused to drop are the first ones the cap drops, and a car park
 * missing from the list is invisible while one that says "no data" is not.
 *
 * So the cap bends and the sort does not. The alternative -- ranking unknowns by
 * distance among the rest -- would have to compare the two costs after all, and
 * would be a systematic bias dressed as a fix.
 *
 * A no-forecast lot is appended when it is no further from the destination than
 * a lot already on screen. That is the honest reading of "nearby" here: the
 * user's own list sets the scale, so this promises nothing about a lot across
 * the city and everything about one on the same street. At most
 * `UNKNOWN_RESERVE` of them, nearest first.
 */
function rankedHead(ranked: readonly Ranked[], limit: number): Ranked[] {
  const head = ranked.slice(0, limit);
  // Nothing was cut, or the cap already reached the unknown group -- and when
  // no lot has a forecast at all, the head *is* that group and needs no rescue.
  if (head.length === ranked.length) return head;
  if (head.some((row) => row.probability === null)) return head;

  const envelope = head.reduce((furthest, row) => Math.max(furthest, row.meters), 0);
  const rescued = ranked
    .slice(limit)
    .filter((row) => row.probability === null && row.meters <= envelope)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, UNKNOWN_RESERVE);

  return rescued.length === 0 ? head : [...head, ...rescued];
}

/**
 * Split the ranking into the rows the list draws and the rows it can reach.
 *
 * The cap stays where it is and keeps doing what it did -- `head` is
 * `rankedHead` unchanged, so a driver who never opens the expander sees the
 * list they already had, down to the row. What changes is that the cap is no
 * longer the *end* of the list: everything else within `NEARBY_RADIUS_M` comes
 * back in `nearby`, so a car park the driver can see on the map and could walk
 * to always has a row to open, whatever the cost model made of its price.
 *
 * `Array#filter` preserves order, so `nearby` is the ranker's own ordering with
 * `head`'s rows lifted out of it -- a continuation, never a re-sort. See
 * `ListRows.nearby`.
 *
 * Disjointness is by **row identity**, not by index. `rankedHead` can reach
 * past `limit` for a no-forecast lot near the destination, so the rows it
 * returns are not always `ranked`'s first `head.length`; a tail sliced from
 * either offset would list every rescued lot twice, and those are precisely the
 * nearby lots the rescue exists to show once.
 */
export function listRows(ranked: readonly Ranked[], limit: number): ListRows {
  const head = rankedHead(ranked, limit);
  const inHead = new Set<Ranked>(head);
  return {
    head,
    nearby: ranked.filter((row) => !inHead.has(row) && row.meters <= NEARBY_RADIUS_M),
  };
}
