export const LATEST_KEY = "latest";
export const WEEK_KEY = "week";

export interface StoredMeta {
  v: 1;
  gridLength: number;
  nLots: number;
  rosterId: number;
  generatedAt: number;
  baseDataTs: number;
  uploadedAt: number;
  gridSha256: string;
  lotsSha256: string;
}

/** Metadata for the `week` key -- the once-a-day climatology table, stored
 * independently of `StoredMeta`'s pair: its own key, its own shape, nothing
 * shared but the KV namespace itself (see kv_namespaces in wrangler.jsonc). */
export interface WeekMeta {
  v: 1;
  nLots: number;
  rosterId: number;
  builtTs: number;
  uploadedAt: number;
  sha256: string;
}

/** The two KV calls the Worker makes; the real binding satisfies this.
 * `put`'s metadata covers both keys this namespace holds -- the pair's
 * `StoredMeta` under `LATEST_KEY` and the week table's `WeekMeta` under
 * `WEEK_KEY` -- rather than widening to `unknown` and losing the shape check. */
export interface ArtifactsKV {
  getWithMetadata(key: string, options: { type: "arrayBuffer" }): Promise<{ value: ArrayBuffer | null; metadata: unknown }>;
  put(key: string, value: ArrayBuffer | Uint8Array, options: { metadata: StoredMeta | WeekMeta }): Promise<void>;
}

export interface Env {
  ARTIFACTS: ArtifactsKV;
  UPLOAD_SECRET: string;
  PRODUCTION_HOST: string;
}

const INTEGER_FIELDS = ["gridLength", "nLots", "rosterId", "generatedAt", "baseDataTs", "uploadedAt"] as const;

export function asStoredMeta(v: unknown): StoredMeta | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (m.v !== 1 || !INTEGER_FIELDS.every((k) => Number.isInteger(m[k]))) return null;
  if (typeof m.gridSha256 !== "string" || typeof m.lotsSha256 !== "string") return null;
  return m as unknown as StoredMeta;
}

const WEEK_INTEGER_FIELDS = ["nLots", "rosterId", "builtTs", "uploadedAt"] as const;

export function asWeekMeta(v: unknown): WeekMeta | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (m.v !== 1 || !WEEK_INTEGER_FIELDS.every((k) => Number.isInteger(m[k]))) return null;
  if (typeof m.sha256 !== "string") return null;
  return m as unknown as WeekMeta;
}
