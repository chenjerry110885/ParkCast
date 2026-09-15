#!/usr/bin/env node
/**
 * Build the offline place index the search box uses:
 * `web/public/places/taipei.json` (docs/basemap.md, design spec §7.2).
 *
 *   node scripts/build-place-index.mjs
 *
 * Every named landmark, station, street/lane and neighbourhood inside the
 * basemap extract, read from the zoom-15 tiles of the local archive, so the app
 * can answer "I'm going to 忠孝東路四段216巷" with no geocoder, no key and no
 * request that leaves the phone. Car parks are not in here: the app already
 * holds the roster in memory and searches it first.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { ARCHIVE, openArchive, repoRoot, tileCoords, webModule } from "./basemap-archive.mjs";

export const OUT_PATH = join(repoRoot, "web", "public", "places", "taipei.json");
export const INDEX_VERSION = 1;
/** Same-name features closer than this merge into one entry (a road's segments, a park's points). */
export const LINK_METERS = 1000;
/** A cluster further than this from every locality gets no qualifier. */
export const QUALIFIER_MAX_METERS = 3000;
export const MIN_ROWS = 15_000;
export const MAX_GZIP_BYTES = 600 * 1024;

/**
 * Kinds kept, most prominent first. `web/src/places.ts` PROMINENCE mirrors this
 * order; change both together.
 */
export const STATION_KINDS = ["station", "subway_entrance"];
export const LANDMARK_KINDS = [
  "aerodrome", "bus_station", "ferry_terminal", "terminal", "university", "hospital", "mall",
  "department_store", "stadium", "museum", "arts_centre", "theatre", "attraction", "park",
  "townhall", "government", "library", "college", "school", "hotel", "place_of_worship",
  "marketplace", "supermarket", "cinema", "sports_centre", "swimming_pool", "garden", "viewpoint",
  "monument", "memorial", "courthouse", "police", "fire_station", "post_office",
  "community_centre", "clinic", "parking",
];
export const ROAD_KINDS = ["highway", "major_road", "minor_road"];
export const AREA_KINDS = ["macrohood", "neighbourhood", "locality"];
const ORDER = [...STATION_KINDS, ...LANDMARK_KINDS, ...ROAD_KINDS, ...AREA_KINDS];

export function prominenceOf(kind) {
  const at = ORDER.indexOf(kind);
  return at < 0 ? 1000 : at;
}

export function groupOf(layer, kind) {
  // Filtered like every other layer, rather than trusting the layer name: the
  // `places` layer also carries `country`, `region` and `county`, and a row the
  // builder kept but `web/src/places.ts` does not map to `area` would be a place
  // in the index that the app can never group, rank or explain.
  if (layer === "places") return AREA_KINDS.includes(kind) ? "area" : null;
  if (layer === "roads") return ROAD_KINDS.includes(kind) ? "street" : null;
  if (STATION_KINDS.includes(kind)) return "station";
  if (LANDMARK_KINDS.includes(kind)) return "landmark";
  return null;
}

const RAD = Math.PI / 180;
export function metersBetween(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Single-linkage clusters: breadth-first over "within linkMeters". Fine for a name's few hundred points. */
export function clusterPoints(points, linkMeters) {
  const seen = new Array(points.length).fill(false);
  const clusters = [];
  for (let i = 0; i < points.length; i++) {
    if (seen[i]) continue;
    const cluster = [];
    const queue = [i];
    seen[i] = true;
    while (queue.length > 0) {
      const at = queue.pop();
      cluster.push(points[at]);
      for (let j = 0; j < points.length; j++) {
        if (!seen[j] && metersBetween(points[at], points[j]) <= linkMeters) {
          seen[j] = true;
          queue.push(j);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

export function centroid(points) {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return { lat, lon };
}

export function nearestLocality(point, localities, maxMeters) {
  let best = { name: "", d: Infinity };
  for (const l of localities) {
    const d = metersBetween(point, l);
    if (d < best.d) best = { name: l.name, d };
  }
  return best.d <= maxMeters ? best.name : "";
}

/** The comparison key: the search folds the same way (web/src/places.ts foldKey). */
const fold = (s) => s.replaceAll("臺", "台").toLowerCase().replace(/\s+/g, "");

export function buildRows(features, localities) {
  const byName = new Map();
  for (const f of features) {
    const key = `${f.group}|${fold(f.name)}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }
  const rows = [];
  for (const members of byName.values()) {
    const clusters = clusterPoints(members, LINK_METERS);
    for (const cluster of clusters) {
      const at = centroid(cluster);
      const lead = [...cluster].sort((a, b) => prominenceOf(a.kind) - prominenceOf(b.kind))[0];
      const en = cluster.find((m) => m.en)?.en ?? "";
      const qualifier = lead.group === "area" ? "" : nearestLocality(at, localities, QUALIFIER_MAX_METERS);
      rows.push([lead.name, en, lead.kind, +at.lat.toFixed(5), +at.lon.toFixed(5), qualifier]);
    }
  }
  rows.sort((a, b) => prominenceOf(a[2]) - prominenceOf(b[2]) || a[0].localeCompare(b[0], "zh-Hant") || a[3] - b[3] || a[4] - b[4]);
  return rows;
}

export function checkIndex(rows, gzipBytes) {
  const problems = [];
  if (rows.length < MIN_ROWS) problems.push(`only ${rows.length} rows, expected at least ${MIN_ROWS}`);
  if (gzipBytes > MAX_GZIP_BYTES) problems.push(`gzip size ${gzipBytes} exceeds ${MAX_GZIP_BYTES}`);
  return problems;
}

/** A feature's representative point: a point's coordinates, or the middle vertex of a line. */
function pointOf(geojson) {
  const g = geojson.geometry;
  if (g.type === "Point") return { lon: g.coordinates[0], lat: g.coordinates[1] };
  const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]) : g.type === "MultiPoint" ? [g.coordinates] : [];
  const flat = lines.flat();
  if (flat.length === 0) return null;
  const mid = flat[Math.floor(flat.length / 2)];
  return { lon: mid[0], lat: mid[1] };
}

function sourceBuild() {
  const text = readFileSync(join(repoRoot, "scripts", "build-basemap.mjs"), "utf8");
  return text.match(/build\.protomaps\.com\/(\d{8})\.pmtiles/)?.[1] ?? "unknown";
}

export async function buildPlaceIndex() {
  if (!existsSync(ARCHIVE)) throw new Error(`${ARCHIVE} is missing -- run scripts/build-basemap.mjs first`);
  const { VectorTile } = await webModule("@mapbox/vector-tile/index.js");
  const { PbfReader } = await webModule("pbf/index.js");
  const archive = await openArchive();
  const header = await archive.getHeader();
  const features = [];
  const localities = [];
  for (const [z, x, y] of tileCoords(header)) {
    if (z !== header.maxZoom) continue;
    const tile = await archive.getZxy(z, x, y);
    if (!tile) continue;
    const vt = new VectorTile(new PbfReader(new Uint8Array(tile.data)));
    for (const layer of ["pois", "places", "roads"]) {
      const l = vt.layers[layer];
      if (!l) continue;
      for (let i = 0; i < l.length; i++) {
        const f = l.feature(i);
        const name = f.properties["name"];
        if (typeof name !== "string" || name === "") continue;
        const kind = String(f.properties["kind"] ?? "");
        const group = groupOf(layer, kind);
        if (group === null) continue;
        const at = pointOf(f.toGeoJSON(x, y, z));
        if (at === null) continue;
        const en = typeof f.properties["name:en"] === "string" ? f.properties["name:en"] : "";
        const feature = { name, en, kind, group, lat: at.lat, lon: at.lon };
        features.push(feature);
        if (group === "area") localities.push({ name, lat: at.lat, lon: at.lon });
      }
    }
  }
  const rows = buildRows(features, localities);
  const doc = { v: INDEX_VERSION, built: Math.floor(Date.now() / 1000), source: sourceBuild(), rows };
  const json = JSON.stringify(doc);
  const gzipBytes = gzipSync(json).length;
  const problems = checkIndex(rows, gzipBytes);
  if (problems.length > 0) throw new Error(`place index rejected: ${problems.join("; ")}`);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json);
  const byKind = {};
  for (const r of rows) byKind[r[2]] = (byKind[r[2]] ?? 0) + 1;
  return { rows: rows.length, gzipBytes, byKind };
}

async function main() {
  try {
    const { rows, gzipBytes, byKind } = await buildPlaceIndex();
    console.log(`build-place-index: ${rows} rows, ${(gzipBytes / 1024).toFixed(0)} KB gzipped -> web/public/places/taipei.json`);
    console.log("build-place-index: " + Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" "));
  } catch (err) {
    console.error(`build-place-index: ${err.message}`);
    process.exit(1);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) await main();
