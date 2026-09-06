#!/usr/bin/env node
/**
 * Copy the collector's published artifacts into `web/public/artifacts/` for dev.
 *
 * The app never reads `data/` directly. `data/` is gitignored, the collector
 * rewrites it every five minutes, and Vite would serve a half-written file
 * mid-copy; this is an explicit, one-directional snapshot the dev server can
 * hold still. It is read-only with respect to `data/` -- nothing here writes
 * back into the collector's output.
 *
 * Usage: node scripts/sync-artifacts.mjs   (from anywhere; paths are repo-relative)
 */
import { copyFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(repoRoot, "data", "artifacts");
const dest = join(repoRoot, "web", "public", "artifacts");
const NAMES = ["grid.bin", "lots.json"];

mkdirSync(dest, { recursive: true });

for (const name of NAMES) {
  const from = join(src, name);
  let bytes;
  try {
    bytes = statSync(from).size;
  } catch {
    console.error(
      `sync-artifacts: ${from} is missing. Run the collector, or the publish step, first.`,
    );
    process.exit(1);
  }
  // Copy to a temp name and rename, so the dev server never serves a partial
  // file -- the same guarantee the Python publisher gives its own readers.
  const tmp = join(dest, `${name}.tmp`);
  copyFileSync(from, tmp);
  renameSync(tmp, join(dest, name));
  console.log(`sync-artifacts: ${name} -> web/public/artifacts/${name} (${bytes} bytes)`);
}
