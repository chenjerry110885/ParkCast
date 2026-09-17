import { describe, expect, it } from "vitest";
import { LatestCache } from "../src/cache";
import { LATEST_KEY, WEEK_KEY, type Env } from "../src/kv";
import { route } from "../src/index";
import { FakeKV, joined, makePair, makeWeek, metaFor, weekMetaFor } from "./fakes";

const NOW = 1_789_352_400;
const origin = "https://parkcast.example.workers.dev";

function setup(seed = true) {
  const kv = new FakeKV();
  const pair = makePair({ baseDataTs: NOW - 240, generatedAt: NOW - 30 });
  if (seed) kv.seed(LATEST_KEY, joined(pair), metaFor(pair));
  let clock = NOW * 1000;
  const cache = new LatestCache(() => clock);
  const env = { ARTIFACTS: kv, UPLOAD_SECRET: "x", PRODUCTION_HOST: "parkcast.example.workers.dev" } as Env;
  const get = (path: string, init?: RequestInit) => route(new Request(origin + path, init), env, cache, NOW);
  return { kv, pair, get, advance: (ms: number) => { clock += ms; } };
}

function weekSetup(seed = true) {
  const kv = new FakeKV();
  const week = makeWeek({ builtTs: NOW - 3600 });
  if (seed) kv.seed(WEEK_KEY, week.week, weekMetaFor(week));
  const cache = new LatestCache(() => NOW * 1000);
  const env = { ARTIFACTS: kv, UPLOAD_SECRET: "x", PRODUCTION_HOST: "parkcast.example.workers.dev" } as Env;
  const get = (path: string, init?: RequestInit) => route(new Request(origin + path, init), env, cache, NOW);
  return { kv, week, get };
}

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
}

describe("serving the forecast", () => {
  it("serves each half of the stored pair with its own caching", async () => {
    const { get, pair } = setup();
    const grid = await get("/artifacts/grid.bin");
    expect(grid.status).toBe(200);
    expect(new Uint8Array(await grid.arrayBuffer())).toEqual(pair.grid);
    expect(grid.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(grid.headers.get("Cache-Control")).toBe("max-age=300"); // clamp(gen+330-now) = 300
    expect(grid.headers.get("ETag")).toBe(`"${"g".repeat(64)}"`);
    expectSecurityHeaders(grid);

    const lots = await get("/artifacts/lots.json");
    expect(new Uint8Array(await lots.arrayBuffer())).toEqual(pair.lots);
    expect(lots.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(lots.headers.get("Cache-Control")).toBe("max-age=900");
    expect(lots.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("answers a weak or strong If-None-Match with 304 and no body", async () => {
    const { get } = setup();
    const res = await get("/artifacts/grid.bin", { headers: { "If-None-Match": `W/"${"g".repeat(64)}"` } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("sends no body for HEAD", async () => {
    const { get } = setup();
    const res = await get("/artifacts/lots.json", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("reads KV at most once a minute, even under concurrency", async () => {
    const { get, kv, advance } = setup();
    await Promise.all(Array.from({ length: 50 }, () => get("/artifacts/grid.bin")));
    expect(kv.reads).toBe(1);
    advance(59_000);
    await get("/artifacts/lots.json");
    expect(kv.reads).toBe(1);
    advance(2_000);
    await get("/artifacts/lots.json");
    expect(kv.reads).toBe(2);
  });

  it("says 503 when nothing is stored, and caches that answer too", async () => {
    const { get, kv } = setup(false);
    expect((await get("/artifacts/grid.bin")).status).toBe(503);
    expect((await get("/artifacts/grid.bin")).status).toBe(503);
    expect(kv.reads).toBe(1);
  });
});

describe("serving the week table", () => {
  it("serves week.bin with an hour-long cache lifetime, distinct from the pair's", async () => {
    const { get, week } = weekSetup();
    const res = await get("/artifacts/week.bin");
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(week.week);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Cache-Control")).toBe("max-age=3600");
    expect(res.headers.get("ETag")).toBe(`"${"w".repeat(64)}"`);
    expectSecurityHeaders(res);
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const { get } = weekSetup();
    const res = await get("/artifacts/week.bin", { headers: { "If-None-Match": `"${"w".repeat(64)}"` } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("dates the table by when it was built, so a HEAD can tell how stale it is", async () => {
    // `scripts/smoke-live.mjs` HEADs this path after every release and warns
    // when the daily rebuild has stalled. A HEAD has no body, so the table's
    // own `builtTs` has to reach it as a header or that check has nothing to
    // read. `builtTs` and not `uploadedAt`: re-PUTting yesterday's bytes must
    // not make yesterday's climatology look like today's.
    const { get, week } = weekSetup();
    const built = new Date(week.builtTs * 1000).toUTCString();
    expect((await get("/artifacts/week.bin")).headers.get("Last-Modified")).toBe(built);
    expect((await get("/artifacts/week.bin", { method: "HEAD" })).headers.get("Last-Modified")).toBe(built);
    expect(Date.parse(built)).not.toBeNaN();
  });

  it("sends no body for HEAD", async () => {
    const { get } = weekSetup();
    const res = await get("/artifacts/week.bin", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("says 503 when no week table has been uploaded yet", async () => {
    const { get, kv } = weekSetup(false);
    expect((await get("/artifacts/week.bin")).status).toBe(503);
    expect(kv.reads).toBe(1);
  });

  it("never reads the pair's KV key, and the pair's GET never reads week's", async () => {
    const { kv, get } = weekSetup();
    kv.seed(LATEST_KEY, joined(makePair({ baseDataTs: NOW - 240 })), metaFor(makePair({ baseDataTs: NOW - 240 })));
    await get("/artifacts/week.bin");
    expect(kv.reads).toBe(1); // only WEEK_KEY was read to serve week.bin

    const { kv: pairKv, get: pairGet } = setup();
    pairKv.seed(WEEK_KEY, makeWeek({ builtTs: NOW - 3600 }).week, weekMetaFor(makeWeek({ builtTs: NOW - 3600 })));
    await pairGet("/artifacts/grid.bin");
    expect(pairKv.reads).toBe(1); // only LATEST_KEY was read to serve the pair
  });

  it.each(["/artifacts/week.bin/", "/artifacts/WEEK.BIN"])("answers unknown week variant %s with 404", async (path) => {
    const { get } = weekSetup();
    expect((await get(path)).status).toBe(404);
  });
});
