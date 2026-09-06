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
 *     cost = walkMin * TIME_VALUE
 *          + hourly * EXPECTED_HOURS
 *          + (1 - p) * CIRCLING_PENALTY_MIN * TIME_VALUE
 *
 * The third term is the one that converts a probability into a decision: it
 * charges a lot for the risk of arriving and finding nothing.
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
 * The cost model. Four numbers, and every one of them is a judgment
 * call rather than a measurement -- so they live here, named, where a
 * reader can find them and argue with them, instead of inline in an
 * expression where they would quietly become folklore.
 * ------------------------------------------------------------------ */

/**
 * NT$ a minute of the driver's own time is worth. NT$5/min is NT$300/hour,
 * about 1.5x Taiwan's minimum wage -- the usual multiplier for out-of-vehicle
 * time, which people dislike more than time spent sitting in the car.
 *
 * Only the *ratios* between these four constants change any ranking; scaling
 * all of them together changes nothing.
 */
export const TIME_VALUE = 5;

/**
 * How long we assume the visit lasts, in hours. Two hours is the shape of a
 * typical Taipei short-stay: a meal, a film, a shopping trip. It converts an
 * hourly rate into the money actually spent, so a cheap lot's advantage is
 * weighed at the size it really has.
 */
export const EXPECTED_HOURS = 2;

/**
 * Minutes lost when you arrive and there is no space: re-routing, driving to
 * the next candidate, and circling once you get there. Twelve minutes is a
 * middling estimate for dense Taipei; it is the most opinionated number here,
 * because it sets the exchange rate between probability and everything else. At
 * these values, a lot that is certain to have a space is worth about 12 extra
 * minutes of walking over one that is certainly full.
 */
export const CIRCLING_PENALTY_MIN = 12;

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
  /** Minutes from now until arrival. Passed through to `probability`. */
  horizonMin: number;
  /** Candidates, in grid-row order. */
  lots: readonly Lot[];
  /**
   * P(space) for the lot at `lotIndex`, or `null` for "no forecast".
   *
   * A callback rather than a `Grid` so that ranking -- the part with the
   * product judgment in it -- stays testable without building binary buffers.
   * In the app this is `(i, h) => probabilityAt(grid, i, h)`.
   */
  probability: (lotIndex: number, horizonMin: number) => number | null;
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
 * Score every lot and sort by ascending expected cost.
 *
 * Lots with no forecast are kept and ranked last -- never dropped. Silently
 * removing a car park is a worse failure than showing it with "no data": the
 * user may know something we do not, and a missing row is invisible while an
 * honest one is not. They sort among themselves by the part of the cost we can
 * still compute, walking plus money.
 */
export function rankLots(input: RankInput): Ranked[] {
  const scored = input.lots.map((lot, index) => {
    const meters = haversineMeters(input.destination, { lat: lot.y, lon: lot.x });
    const walkMin = walkMinutes(meters);
    const money = priceOf(lot.p);
    const probability = usableProbability(input.probability(index, input.horizonMin));

    // The two terms that do not depend on P -- the whole story for a lot whose
    // probability is unknown, and the sort key within that group.
    const certain = walkMin * TIME_VALUE + money.fee;
    const risk = probability === null ? null : (1 - probability) * CIRCLING_PENALTY_MIN * TIME_VALUE;

    const row: Ranked = {
      lot,
      id: lot.id,
      index,
      probability,
      hourly: money.hourly,
      perEntry: money.perEntry,
      priceKnown: money.priceKnown,
      meters,
      walkMin,
      cost: risk === null ? null : certain + risk,
    };
    return { row, certain };
  });

  scored.sort((a, b) => {
    const aUnknown = a.row.cost === null;
    const bUnknown = b.row.cost === null;
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    return (a.row.cost ?? a.certain) - (b.row.cost ?? b.certain);
  });

  return scored.map((s) => s.row);
}

/**
 * How many no-forecast lots the list will grow by to keep the ranker's promise.
 * A handful, so the rescue stays a footnote on the list rather than a second one.
 */
export const UNKNOWN_RESERVE = 5;

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
export function listRows(ranked: readonly Ranked[], limit: number): Ranked[] {
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
