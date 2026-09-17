import type { LatestCache } from "./cache";
import { TEXT, respond } from "./http";
import { WEEK_KEY, asWeekMeta, type Env } from "./kv";

export type Part = "grid" | "lots";

export const ARTIFACT_PATHS: Readonly<Record<string, Part>> = {
  "/artifacts/grid.bin": "grid",
  "/artifacts/lots.json": "lots",
};

export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((token) => {
    const t = token.trim();
    return t === "*" || t.replace(/^W\//, "") === bare;
  });
}

export async function serveArtifact(request: Request, part: Part, env: Env, cache: LatestCache, nowSec: number): Promise<Response> {
  const latest = await cache.get(env.ARTIFACTS);
  if (latest === null) return respond(503, "No forecast yet", { ...TEXT, "Retry-After": "300" });
  const { bytes, meta } = latest;
  const body = part === "grid" ? bytes.subarray(0, meta.gridLength) : bytes.subarray(meta.gridLength);
  // lots.json changes rarely and the app bypasses the cache when the roster moves;
  // grid.bin is cached only until the next publish is due.
  const maxAge = part === "lots" ? 900 : Math.min(300, Math.max(0, meta.generatedAt + 330 - nowSec));
  const headers = {
    "Content-Type": part === "grid" ? "application/octet-stream" : "application/json; charset=utf-8",
    "Cache-Control": `max-age=${maxAge}`,
    ETag: `"${part === "grid" ? meta.gridSha256 : meta.lotsSha256}"`,
  };
  if (etagMatches(request.headers.get("If-None-Match"), headers.ETag)) return respond(304, null, headers);
  return respond(200, request.method === "HEAD" ? null : body, headers);
}

/** `week.bin`: its own KV key, read fresh every time -- it is rebuilt once a
 * day and fetched lazily by the app, nowhere near the request volume `grid`/
 * `lots` see, so it does not need `LatestCache`'s per-isolate memoisation.
 * `max-age=3600` is fixed, not computed like the pair's: the table changes
 * daily, and a stale hour of climatology is not a stale forecast. */
export async function serveWeek(request: Request, env: Env): Promise<Response> {
  const stored = await env.ARTIFACTS.getWithMetadata(WEEK_KEY, { type: "arrayBuffer" });
  const meta = asWeekMeta(stored.metadata);
  if (stored.value === null || meta === null) return respond(503, "No forecast yet", { ...TEXT, "Retry-After": "300" });
  const headers = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "max-age=3600",
    ETag: `"${meta.sha256}"`,
  };
  if (etagMatches(request.headers.get("If-None-Match"), headers.ETag)) return respond(304, null, headers);
  return respond(200, request.method === "HEAD" ? null : stored.value, headers);
}
