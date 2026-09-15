import { LATEST_KEY, asStoredMeta, type ArtifactsKV, type StoredMeta } from "./kv";

export const CACHE_TTL_MS = 60_000;

export interface Latest {
  /** `ArrayBuffer`-backed, so a slice is a valid `Response` body under TS 6's DOM types. */
  bytes: Uint8Array<ArrayBuffer>;
  meta: StoredMeta;
}

/** The latest pair, re-read from KV at most once a minute per isolate. */
export class LatestCache {
  private latest: Latest | null = null;
  private readAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<Latest | null> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  get(kv: ArtifactsKV): Promise<Latest | null> {
    if (this.now() - this.readAt < CACHE_TTL_MS) return Promise.resolve(this.latest);
    if (this.inflight !== null) return this.inflight;
    this.inflight = kv.getWithMetadata(LATEST_KEY, { type: "arrayBuffer" }).then(
      ({ value, metadata }) => {
        const meta = asStoredMeta(metadata);
        const bytes = value === null ? null : new Uint8Array(value);
        this.latest = bytes !== null && meta !== null && meta.gridLength <= bytes.byteLength ? { bytes, meta } : null;
        this.readAt = this.now();
        this.inflight = null;
        return this.latest;
      },
      (error: unknown) => {
        this.inflight = null;
        throw error;
      },
    );
    return this.inflight;
  }

  set(latest: Latest): void {
    this.latest = latest;
    this.readAt = this.now();
    this.inflight = null;
  }
}
