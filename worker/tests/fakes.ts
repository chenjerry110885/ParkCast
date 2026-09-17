import type { ArtifactsKV, StoredMeta, WeekMeta } from "../src/kv";

export class FakeKV implements ArtifactsKV {
  reads = 0;
  writes = 0;
  failReads = false;
  private readonly entries = new Map<string, { value: ArrayBuffer; metadata: unknown }>();

  async getWithMetadata(key: string): Promise<{ value: ArrayBuffer | null; metadata: unknown }> {
    this.reads++;
    if (this.failReads) throw new Error("kv unavailable");
    const entry = this.entries.get(key);
    return { value: entry ? entry.value.slice(0) : null, metadata: entry ? entry.metadata : null };
  }

  async put(key: string, value: ArrayBuffer | Uint8Array, options: { metadata: StoredMeta }): Promise<void> {
    this.writes++;
    const copy = value instanceof Uint8Array ? (value.slice().buffer as ArrayBuffer) : value.slice(0);
    this.entries.set(key, { value: copy, metadata: options.metadata });
  }

  seed(key: string, bytes: Uint8Array, metadata: unknown): void {
    this.entries.set(key, { value: bytes.slice().buffer as ArrayBuffer, metadata });
  }
}

export interface Pair { grid: Uint8Array; lots: Uint8Array; baseDataTs: number; generatedAt: number; nLots: number; rosterId: number }

export function makePair(o: { baseDataTs: number; generatedAt?: number; nLots?: number; rosterId?: number }): Pair {
  const nLots = o.nLots ?? 3;
  const generatedAt = o.generatedAt ?? o.baseDataTs + 200;
  const rosterId = o.rosterId ?? 42;
  const grid = new Uint8Array(21 + nLots * 24);
  const dv = new DataView(grid.buffer);
  grid.set([0x50, 0x43, 0x47, 0x31], 0);
  dv.setUint8(4, 1);
  dv.setUint32(5, generatedAt, true);
  dv.setUint32(9, o.baseDataTs, true);
  dv.setUint16(13, nLots, true);
  dv.setUint8(15, 24);
  dv.setUint8(16, 5);
  dv.setUint32(17, rosterId, true);
  const rows = Array.from({ length: nLots }, (_unused, i) => ({
    i, id: `TPE${i}`, n: `lot ${i}`, a: "信義區", y: 25.03, x: 121.56, c: 50, t: "民營停車場",
    p: { k: "exact", lo: 40, hi: 40 },
  }));
  const lots = new TextEncoder().encode(JSON.stringify({
    v: 1, generated_at: generatedAt, base_data_ts: o.baseDataTs, n_lots: nLots, roster_id: rosterId, lots: rows,
  }));
  return { grid, lots, baseDataTs: o.baseDataTs, generatedAt, nLots, rosterId };
}

export function joined(pair: Pair): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(pair.grid.byteLength + pair.lots.byteLength);
  out.set(pair.grid, 0);
  out.set(pair.lots, pair.grid.byteLength);
  return out;
}

export function metaFor(pair: Pair, overrides: Partial<StoredMeta> = {}): StoredMeta {
  return {
    v: 1, gridLength: pair.grid.byteLength, nLots: pair.nLots, rosterId: pair.rosterId,
    generatedAt: pair.generatedAt, baseDataTs: pair.baseDataTs, uploadedAt: pair.baseDataTs + 250,
    gridSha256: "g".repeat(64), lotsSha256: "l".repeat(64), ...overrides,
  };
}

export interface Week { week: Uint8Array<ArrayBuffer>; nLots: number; rosterId: number; builtTs: number }

const WEEK_BUCKETS = 336;

/** A well-formed `week.bin`: `PCW1` header (see `WEEK_HEADER_FORMAT` in
 * artifacts.py) followed by `nLots * WEEK_BUCKETS` cells of a plausible
 * (probability, support) pair -- never zero bytes, so a test that forgets to
 * check the body cannot pass by accident. */
export function makeWeek(o: { builtTs: number; nLots?: number; rosterId?: number }): Week {
  const nLots = o.nLots ?? 3;
  const rosterId = o.rosterId ?? 42;
  const week = new Uint8Array(18 + nLots * WEEK_BUCKETS * 2);
  const dv = new DataView(week.buffer);
  week.set([0x50, 0x43, 0x57, 0x31], 0); // "PCW1"
  dv.setUint8(4, 1);
  dv.setUint32(5, o.builtTs, true);
  dv.setUint16(9, nLots, true);
  dv.setUint16(11, WEEK_BUCKETS, true);
  dv.setUint8(13, 30);
  dv.setUint32(14, rosterId, true);
  for (let i = 18; i < week.length; i += 2) {
    week[i] = 50; // 50% probability
    week[i + 1] = 6; // support: one week's worth of five-minute readings in this bucket
  }
  return { week, nLots, rosterId, builtTs: o.builtTs };
}

export function weekMetaFor(w: Week, overrides: Partial<WeekMeta> = {}): WeekMeta {
  return {
    v: 1, nLots: w.nLots, rosterId: w.rosterId, builtTs: w.builtTs,
    uploadedAt: w.builtTs + 10, sha256: "w".repeat(64), ...overrides,
  };
}
