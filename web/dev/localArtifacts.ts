import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_TYPES, type DevRequest, type DevResponse, type Next } from "./liveArtifacts.ts";

/** Dev only: serve `web/.dev-artifacts/` (filled by scripts/sync-artifacts.mjs). */
export function createLocalArtifacts(dir: string) {
  return async (req: DevRequest, res: DevResponse, next: Next): Promise<void> => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const type = ARTIFACT_TYPES.get(path);
    if (type === undefined) return next();
    try {
      const body = await readFile(join(dir, path.slice("/artifacts/".length)));
      res.statusCode = 200;
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.statusCode = 404;
      res.end("no local artifacts: run scripts/sync-artifacts.mjs, or set PARKCAST_LIVE_ORIGIN");
    }
  };
}
