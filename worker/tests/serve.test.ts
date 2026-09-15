import { describe, expect, it } from "vitest";
import { LatestCache } from "../src/cache";
import { LATEST_KEY, type Env } from "../src/kv";
import { route } from "../src/index";
import { FakeKV, joined, makePair, metaFor } from "./fakes";

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
