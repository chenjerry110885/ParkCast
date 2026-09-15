export const LATEST_KEY = "latest";

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

/** The two KV calls the Worker makes; the real binding satisfies this. */
export interface ArtifactsKV {
  getWithMetadata(key: string, options: { type: "arrayBuffer" }): Promise<{ value: ArrayBuffer | null; metadata: unknown }>;
  put(key: string, value: ArrayBuffer | Uint8Array, options: { metadata: StoredMeta }): Promise<void>;
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
