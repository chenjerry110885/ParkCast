import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot, tileCoords } from "../basemap-archive.mjs";
import { tilePath } from "../unpack-tiles.mjs";

const TAIPEI = { minLon: 121.4433, minLat: 24.9576, maxLon: 121.6405, maxLat: 25.1999 };

test("enumerates every tile address inside the bounds, zoom by zoom", () => {
  assert.deepEqual([...tileCoords({ minZoom: 0, maxZoom: 2, ...TAIPEI })], [[0, 0, 0], [1, 1, 0], [2, 3, 1]]);
});

test("writes tiles at the z/x/y path the app requests", () => {
  assert.equal(tilePath(15, 27444, 14027), "15/27444/14027.pbf");
});

test("the app's tile bounds are the extract's bbox", () => {
  const read = (...p) => readFileSync(join(repoRoot, ...p), "utf8");
  const bbox = read("scripts", "build-basemap.mjs").match(/const BBOX = "([^"]+)"/)[1].split(",").map(Number);
  const bounds = read("web", "src", "map", "basemapStyle.ts").match(/BASEMAP_BOUNDS[^=]*=\s*\[([^\]]+)\]/)[1].split(",").map(Number);
  assert.deepEqual(bounds, bbox);
});
