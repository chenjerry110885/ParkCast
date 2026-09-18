import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_TYPES, type DevRequest, type DevResponse, type Next } from "./liveArtifacts.ts";

export interface LocalOptions {
  /**
   * Serve `lots.json` with every `m` and `e` key removed.
   *
   * The dev roster has both keys on all 1,089 rows, so the dev loop never
   * reaches the branch where a car park has said *nothing* about scooters or
   * charging -- and that branch is not a curiosity. It is what every roster
   * built before `edc980b` looks like, it is what the live site serves until
   * the collector is rebuilt and restarted, and it is therefore the only
   * behaviour real users will see for the length of that window. Mutation
   * tests are not a substitute for looking at it.
   *
   * A transform rather than a second checked-in file, because the fixture that
   * matters is 1,089 *real* car parks in their real ranked order -- which is
   * the thing a 25-row fixture cannot show and a 200 KB copy in git would go
   * stale against. `PARKCAST_DEV_NO_AMENITIES=1 npm run dev` in `web/`.
   */
  stripAmenities?: boolean;
}

/** Every key `parse_metadata` writes only when the feed reported it. */
const AMENITY_KEYS = ["m", "e"] as const;

/** The roster as a collector that had never heard of either field would publish it. */
function withoutAmenities(body: Uint8Array): string {
  const doc = JSON.parse(new TextDecoder().decode(body)) as { lots?: Record<string, unknown>[] };
  for (const lot of doc.lots ?? []) {
    for (const key of AMENITY_KEYS) delete lot[key];
  }
  // `roster_id` is a CRC32 of the ordered lot *ids*, so dropping a capacity
  // field leaves it correct and the grid still pairs with this roster.
  return JSON.stringify(doc);
}

/** Dev only: serve `web/.dev-artifacts/` (filled by scripts/sync-artifacts.mjs). */
export function createLocalArtifacts(dir: string, options: LocalOptions = {}) {
  return async (req: DevRequest, res: DevResponse, next: Next): Promise<void> => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const type = ARTIFACT_TYPES.get(path);
    if (type === undefined) return next();
    try {
      const raw = await readFile(join(dir, path.slice("/artifacts/".length)));
      const body =
        options.stripAmenities === true && path === "/artifacts/lots.json"
          ? withoutAmenities(raw)
          : raw;
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
