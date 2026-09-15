#!/usr/bin/env node
/**
 * Unpack the basemap archive into one static file per tile,
 * `web/public/basemap/tiles/{z}/{x}/{y}.pbf` (docs/basemap.md).
 *
 *   node scripts/unpack-tiles.mjs
 *
 * build-basemap.mjs runs this after every extract; run it alone to re-unpack.
 *
 * Why not serve the archive: a `.pmtiles` file is read by HTTP range request,
 * and Cloudflare's static-asset hosting ignores Range. Asked for 127 bytes it
 * sends all 24 MB with a 200, and the pmtiles client aborts -- measured on the
 * first live release, 2026-09-15. Plain tile files need no ranges, stay free
 * static assets, and cost no Worker requests.
 *
 * Tiles are written decompressed. The archive stores them gzipped, and serving
 * those bytes as they are would need a `Content-Encoding: gzip` header that a
 * static host cannot be relied on to send.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE, openArchive, repoRoot, tileCoords } from "./basemap-archive.mjs";

export const TILES_DIR = join(repoRoot, "web", "public", "basemap", "tiles");

/** A tile's path under the tiles directory, matching `TILES_URL` in web/src/map/basemapStyle.ts. */
export const tilePath = (z, x, y) => `${z}/${x}/${y}.pbf`;

export async function unpackTiles({ archive = ARCHIVE, outDir = TILES_DIR } = {}) {
  if (!existsSync(archive)) {
    throw new Error(`${archive} is missing -- run scripts/build-basemap.mjs first`);
  }
  const reader = await openArchive(archive);
  const header = await reader.getHeader();
  rmSync(outDir, { recursive: true, force: true });
  let count = 0, bytes = 0, largest = 0;
  for (const [z, x, y] of tileCoords(header)) {
    const tile = await reader.getZxy(z, x, y);
    if (!tile) continue;
    const data = new Uint8Array(tile.data);
    const dest = join(outDir, tilePath(z, x, y));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    count++;
    bytes += data.byteLength;
    largest = Math.max(largest, data.byteLength);
  }
  // Every tile the archive addresses must have been reached by walking its bounds.
  if (header.numAddressedTiles > 0 && count !== header.numAddressedTiles) {
    throw new Error(`unpacked ${count} tiles but the archive addresses ${header.numAddressedTiles}`);
  }
  return { count, bytes, largest };
}

async function main() {
  try {
    const { count, bytes, largest } = await unpackTiles();
    console.log(
      `unpack-tiles: wrote ${count} tiles (${(bytes / 1048576).toFixed(1)} MB, largest ${(largest / 1024).toFixed(0)} KB) to web/public/basemap/tiles/`,
    );
  } catch (err) {
    console.error(`unpack-tiles: ${err.message}`);
    process.exit(1);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) await main();
