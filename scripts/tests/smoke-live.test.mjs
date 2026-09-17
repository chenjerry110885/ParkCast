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
    // Built an hour ago: the daily rebuild is keeping up.
    "HEAD /artifacts/week.bin": () => new Response(null, { headers: { "last-modified": new Date(NOW - 3_600_000).toUTCString() } }),
    "HEAD /basemap/tiles/0/0/0.pbf": () => new Response(null),
    "HEAD /basemap/fonts/Noto%20Sans%20Regular/0-255.pbf": () => new Response(null),
    "HEAD /places/taipei.json": () => new Response(null),
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
    fetchImpl: site({
      "HEAD /basemap/fonts/Noto%20Sans%20Regular/0-255.pbf": missing,
      "HEAD /basemap/tiles/0/0/0.pbf": missing,
      "HEAD /places/taipei.json": missing,
    }),
    now: () => NOW,
  });
  assert.ok(failures.some((f) => f.includes("tiles/0/0/0.pbf")));
  assert.ok(failures.some((f) => f.includes("0-255.pbf")));
  assert.ok(failures.some((f) => f.includes("places/taipei.json")));
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

test("only warns when no week table is published, because the site works without one", async () => {
  const { failures, warnings } = await smoke(ORIGIN, {
    fetchImpl: site({ "HEAD /artifacts/week.bin": () => new Response(null, { status: 503 }) }),
    now: () => NOW,
  });
  assert.deepEqual(failures, []);
  assert.ok(warnings.some((w) => w.includes("week.bin") && w.includes("503")));
});

test("only warns when the week table is older than 48 h, not at 47", async () => {
  const at = (hoursOld) =>
    site({ "HEAD /artifacts/week.bin": () => new Response(null, { headers: { "last-modified": new Date(NOW - hoursOld * 3_600_000).toUTCString() } }) });

  const fresh = await smoke(ORIGIN, { fetchImpl: at(47), now: () => NOW });
  assert.deepEqual([fresh.failures, fresh.warnings], [[], []]);

  const stale = await smoke(ORIGIN, { fetchImpl: at(49), now: () => NOW });
  assert.deepEqual(stale.failures, []);
  assert.ok(stale.warnings.some((w) => w.includes("49 h old")));
});

test("only warns when the week table will not say when it was built", async () => {
  // A worker that stopped sending Last-Modified would otherwise make the age
  // check above silently vacuous rather than visibly unanswerable.
  const { failures, warnings } = await smoke(ORIGIN, {
    fetchImpl: site({ "HEAD /artifacts/week.bin": () => new Response(null) }),
    now: () => NOW,
  });
  assert.deepEqual(failures, []);
  assert.ok(warnings.some((w) => w.includes("does not say when it was built")));
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
