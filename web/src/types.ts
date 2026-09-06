/**
 * The shapes of the two static artifacts the collector publishes.
 *
 * These mirror `src/parkcast/artifacts.py`. `lots.json` uses one-letter keys
 * deliberately -- at ~1,100 lots that is the difference between a 186 KB file
 * and something several times larger -- so the short names are kept verbatim
 * here rather than renamed, to keep the wire format greppable from both sides.
 */

/** Parsed form of a lot's free-text Chinese fare. */
export type PriceKind = "exact" | "range" | "entry" | "unknown";

export interface Price {
  /** `entry` prices are per entry, not per hour; `unknown` carries no numbers. */
  k: PriceKind;
  /** NT$/hour, or NT$/entry when `k === "entry"`. Absent when `k === "unknown"`. */
  lo?: number | null;
  hi?: number | null;
}

/** One row of `lots.json`, index-aligned with row `i` of the grid. */
export interface Lot {
  /** Row index into the grid. Redundant with array position, and checked. */
  i: number;
  /** Feed id, e.g. `TPE0001`. */
  id: string;
  /** Name. */
  n: string;
  /** District, e.g. `中山區`. */
  a: string;
  /** WGS84 latitude. */
  y: number;
  /** WGS84 longitude. */
  x: number;
  /** Car capacity. Null where the feed does not publish one. */
  c: number | null;
  /** Operator category, e.g. `民營停車場`. */
  t: string;
  p: Price;
}

export interface LotsDoc {
  /** Schema version of this document. */
  v: number;
  /** Unix seconds the artifact was written. */
  generated_at: number;
  /** Unix seconds of the reading the forecast was made from. */
  base_data_ts: number;
  n_lots: number;
  /** CRC32 of the ordered lot ids. The only field a grid must agree with. */
  roster_id: number;
  lots: Lot[];
}

/** A parsed `grid.bin`: the header, plus the raw percentage matrix. */
export interface Grid {
  magic: string;
  version: number;
  /** Unix seconds the artifact was written. */
  generatedAt: number;
  /**
   * Unix seconds of the reading the forecast was made from. Always distinct
   * from `generatedAt`: collapsing them would hide how stale the input is.
   */
  baseDataTs: number;
  nLots: number;
  nHorizons: number;
  /** Minutes between horizon columns. Column `c` forecasts `(c + 1) * stepMin`. */
  stepMin: number;
  /** CRC32 of the ordered lot ids. Pairs this grid with a `lots.json`. */
  rosterId: number;
  /** Row-major, `nLots * nHorizons` bytes. 0-100, or `UNKNOWN`. */
  cells: Uint8Array;
}
