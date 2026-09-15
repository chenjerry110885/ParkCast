#!/usr/bin/env node
/**
 * Build the self-hosted Taipei basemap: extract `web/basemap-src/taipei.pmtiles`
 * from the public Protomaps planet build, then unpack it into one static file per
 * tile under `web/public/basemap/tiles/` (scripts/unpack-tiles.mjs).
 *
 * ParkCast is a static site with no server and no secrets, so a hosted tile
 * provider (MapTiler, Mapbox, Stadia) is out -- they all require an API key
 * and a billing account. The archive itself is not served: Cloudflare's static
 * hosting ignores the Range requests a `.pmtiles` read needs, so the site serves
 * the unpacked tiles instead. See docs/basemap.md for the full story.
 *
 * This script does NOT download or run anything on its own. The extractor is
 * a third-party binary (go-pmtiles), and fetching and executing one without
 * a human looking at it is a decision this script does not get to make. So:
 *
 *   - if a `pmtiles` binary is found (at PMTILES_BIN, or on PATH), this
 *     script runs the extract and reports the resulting file size.
 *   - if not, it prints the exact release to fetch, the checksum to verify
 *     it against, and the steps to run manually -- then exits non-zero
 *     without touching the network.
 *
 * Usage:
 *   node scripts/build-basemap.mjs                       # binary on PATH
 *   PMTILES_BIN=/path/to/pmtiles node scripts/build-basemap.mjs
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const OUT_PATH = join(repoRoot, "web", "basemap-src", "taipei.pmtiles");

// Facts measured 2026-09-06 -- see docs/basemap.md. Do not re-derive without
// re-running the extract; the source planet build is versioned by date and
// Protomaps deletes old ones (20260901 was gone by 2026-09-15). On a 404, pick
// a current 4.x build from https://build-metadata.protomaps.dev/builds.json.
const SOURCE_URL = "https://build.protomaps.com/20260914.pmtiles";
const BBOX = "121.4433,24.9576,121.6405,25.1999"; // all 1,088 lots plus ~2 km
const MAXZOOM = 15; // the planet build's own ceiling at this bbox

const GO_PMTILES_VERSION = "v1.31.2";
const RELEASE_ASSET = "go-pmtiles_1.31.2_Windows_x86_64.zip";
const RELEASE_URL = `https://github.com/protomaps/go-pmtiles/releases/download/${GO_PMTILES_VERSION}/${RELEASE_ASSET}`;
const RELEASE_SHA256 =
  "a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1";

function findOnPath(name) {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
  const candidates =
    process.platform === "win32"
      ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`]
      : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function resolveBinary() {
  if (process.env.PMTILES_BIN) {
    if (!existsSync(process.env.PMTILES_BIN)) {
      console.error(
        `build-basemap: PMTILES_BIN is set to ${process.env.PMTILES_BIN}, but nothing exists there.`,
      );
      process.exit(1);
    }
    return process.env.PMTILES_BIN;
  }
  return findOnPath("pmtiles");
}

function printMissingBinaryInstructions() {
  console.error(`
build-basemap: no \`pmtiles\` binary found on PATH or at PMTILES_BIN.

This script will not download or run one for you -- fetching and executing a
third-party binary is a decision for a human, not a build script. Here is
everything needed to do it yourself:

  1. Download (Windows x86_64):
     ${RELEASE_URL}

  2. Verify the download before running it. Expected SHA-256:
     ${RELEASE_SHA256}

     PowerShell:
       Get-FileHash .\\${RELEASE_ASSET} -Algorithm SHA256
     Compare the "Hash" field against the value above -- it must match exactly.

     IMPORTANT: this checksum is GitHub's digest of the stored release asset.
     It proves the file you downloaded is byte-identical to what GitHub is
     serving -- it does NOT prove the maintainer built or published that
     asset honestly, and it is not a substitute for an independent signature.
     Treat it as tamper-evidence in transit, nothing more.

     (On another platform, get that platform's asset and checksum from
     https://github.com/protomaps/go-pmtiles/releases/tag/${GO_PMTILES_VERSION}
     -- only the Windows x86_64 checksum is recorded here.)

  3. Once verified, unzip it and either:
       a) put the \`pmtiles\` (or \`pmtiles.exe\`) binary on your PATH, or
       b) set PMTILES_BIN to its full path, e.g.:
          PMTILES_BIN=C:\\tools\\pmtiles\\pmtiles.exe node scripts/build-basemap.mjs

  4. Re-run this script. It will extract:
       source: ${SOURCE_URL}
       bbox:   ${BBOX}
       output: web/basemap-src/taipei.pmtiles  (~23 MB), then web/public/basemap/tiles/
`);
  process.exit(1);
}

const bin = resolveBinary();
if (!bin) {
  printMissingBinaryInstructions();
}

mkdirSync(join(repoRoot, "web", "basemap-src"), { recursive: true });

console.log(`build-basemap: using ${bin}`);
console.log(`build-basemap: extracting bbox ${BBOX} (maxzoom ${MAXZOOM}) from`);
console.log(`  ${SOURCE_URL}`);

execFileSync(
  bin,
  [
    "extract",
    SOURCE_URL,
    OUT_PATH,
    `--bbox=${BBOX}`,
    "--minzoom=0",
    `--maxzoom=${MAXZOOM}`,
  ],
  { stdio: "inherit" },
);

const { size } = statSync(OUT_PATH);
const mb = (size / (1024 * 1024)).toFixed(1);
console.log(`build-basemap: wrote web/basemap-src/taipei.pmtiles (${size} bytes, ${mb} MB)`);

const { unpackTiles } = await import("./unpack-tiles.mjs");
const unpacked = await unpackTiles();
console.log(
  `build-basemap: unpacked ${unpacked.count} tiles (${(unpacked.bytes / 1048576).toFixed(1)} MB) to web/public/basemap/tiles/`,
);

const { buildPlaceIndex } = await import("./build-place-index.mjs");
const index = await buildPlaceIndex();
console.log(`build-basemap: place index ${index.rows} rows, ${(index.gzipBytes / 1024).toFixed(0)} KB gzipped -> web/public/places/taipei.json`);
