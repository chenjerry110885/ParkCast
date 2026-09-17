import { LatestCache } from "./cache";
import { TEXT, notFound, respond } from "./http";
import type { Env } from "./kv";
import { ARTIFACT_PATHS, WEEK_PATH, serveArtifact, serveWeek } from "./serve";
import { handleUpload, handleWeekUpload } from "./upload";

const isolateCache = new LatestCache();

export async function route(request: Request, env: Env, cache: LatestCache, nowSec: number): Promise<Response> {
  const url = new URL(request.url);
  // Before `env` is touched: scanners probing random paths cost nothing further.
  if (!url.pathname.startsWith("/artifacts/")) return notFound();

  if (url.pathname === "/artifacts/latest") {
    if (request.method !== "PUT") return respond(405, "Method not allowed", { ...TEXT, Allow: "PUT" });
    // Preview URLs have their own hostnames; only the production hostname may write.
    if (url.hostname !== env.PRODUCTION_HOST) return notFound();
    return handleUpload(request, env, cache, nowSec);
  }

  // Unlike the pair, week.bin's own path both accepts its daily upload and
  // serves it -- one artifact, one path, read on GET/HEAD and written on PUT.
  if (url.pathname === WEEK_PATH) {
    if (request.method === "PUT") {
      if (url.hostname !== env.PRODUCTION_HOST) return notFound();
      return handleWeekUpload(request, env, nowSec);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond(405, "Method not allowed", { ...TEXT, Allow: "GET, HEAD, PUT" });
    }
    return serveWeek(request, env);
  }

  const part = ARTIFACT_PATHS[url.pathname];
  if (part === undefined) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return respond(405, "Method not allowed", { ...TEXT, Allow: "GET, HEAD" });
  }
  return serveArtifact(request, part, env, cache, nowSec);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env, isolateCache, Math.floor(Date.now() / 1000));
    } catch {
      return respond(500, "Internal error", TEXT);
    }
  },
};
