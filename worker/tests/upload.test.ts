import { describe, expect, it } from "vitest";
import { LatestCache } from "../src/cache";
import { route } from "../src/index";
import { LATEST_KEY, type Env } from "../src/kv";
import { authorized, handleUpload, sha256Hex } from "../src/upload";
import { FakeKV, joined, makePair, metaFor, type Pair } from "./fakes";

const NOW = 1_789_352_400;
const HOST = "parkcast.example.workers.dev";
const SECRET = "pcu" + "_" + "S".repeat(43); // built, never a literal

function setup() {
  const kv = new FakeKV();
  const cache = new LatestCache(() => NOW * 1000);
  const env: Env = { ARTIFACTS: kv, UPLOAD_SECRET: SECRET, PRODUCTION_HOST: HOST };
  const put = (pair: Pair, o: { auth?: string | null; host?: string; gridLength?: string; at?: number } = {}) => {
    const headers = new Headers({ "X-Grid-Length": o.gridLength ?? String(pair.grid.byteLength) });
    const auth = o.auth === undefined ? `Bearer ${SECRET}` : o.auth;
    if (auth !== null) headers.set("Authorization", auth);
    const request = new Request(`https://${o.host ?? HOST}/artifacts/latest`, { method: "PUT", headers, body: joined(pair) });
    return route(request, env, cache, o.at ?? NOW);
  };
  return { kv, cache, env, put };
}

/** A request object whose headers are not filtered, to test Content-Length handling. */
function rawRequest(headers: Record<string, string>, body: ReadableStream<Uint8Array>): Request {
  return { headers: new Headers(headers), body } as unknown as Request;
}

function streamOf(totalBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const chunk = new Uint8Array(Math.min(64_000, totalBytes - sent));
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

describe("upload", () => {
  it("stores a valid pair with Worker-computed hashes and serves it without another read", async () => {
    const { kv, env, cache, put } = setup();
    const pair = makePair({ baseDataTs: NOW - 240, generatedAt: NOW - 30 });
    expect((await put(pair)).status).toBe(204);
    expect(kv.writes).toBe(1);

    // The isolate that accepted the upload serves it straight from memory.
    const readsBefore = kv.reads;
    const res = await route(new Request(`https://${HOST}/artifacts/grid.bin`), env, cache, NOW);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pair.grid);
    expect(kv.reads).toBe(readsBefore);

    const { metadata } = await kv.getWithMetadata(LATEST_KEY);
    expect(metadata).toMatchObject({
      gridSha256: await sha256Hex(pair.grid.slice()),
      lotsSha256: await sha256Hex(pair.lots.slice()),
      uploadedAt: NOW,
    });
  });

  it.each([null, "", "Basic abc", `Bearer ${SECRET}x`, `Bearer ${"a".repeat(300)}`])(
    "refuses authorization %s before touching storage",
    async (auth) => {
      const { kv, put } = setup();
      const res = await put(makePair({ baseDataTs: NOW - 240 }), { auth });
      expect(res.status).toBe(401);
      expect([kv.reads, kv.writes]).toEqual([0, 0]);
    },
  );

  it.each([
    ["missing", undefined as unknown as string],
    ["too short", "s".repeat(10)],
  ])("refuses every request while UPLOAD_SECRET is %s", async (_label, secret) => {
    const { kv, cache } = setup();
    const env: Env = { ARTIFACTS: kv, UPLOAD_SECRET: secret, PRODUCTION_HOST: HOST };
    const pair = makePair({ baseDataTs: NOW - 240 });
    for (const auth of [`Bearer ${secret}`, "Bearer "]) {
      // Checked directly too: a Request's Headers trims "Bearer " to "Bearer".
      expect(await authorized(auth, secret)).toBe(false);
      const headers = new Headers({ "X-Grid-Length": String(pair.grid.byteLength), Authorization: auth });
      const request = new Request(`https://${HOST}/artifacts/latest`, { method: "PUT", headers, body: joined(pair) });
      expect((await route(request, env, cache, NOW)).status).toBe(401);
    }
    expect([kv.reads, kv.writes]).toEqual([0, 0]);
  });

  it("does not let a preview hostname write", async () => {
    const { kv, put } = setup();
    const res = await put(makePair({ baseDataTs: NOW - 240 }), { host: `abc123-${HOST}` });
    expect(res.status).toBe(404);
    expect([kv.reads, kv.writes]).toEqual([0, 0]);
  });

  it("refuses a declared oversize body, and an oversize stream whatever it declares", async () => {
    const { env, cache, kv } = setup();
    const auth = { Authorization: `Bearer ${SECRET}`, "X-Grid-Length": "45" };
    const declared = await handleUpload(rawRequest({ ...auth, "Content-Length": String(2 * 1024 * 1024) }, streamOf(10)), env, cache, NOW);
    expect(declared.status).toBe(413);
    const lying = await handleUpload(rawRequest({ ...auth, "Content-Length": "10" }, streamOf(2 * 1024 * 1024)), env, cache, NOW);
    expect(lying.status).toBe(413);
    const undeclared = await handleUpload(rawRequest(auth, streamOf(2 * 1024 * 1024)), env, cache, NOW);
    expect(undeclared.status).toBe(413);
    expect(kv.writes).toBe(0);
  });

  it.each(["0x15", "21abc", "1e3", "", "1", "99999999"])("refuses X-Grid-Length %s", async (gridLength) => {
    const { kv, put } = setup();
    expect((await put(makePair({ baseDataTs: NOW - 240 }), { gridLength })).status).toBe(422);
    expect(kv.writes).toBe(0);
  });

  it("refuses a replay, a too-soon write and a future-dated reading", async () => {
    const { kv, put } = setup();
    const pair = makePair({ baseDataTs: NOW - 240, generatedAt: NOW - 30 });
    expect((await put(pair)).status).toBe(204);
    const replay = await put(pair, { at: NOW + 400 });
    expect([replay.status, replay.headers.get("X-Reject")]).toEqual([409, "stale"]);
    const soon = await put(makePair({ baseDataTs: NOW + 60, generatedAt: NOW + 70 }), { at: NOW + 100 });
    expect([soon.status, soon.headers.get("X-Reject")]).toEqual([409, "too-soon"]);
    const future = await put(makePair({ baseDataTs: NOW + 3600, generatedAt: NOW + 3600 }), { at: NOW + 400 });
    expect([future.status, future.headers.get("X-Reject")]).toEqual([409, "future"]);
    expect(kv.writes).toBe(1);
  });

  it("is not locked out by a stored future-dated value", async () => {
    const { kv, put } = setup();
    const forged = makePair({ baseDataTs: 4_000_000_000, generatedAt: 4_000_000_000 });
    kv.seed(LATEST_KEY, joined(forged), metaFor(forged, { uploadedAt: NOW - 300 }));
    expect((await put(makePair({ baseDataTs: NOW - 240 }))).status).toBe(204);
  });

  it("does not let an unauthenticated flood read or write anything", async () => {
    const { kv, put } = setup();
    const pair = makePair({ baseDataTs: NOW - 240 });
    await Promise.all(Array.from({ length: 200 }, () => put(pair, { auth: "Bearer wrong" })));
    expect([kv.reads, kv.writes]).toEqual([0, 0]);
  });
});
