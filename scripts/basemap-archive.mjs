/**
 * The local basemap archive and the tiles in it, shared by the scripts that read
 * it: unpack-tiles.mjs and select-glyphs.mjs (docs/basemap.md). Node built-ins
 * only; the pmtiles reader comes from the web app's own node_modules.
 */
import { openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The extract build-basemap.mjs writes. Deliberately outside `web/public/`: the
 * site serves the tiles unpacked from it, never the archive itself.
 */
export const ARCHIVE = join(repoRoot, "web", "basemap-src", "taipei.pmtiles");

/** Import from the web app's node_modules, so a script reads what the app draws. */
export const webModule = (path) => import(pathToFileURL(join(repoRoot, "web", "node_modules", path)).href);

class FileSource {
  constructor(path) { this.fd = openSync(path, "r"); }
  getKey() { return "taipei.pmtiles"; }
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  }
}

/** A pmtiles reader over a local file; `getZxy` hands back decompressed tile bytes. */
export async function openArchive(path = ARCHIVE) {
  const { PMTiles } = await webModule("pmtiles/dist/esm/index.js");
  return new PMTiles(new FileSource(path));
}

const lon2x = (lon, z) => Math.min(2 ** z - 1, Math.floor(((lon + 180) / 360) * 2 ** z));
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.min(2 ** z - 1, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z));
};

/** Every tile address inside an archive header's bounds, zoom by zoom, as [z, x, y]. */
export function* tileCoords({ minZoom, maxZoom, minLon, minLat, maxLon, maxLat }) {
  for (let z = minZoom; z <= maxZoom; z++) {
    for (let x = lon2x(minLon, z); x <= lon2x(maxLon, z); x++) {
      for (let y = lat2y(maxLat, z); y <= lat2y(minLat, z); y++) yield [z, x, y];
    }
  }
}
