import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LANDMARK_KINDS, STATION_KINDS, buildRows, checkIndex, clusterPoints, groupOf, nearestLocality, prominenceOf,
} from "../build-place-index.mjs";

const TAIPEI = { lat: 25.0478, lon: 121.517 };
const north = (m) => ({ lat: TAIPEI.lat + m / 111_320, lon: TAIPEI.lon });

test("maps tile layers and kinds onto the four search groups", () => {
  assert.equal(groupOf("places", "locality"), "area");
  // The `places` layer is filtered by kind like every other one: `country` (and
  // `region`, and `county`) is not an area the app knows how to rank.
  assert.equal(groupOf("places", "country"), null);
  assert.equal(groupOf("roads", "minor_road"), "street");
  assert.equal(groupOf("roads", "path"), null);
  assert.equal(groupOf("pois", "station"), "station");
  assert.equal(groupOf("pois", "subway_entrance"), "station");
  assert.equal(groupOf("pois", "hospital"), "landmark");
  assert.equal(groupOf("pois", "restaurant"), null);
  assert.equal(groupOf("pois", "bicycle_rental"), null);
});

test("prominence follows the fixed kind order", () => {
  assert.ok(prominenceOf("station") < prominenceOf("subway_entrance"));
  assert.ok(prominenceOf("university") < prominenceOf("clinic"));
  assert.ok(prominenceOf(LANDMARK_KINDS.at(-1)) < prominenceOf("major_road"));
  assert.ok(prominenceOf("major_road") < prominenceOf("minor_road"));
  assert.equal(prominenceOf("nonsense"), 1000);
  assert.deepEqual(STATION_KINDS, ["station", "subway_entrance"]);
});

test("clusters points by single linkage within the link distance", () => {
  const points = [north(0), north(400), north(800), north(5000), north(5300)];
  const clusters = clusterPoints(points, 1000);
  assert.deepEqual(clusters.map((c) => c.length).sort(), [2, 3]);
});

test("names a cluster after the nearest locality, or nothing when none is near", () => {
  const localities = [{ name: "士林", ...north(500) }, { name: "板橋", ...north(9000) }];
  assert.equal(nearestLocality(north(0), localities, 3000), "士林");
  assert.equal(nearestLocality(north(20000), localities, 3000), "");
});

test("one name in two places becomes two rows, each qualified; one kind wins per cluster", () => {
  const localities = [{ name: "士林", ...north(100) }, { name: "板橋", ...north(9100) }];
  const features = [
    { name: "中正路", en: "Zhongzheng Rd", kind: "major_road", group: "street", ...north(0) },
    { name: "中正路", en: "", kind: "minor_road", group: "street", ...north(300) },
    { name: "中正路", en: "Zhongzheng Rd", kind: "major_road", group: "street", ...north(9000) },
    { name: "國父紀念館", en: "", kind: "arts_centre", group: "landmark", ...north(50) },
    { name: "國父紀念館", en: "SYS Memorial Hall", kind: "theatre", group: "landmark", ...north(60) },
    { name: "國父紀念館", en: "", kind: "station", group: "station", ...north(70) },
  ];
  const rows = buildRows(features, localities);
  const roads = rows.filter((r) => r[0] === "中正路");
  assert.equal(roads.length, 2);
  assert.deepEqual(roads.map((r) => r[5]).sort(), ["士林", "板橋"]);
  assert.equal(roads[0][2], "major_road", "the most prominent kind in the cluster names it");
  assert.equal(roads[0][1], "Zhongzheng Rd", "an English name from any member is kept");
  const hall = rows.filter((r) => r[0] === "國父紀念館");
  assert.deepEqual(hall.map((r) => r[2]).sort(), ["arts_centre", "station"], "groups never merge");
  for (const r of rows) {
    assert.equal(typeof r[3], "number");
    assert.equal(r[3], Number(r[3].toFixed(5)));
  }
});

test("the size gate refuses a thin or oversized index", () => {
  assert.deepEqual(checkIndex(new Array(20_000).fill(0), 400 * 1024), []);
  assert.ok(checkIndex(new Array(100).fill(0), 400 * 1024).some((p) => /rows/.test(p)));
  assert.ok(checkIndex(new Array(20_000).fill(0), 700 * 1024).some((p) => /gzip/.test(p)));
});
