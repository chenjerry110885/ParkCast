#!/usr/bin/env node
/**
 * Read-only checks against the live site after a deploy (spec §8.3 step 9).
 *
 *   node scripts/smoke-live.mjs https://parkcast.<name>.workers.dev
 *
 * Freshness is a warning, never a failure: the user pauses the collector at times.
 * The preview-host PUT refusal is covered by the Worker's unit tests, not here.
 *
 * Never throws. release.mjs calls this right after promoting a new version live;
 * a network hiccup (DNS, TLS, a reset, a hang) or a malformed response body must
 * turn into a failure entry here, not an unhandled rejection that would skip the
 * retry loop and the automatic rollback in release.mjs.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MUST_404 = ["/src/main.tsx", "/assets/index.js.map", "/.env", "/_headers", "/wp-login.php", "/artifacts/grid.bin.tmp"];
// The map's roads and its labels: one tile and one glyph file, by HEAD.
const MUST_SERVE = [
  "/basemap/tiles/0/0/0.pbf",
  "/basemap/fonts/Noto%20Sans%20Regular/0-255.pbf",
  // The offline place index behind the search box.
  "/places/taipei.json",
];
const TIMEOUT_MS = 15_000;

/**
 * How old `week.bin` may be before the smoke test says so.
 *
 * The table is rebuilt once a day, so 48 h is two missed rebuilds -- past the
 * point where a single skipped run or a clock straddling midnight explains it,
 * and well inside the horizon where the climatology itself is still useful
 * (support only grows, so an old table understates confidence rather than
 * overstating it). A warning either way: see the `week.bin` block below.
 */
const WEEK_MAX_AGE_H = 48;

export async function smoke(origin, { fetchImpl = fetch, now = Date.now } = {}) {
  const failures = [];
  const warnings = [];

  // Every request gets a timeout, and a rejection (DNS/TLS/reset/timeout) is
  // recorded as a failure naming the path and the error, never headers or
  // tokens -- and never re-thrown, so the rest of the checks still run.
  async function get(path, init = {}) {
    try {
      return await fetchImpl(origin + path, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
    } catch (err) {
      failures.push(`${path} request failed: ${err.name}: ${err.message}`);
      return null;
    }
  }

  const root = await get("/");
  if (root !== null) {
    if (root.status !== 200) failures.push(`/ answered ${root.status}`);
    const csp = root.headers.get("content-security-policy") ?? "";
    if (!csp.includes("default-src 'self'") || csp.includes("unsafe-inline")) failures.push("/ lacks the site Content-Security-Policy");
    if (root.headers.get("x-content-type-options") !== "nosniff") failures.push("/ lacks X-Content-Type-Options: nosniff");
  }

  const sw = await get("/sw.js");
  if (sw !== null && !(sw.headers.get("cache-control") ?? "").includes("no-cache")) failures.push("/sw.js is not served no-cache");

  const grid = await get("/artifacts/grid.bin");
  const lots = await get("/artifacts/lots.json");
  if (grid !== null && lots !== null) {
    if (grid.status === 503 && lots.status === 503) {
      // Nothing uploaded yet: the first release goes out before the collector uploads.
      warnings.push("no forecast stored yet (first release, or the collector is not uploading)");
    } else if (grid.status !== 200 || lots.status !== 200) {
      failures.push(`forecast files answered ${grid.status} and ${lots.status}`);
    } else {
      try {
        const bytes = new Uint8Array(await grid.arrayBuffer());
        const doc = JSON.parse(await lots.text());
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const magic = String.fromCharCode(...bytes.subarray(0, 4));
        if (bytes.byteLength < 21 || magic !== "PCG1" || dv.getUint32(17, true) !== doc.roster_id) {
          failures.push("grid.bin and lots.json do not pair");
        } else {
          const ageMin = (now() / 1000 - dv.getUint32(9, true)) / 60;
          if (ageMin > 15) warnings.push(`forecast is ${Math.round(ageMin)} min old (collector paused?)`);
        }
      } catch {
        // Unparseable body (bad JSON, truncated/short bytes, ...): a pairing
        // mismatch, not a crash.
        failures.push("grid.bin and lots.json do not pair");
      }
    }
  }

  // `week.bin`, by HEAD: it is 715 KB and nothing here needs its body.
  //
  // Deliberately not in MUST_SERVE, which fails. This artifact is published on
  // its own daily cadence, is fetched lazily by the app, and is additive by
  // design -- a site without one works exactly as it did before the table
  // existed, answering inside `grid.bin`'s window and saying "no data" past it.
  // Failing the release over it would roll back a perfectly good deploy because
  // the collector had not got round to a once-a-day job yet. So: warn, the same
  // way a stale forecast warns, because somebody should look and nobody should
  // be paged.
  const week = await get("/artifacts/week.bin", { method: "HEAD" });
  if (week !== null) {
    if (week.status !== 200) {
      warnings.push(`week.bin answered ${week.status} (no forecast past the grid's two-hour window)`);
    } else {
      // `Last-Modified` carries the table's own `builtTs` (worker/src/serve.ts)
      // -- when the climatology was built, not when the bytes were re-uploaded,
      // so a re-PUT of yesterday's table cannot read as fresh.
      const builtMs = Date.parse(week.headers.get("last-modified") ?? "");
      if (Number.isNaN(builtMs)) {
        warnings.push("week.bin does not say when it was built");
      } else {
        const ageH = (now() - builtMs) / 3_600_000;
        if (ageH > WEEK_MAX_AGE_H) warnings.push(`week table is ${Math.round(ageH)} h old (daily rebuild stalled?)`);
      }
    }
  }

  for (const path of MUST_SERVE) {
    const res = await get(path, { method: "HEAD" });
    if (res !== null && res.status !== 200) failures.push(`${path} answered ${res.status}, expected 200`);
  }

  for (const path of MUST_404) {
    const res = await get(path);
    if (res !== null && res.status !== 404) failures.push(`${path} answered ${res.status}, expected 404`);
  }

  const put = await get("/artifacts/latest", { method: "PUT", body: "x", headers: { "X-Grid-Length": "21" } });
  if (put !== null && put.status !== 401) failures.push(`unauthenticated PUT answered ${put.status}, expected 401`);

  return { failures, warnings };
}

async function main() {
  const origin = new URL(process.argv[2] ?? "").origin;
  const { failures, warnings } = await smoke(origin);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (failures.length > 0) {
    console.error(`smoke test FAILED:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("smoke test passed");
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) await main();
