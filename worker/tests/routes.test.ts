import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { route } from "../src/index";
import { LatestCache } from "../src/cache";
import type { Env } from "../src/kv";
import { FakeKV } from "./fakes";

const origin = "https://parkcast.example.workers.dev";
const NOW = 1_789_352_400;
const untouchableEnv = new Proxy({}, { get() { throw new Error("env was read"); } }) as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

describe("routing", () => {
  it.each(["/", "/index.html", "/wp-login.php", "/.env", "/artifacts", "/artifacts%2Fgrid.bin", "/artifacts/%2e%2e/sw.js"])(
    "answers %s with 404 without reading env",
    async (path) => {
      const res = await route(new Request(origin + path), untouchableEnv, new LatestCache(), NOW);
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    },
  );

  it.each(["/artifacts/grid.bin/", "/artifacts/GRID.BIN", "/artifacts/grid.bin.tmp", "/artifacts/other"])(
    "answers unknown artifact path %s with 404",
    async (path) => {
      const env = { ARTIFACTS: new FakeKV(), UPLOAD_SECRET: "x", PRODUCTION_HOST: "h" } as Env;
      expect((await route(new Request(origin + path), env, new LatestCache(), NOW)).status).toBe(404);
    },
  );

  it("refuses other methods on known paths", async () => {
    const env = { ARTIFACTS: new FakeKV(), UPLOAD_SECRET: "x", PRODUCTION_HOST: "h" } as Env;
    const post = await route(new Request(origin + "/artifacts/grid.bin", { method: "POST" }), env, new LatestCache(), NOW);
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
    const getLatest = await route(new Request(origin + "/artifacts/latest"), env, new LatestCache(), NOW);
    expect(getLatest.status).toBe(405);
    expect(getLatest.headers.get("Allow")).toBe("PUT");
    // Unlike the pair's split paths, week.bin answers both its daily upload
    // and its GET/HEAD serving on one path.
    const postWeek = await route(new Request(origin + "/artifacts/week.bin", { method: "POST" }), env, new LatestCache(), NOW);
    expect(postWeek.status).toBe(405);
    expect(postWeek.headers.get("Allow")).toBe("GET, HEAD, PUT");
  });

  it("turns an unexpected failure into a generic 500", async () => {
    const kv = new FakeKV();
    kv.failReads = true;
    const env = { ARTIFACTS: kv, UPLOAD_SECRET: "x", PRODUCTION_HOST: "h" } as Env;
    const res = await worker.fetch(new Request(origin + "/artifacts/grid.bin"), env);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal error");
  });

  it("never makes a subrequest", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("subrequest"); });
    const env = { ARTIFACTS: new FakeKV(), UPLOAD_SECRET: "x", PRODUCTION_HOST: "h" } as Env;
    expect((await route(new Request(origin + "/artifacts/grid.bin"), env, new LatestCache(), NOW)).status).toBe(503);
  });
});
