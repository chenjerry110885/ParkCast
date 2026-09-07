/**
 * Read the two static artifacts the collector publishes. There is no API:
 * the browser downloads `grid.bin` and `lots.json` and does the rest locally.
 *
 * The binary layout is fixed by `src/parkcast/artifacts.py`, which packs with
 * struct format `<4sBIIHBBI` -- little-endian, no alignment padding -- so the
 * offsets below are byte-identical to little-endian `DataView` reads.
 */
import type { Grid, Lot, LotsDoc } from "./types";

/** `magic(4) version(1) generatedAt(4) baseDataTs(4) nLots(2) nHorizons(1) stepMin(1) rosterId(4)`. */
export const HEADER_SIZE = 21;

/** The schema version this client knows how to read. */
export const VERSION = 1;

const MAGIC = "PCG1";

/**
 * No forecast for this lot at this horizon.
 *
 * Emphatically *not* zero. Zero is a claim -- "certainly full" -- and 255 is
 * the absence of one. The UI renders them differently, so `probabilityAt`
 * returns `null` here and never a number.
 */
export const UNKNOWN = 255;

/**
 * Parse `grid.bin`, validating that the header describes the body it came with.
 *
 * A truncated download and a full one are otherwise indistinguishable: the
 * bytes would still parse, and every lot after the cut would silently read its
 * neighbour's row.
 */
export function parseGrid(buf: ArrayBuffer): Grid {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error(`grid.bin is ${buf.byteLength} bytes, shorter than its ${HEADER_SIZE}-byte header`);
  }
  const dv = new DataView(buf);
  const magic = new TextDecoder("ascii").decode(new Uint8Array(buf, 0, 4));
  if (magic !== MAGIC) {
    throw new Error(`grid.bin has magic ${JSON.stringify(magic)}, expected ${MAGIC}`);
  }
  const version = dv.getUint8(4);
  if (version !== VERSION) {
    throw new Error(`grid.bin is schema version ${version}, this client reads ${VERSION}`);
  }

  const generatedAt = dv.getUint32(5, true);
  const baseDataTs = dv.getUint32(9, true);
  const nLots = dv.getUint16(13, true);
  const nHorizons = dv.getUint8(15);
  const stepMin = dv.getUint8(16);
  const rosterId = dv.getUint32(17, true);

  if (nHorizons < 1 || stepMin < 1) {
    throw new Error(`grid.bin declares ${nHorizons} horizons at ${stepMin} min, both must be >= 1`);
  }

  const expected = nLots * nHorizons;
  const body = buf.byteLength - HEADER_SIZE;
  if (body !== expected) {
    throw new Error(
      `grid.bin body is ${body} bytes, header declares ${nLots} lots x ${nHorizons} horizons = ${expected}`,
    );
  }

  return {
    magic,
    version,
    generatedAt,
    baseDataTs,
    nLots,
    nHorizons,
    stepMin,
    rosterId,
    cells: new Uint8Array(buf, HEADER_SIZE, expected),
  };
}

/**
 * The column holding the forecast nearest `horizonMin` minutes ahead.
 *
 * Columns are spaced `stepMin` apart starting at `stepMin`, so column `c`
 * forecasts `(c + 1) * stepMin` minutes ahead -- there is no "now" column.
 * Requests off the grid clamp to the nearest end rather than failing: the
 * caller is a time slider, and the honest answer at +999 min is the furthest
 * forecast we have, not an exception.
 */
export function horizonColumn(grid: Grid, horizonMin: number): number {
  const column = Math.round(horizonMin / grid.stepMin) - 1;
  return Math.min(Math.max(column, 0), grid.nHorizons - 1);
}

/**
 * P(at least one free space) for one lot at one arrival time, or `null` if we
 * have no forecast for it. Never returns 0 for an unknown cell.
 */
export function probabilityAt(grid: Grid, lotIndex: number, horizonMin: number): number | null {
  if (!Number.isInteger(lotIndex) || lotIndex < 0 || lotIndex >= grid.nLots) {
    throw new RangeError(`lot index ${lotIndex} is outside 0..${grid.nLots - 1}`);
  }
  const cell = grid.cells[lotIndex * grid.nHorizons + horizonColumn(grid, horizonMin)]!;
  return cell === UNKNOWN ? null : cell / 100;
}

/**
 * Where the artifacts live, under a deployment base.
 *
 * `import.meta.env.BASE_URL` is a URL *prefix*, not a path: it is `/` in dev,
 * `/ParkCast/` under a sub-path, and an absolute `https://cdn.example/` when the
 * static files are served from somewhere other than the page. Tidying the join
 * by collapsing every repeated slash -- the obvious one-liner, and what this
 * used to do -- rewrites `https://` as `https:/`, which no browser resolves and
 * which cannot show up in dev, where the base has no scheme to break.
 *
 * Only the seam between the two halves needs normalising, so only the seam is
 * touched.
 */
export function artifactsBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/artifacts`;
}

function artifactUrl(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name}`;
}

async function fetchGrid(base: string, init?: RequestInit): Promise<Grid> {
  const res = await fetch(artifactUrl(base, "grid.bin"), init);
  if (!res.ok) throw new Error(`grid.bin: HTTP ${res.status}`);
  return parseGrid(await res.arrayBuffer());
}

/**
 * Whether a row can be placed on the ground and against the grid.
 *
 * Two things are read out of a `Lot` without any further checking, and neither
 * survives a missing value quietly:
 *
 *   - **`y`/`x` go straight into a distance.** JSON `null` coerces to 0, and
 *     (0, 0) is 13,000 km from Taipei in the Gulf of Guinea -- a row that would
 *     render as `13155.6 km` and, worse, drag the map's bounds across the
 *     Atlantic. `undefined` is louder but no better: `NaN` metres, and a `NaN`
 *     sort key, which makes the *whole ranking* order-dependent.
 *   - **`i` names the grid row.** It is redundant with the array position and
 *     always equal to it in what the encoder writes, but it is what makes
 *     dropping a row safe: the survivors still know which forecast is theirs.
 *     A row that disagrees cannot be scored, because we no longer know which
 *     of the two numbers is the lie.
 *
 * A failing row is dropped rather than repaired -- there is nothing to repair
 * it from -- and dropped rather than thrown on, because one bad row out of
 * a thousand should cost the user one car park, not the whole city.
 */
function isPlaceable(lot: Lot, position: number): boolean {
  return lot.i === position && Number.isFinite(lot.y) && Number.isFinite(lot.x);
}

async function fetchLots(base: string, init?: RequestInit): Promise<LotsDoc> {
  const res = await fetch(artifactUrl(base, "lots.json"), init);
  if (!res.ok) throw new Error(`lots.json: HTTP ${res.status}`);
  const doc = (await res.json()) as LotsDoc;
  if (doc.v !== VERSION) {
    throw new Error(`lots.json is schema version ${doc.v}, this client reads ${VERSION}`);
  }
  if (!Array.isArray(doc.lots) || doc.lots.length !== doc.n_lots) {
    throw new Error(`lots.json holds ${doc.lots?.length} rows but declares n_lots ${doc.n_lots}`);
  }

  // After the length check, never before it: a truncated download and a row we
  // chose to drop must stay distinguishable, and only the first is an error.
  const placeable = doc.lots.filter(isPlaceable);
  if (placeable.length === doc.lots.length) return doc;
  // `n_lots` is left describing the roster the grid was built against, which is
  // what makes `Lot.i` meaningful; `lots` is now shorter than it on purpose.
  return { ...doc, lots: placeable };
}

/**
 * Fetch both artifacts and hand back a pair that describes the same roster.
 *
 * The two files are written independently, so a client can fetch one either
 * side of a republish. The check is on `rosterId` -- a CRC32 of the ordered lot
 * ids -- and deliberately *not* on `generatedAt`: that stamp changes every five
 * minutes while the roster almost never does, so comparing it would reject every
 * safe cross-tick pair and force a re-download of the 186 KB file each tick,
 * defeating the caching `rosterId` exists to allow.
 *
 * On a real mismatch the roster genuinely moved, and the stale half is almost
 * always the cached `lots.json` -- so the single retry bypasses the HTTP cache,
 * which a plain re-fetch would not.
 */
export async function loadArtifacts(base: string): Promise<{ grid: Grid; lots: LotsDoc }> {
  const [grid, cached] = await Promise.all([fetchGrid(base), fetchLots(base)]);
  if (cached.roster_id === grid.rosterId) return { grid, lots: cached };

  const fresh = await fetchLots(base, { cache: "reload" });
  if (fresh.roster_id !== grid.rosterId) {
    throw new Error(
      `roster mismatch after retry: grid.bin ${grid.rosterId}, lots.json ${fresh.roster_id}`,
    );
  }
  return { grid, lots: fresh };
}
