import type { StoredMeta } from "./kv";

export const HEADER_SIZE = 21;
export const MAX_LOTS = 4000;
export const N_HORIZONS = 24;
export const STEP_MIN = 5;
export const GRID_VERSION = 1;
export const LOTS_VERSION = 1;
export const MAX_STRING = 200;
/** Same box as `LAT_MIN..LON_MAX` in src/parkcast/config.py. */
export const BBOX = { latMin: 24.5, latMax: 25.5, lonMin: 121.0, lonMax: 122.5 } as const;
export const FUTURE_TOLERANCE_SEC = 600;
export const MAX_BASE_AGE_SEC = 6 * 3600;
export const MIN_UPLOAD_SPACING_SEC = 180;
export const ROSTER_FLOOR = 0.5;
export const ROSTER_ESCAPE_SEC = 24 * 3600;
const PRICE_KINDS: ReadonlySet<string> = new Set(["exact", "range", "entry", "unknown"]);

export interface GridHeader {
  version: number;
  generatedAt: number;
  baseDataTs: number;
  nLots: number;
  nHorizons: number;
  stepMin: number;
  rosterId: number;
}

export type Reject = "future" | "too-old" | "stale" | "too-soon" | "roster-shrink";
export type PairResult = { ok: true; header: GridHeader } | { ok: false };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const shortString = (v: unknown): boolean => typeof v === "string" && v.length <= MAX_STRING;

const within = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

const numberOrNull = (v: unknown): boolean =>
  v === null || (typeof v === "number" && Number.isFinite(v));

export function parseGridHeader(grid: Uint8Array): GridHeader | null {
  if (grid.byteLength < HEADER_SIZE) return null;
  if (grid[0] !== 0x50 || grid[1] !== 0x43 || grid[2] !== 0x47 || grid[3] !== 0x31) return null;
  const dv = new DataView(grid.buffer, grid.byteOffset, grid.byteLength);
  return {
    version: dv.getUint8(4),
    generatedAt: dv.getUint32(5, true),
    baseDataTs: dv.getUint32(9, true),
    nLots: dv.getUint16(13, true),
    nHorizons: dv.getUint8(15),
    stepMin: dv.getUint8(16),
    rosterId: dv.getUint32(17, true),
  };
}

function validRow(row: unknown, index: number): boolean {
  if (!isRecord(row) || row.i !== index) return false;
  if (!shortString(row.id) || !shortString(row.n) || !shortString(row.a) || !shortString(row.t)) {
    return false;
  }
  if (!within(row.y, BBOX.latMin, BBOX.latMax) || !within(row.x, BBOX.lonMin, BBOX.lonMax)) {
    return false;
  }
  if (!(row.c === null || (Number.isInteger(row.c) && (row.c as number) >= 0))) return false;
  const price = row.p;
  if (!isRecord(price) || typeof price.k !== "string" || !PRICE_KINDS.has(price.k)) return false;
  if (price.k !== "unknown" && !(numberOrNull(price.lo) && numberOrNull(price.hi))) return false;
  if ("u" in row && !Number.isInteger(row.u)) return false;
  return true;
}

export function validatePair(grid: Uint8Array, lotsBytes: Uint8Array): PairResult {
  const h = parseGridHeader(grid);
  if (h === null || h.version !== GRID_VERSION || h.nHorizons !== N_HORIZONS || h.stepMin !== STEP_MIN) {
    return { ok: false };
  }
  if (h.nLots < 1 || h.nLots > MAX_LOTS || grid.byteLength !== HEADER_SIZE + h.nLots * h.nHorizons) {
    return { ok: false };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lotsBytes));
  } catch {
    return { ok: false };
  }
  if (
    !isRecord(doc) ||
    doc.v !== LOTS_VERSION ||
    doc.n_lots !== h.nLots ||
    doc.roster_id !== h.rosterId ||
    doc.generated_at !== h.generatedAt ||
    doc.base_data_ts !== h.baseDataTs
  ) {
    return { ok: false };
  }
  const rows = doc.lots;
  if (!Array.isArray(rows) || rows.length !== h.nLots) return { ok: false };
  for (let i = 0; i < rows.length; i++) {
    if (!validRow(rows[i], i)) return { ok: false };
  }
  return { ok: true, header: h };
}

export function checkOrder(h: GridHeader, stored: StoredMeta | null, now: number): Reject | null {
  if (h.baseDataTs > now + FUTURE_TOLERANCE_SEC || h.generatedAt > now + FUTURE_TOLERANCE_SEC) {
    return "future";
  }
  if (h.baseDataTs < now - MAX_BASE_AGE_SEC || h.generatedAt < h.baseDataTs - FUTURE_TOLERANCE_SEC) {
    return "too-old";
  }
  // A stored value dated in the future is void: it must never lock out real uploads.
  if (stored === null || stored.baseDataTs > now + FUTURE_TOLERANCE_SEC) return null;
  const newer =
    h.baseDataTs > stored.baseDataTs ||
    (h.baseDataTs === stored.baseDataTs && h.generatedAt > stored.generatedAt);
  if (!newer) return "stale";
  if (now - stored.uploadedAt < MIN_UPLOAD_SPACING_SEC) return "too-soon";
  if (h.nLots < ROSTER_FLOOR * stored.nLots && now - stored.uploadedAt <= ROSTER_ESCAPE_SEC) {
    return "roster-shrink";
  }
  return null;
}
