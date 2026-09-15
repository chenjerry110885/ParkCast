import assert from "node:assert/strict";
import { test } from "node:test";
import { smoke } from "../smoke-live.mjs";

const ORIGIN = "https://parkcast.example.workers.dev";
const NOW = 1_789_352_400_000;
const SITE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'";

function gridBytes(rosterId, baseDataTs) {
  const g = new Uint8Array(21 + 24);
  const dv = new DataView(g.buffer);
  g.set([0x50, 0x43, 0x47, 0x31]);
  dv.setUint32(9, baseDataTs, true);
  dv.setUint32(17, rosterId, true);
  return g;
}

function site(overrides = {}) {
  const routes = {
    "GET /": () => new Response("<html>", { headers: { "content-security-policy": SITE_CSP, "x-content-type-options": "nosniff" } }),
    "GET /sw.js": () => new Response("", { headers: { "cache-control": "no-cache" } }),
    "GET /artifacts/grid.bin": () => new Response(gridBytes(7, NOW / 1000 - 240)),
    "GET /artifacts/lots.json": () => new Response(JSON.stringify({ roster_id: 7 })),
    "PUT /artifacts/latest": () => new Response("", { status: 401 }),
    "HEAD /basemap/tiles/0/0/0.pbf": () => new Response(null),
    "HEAD /basemap/fonts/Noto%20Sans%20Regular/0-255.pbf": () => new Response(null),
    ...overrides,
  };
  return async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    return (routes[key] ?? (() => new Response("", { status: 404 })))();
  };
}

test("passes a healthy site", async () => {
  const { failures, warnings } = await smoke(ORIGIN, { fetchImpl: site(), now: () => NOW });
  assert.deepEqual([failures, warnings], [[], []]);
});

test("fails when a source path is served", async () => {
  const { failures } = await smoke(ORIGIN, { fetchImpl: site({ "GET /src/main.tsx": () => new Response("code") }), now: () => NOW });
  assert.ok(failures.some((f) => f.includes("/src/main.tsx")));
});

test("fails when the map's tiles or label fonts are not served", async () => {
  const missing = () => new Response("not found", { status: 404 });
  const { failures } = await smoke(ORIGIN, {
    fetchImpl: site({ "HEAD /basemap/fonts/Noto%20Sans%20Regular/0-255.pbf": missing, "HEAD /basemap/tiles/0/0/0.pbf": missing }),
    now: () => NOW,
  });
  assert.ok(failures.some((f) => f.includes("tiles/0/0/0.pbf")));
  assert.ok(failures.some((f) => f.includes("0-255.pbf")));
});

test("fails when an unauthenticated upload is not refused", async () => {
  const { failures } = await smoke(ORIGIN, { fetchImpl: site({ "PUT /artifacts/latest": () => new Response(null, { status: 204 }) }), now: () => NOW });
  assert.ok(failures.some((f) => f.includes("PUT")));
});

test("fails when the forecast files do not pair", async () => {
  const { failures } = await smoke(ORIGIN, { fetchImpl: site({ "GET /artifacts/lots.json": () => new Response(JSON.stringify({ roster_id: 8 })) }), now: () => NOW });
  assert.ok(failures.some((f) => f.includes("pair")));
});

test("only warns when the forecast is old, because the collector may be paused", async () => {
  const { failures, warnings } = await smoke(ORIGIN, { fetchImpl: site(), now: () => NOW + 3 * 3600_000 });
  assert.deepEqual(failures, []);
  assert.equal(warnings.length, 1);
});

test("only warns when nothing is stored yet, so the first release is not rolled back", async () => {
  const empty = () => new Response("No forecast yet", { status: 503 });
  const { failures, warnings } = await smoke(ORIGIN, {
    fetchImpl: site({ "GET /artifacts/grid.bin": empty, "GET /artifacts/lots.json": empty }),
    now: () => NOW,
  });
  assert.deepEqual(failures, []);
  assert.ok(warnings.some((w) => w.includes("no forecast stored yet")));
});

test("does not throw when a request rejects, and names the failing path", async () => {
  const { failures } = await smoke(ORIGIN, {
    fetchImpl: site({
      "GET /sw.js": () => {
        throw new Error("network down");
      },
    }),
    now: () => NOW,
  });
  assert.ok(failures.some((f) => f.includes("/sw.js") && f.includes("network down")));
});

test("fails without throwing when lots.json answers 200 with invalid JSON", async () => {
  const { failures } = await smoke(ORIGIN, {
    fetchImpl: site({ "GET /artifacts/lots.json": () => new Response("not json") }),
    now: () => NOW,
  });
  assert.ok(failures.some((f) => f.includes("pair")));
});
