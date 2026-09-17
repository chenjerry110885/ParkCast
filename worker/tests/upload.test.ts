import { describe, expect, it } from "vitest";
import { LatestCache } from "../src/cache";
import { route } from "../src/index";
import { LATEST_KEY, WEEK_KEY, type Env } from "../src/kv";
import { MAX_WEEK_BODY_BYTES, authorized, handleUpload, handleWeekUpload, parseRosterHeader, sha256Hex } from "../src/upload";
import { FakeKV, joined, makePair, makeWeek, metaFor, weekMetaFor, type Pair, type Week } from "./fakes";

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

  it("never touches the week table's key", async () => {
    // The point of the whole "no new KV write on the five-minute path"
    // constraint: seed week.bin, then confirm a pair upload's one read and
    // one write are both LATEST_KEY's, not week's.
    const { kv, put } = setup();
    kv.seed(WEEK_KEY, makeWeek({ builtTs: NOW - 3600 }).week, weekMetaFor(makeWeek({ builtTs: NOW - 3600 })));
    expect((await put(makePair({ baseDataTs: NOW - 240 }))).status).toBe(204);
    expect(kv.reads).toBe(1);
    expect(kv.writes).toBe(1);
    const week = await kv.getWithMetadata(WEEK_KEY);
    expect(week.metadata).toMatchObject({ uploadedAt: NOW - 3600 + 10 }); // unchanged by the pair upload
  });
});

describe("week upload", () => {
  function weekSetup(rosterId = 42) {
    const kv = new FakeKV();
    const cache = new LatestCache(() => NOW * 1000);
    const env: Env = { ARTIFACTS: kv, UPLOAD_SECRET: SECRET, PRODUCTION_HOST: HOST };
    const pair = makePair({ baseDataTs: NOW - 240, generatedAt: NOW - 30, rosterId });
    kv.seed(LATEST_KEY, joined(pair), metaFor(pair));
    const putWeek = (week: Week, o: { auth?: string | null; host?: string; rosterId?: string; at?: number } = {}) => {
      const headers = new Headers({ "X-Roster-Id": o.rosterId ?? String(week.rosterId) });
      const auth = o.auth === undefined ? `Bearer ${SECRET}` : o.auth;
      if (auth !== null) headers.set("Authorization", auth);
      const request = new Request(`https://${o.host ?? HOST}/artifacts/week.bin`, { method: "PUT", headers, body: week.week });
      return route(request, env, cache, o.at ?? NOW);
    };
    return { kv, cache, env, pair, putWeek };
  }

  it("stores a valid week table under its own key, leaving the pair's untouched", async () => {
    const { kv, pair, putWeek } = weekSetup();
    const week = makeWeek({ builtTs: NOW - 3600, rosterId: pair.rosterId });
    const res = await putWeek(week);
    expect(res.status).toBe(204);
    expect(kv.reads).toBe(1); // the one read of LATEST_KEY to learn the roster
    expect(kv.writes).toBe(1); // the one write, to WEEK_KEY

    const stored = await kv.getWithMetadata(WEEK_KEY);
    expect(new Uint8Array(stored.value as ArrayBuffer)).toEqual(week.week);
    expect(stored.metadata).toMatchObject({ rosterId: pair.rosterId, nLots: week.nLots, uploadedAt: NOW });

    const latest = await kv.getWithMetadata(LATEST_KEY);
    expect(new Uint8Array(latest.value as ArrayBuffer)).toEqual(joined(pair)); // unchanged
  });

  it.each([null, "", "Basic abc", `Bearer ${SECRET}x`])(
    "refuses authorization %s before touching storage",
    async (auth) => {
      const { kv, pair, putWeek } = weekSetup();
      const res = await putWeek(makeWeek({ builtTs: NOW - 3600, rosterId: pair.rosterId }), { auth });
      expect(res.status).toBe(401);
      expect([kv.reads, kv.writes]).toEqual([0, 0]);
    },
  );

  it("does not let a preview hostname write", async () => {
    const { kv, pair, putWeek } = weekSetup();
    const res = await putWeek(makeWeek({ builtTs: NOW - 3600, rosterId: pair.rosterId }), { host: `abc123-${HOST}` });
    expect(res.status).toBe(404);
    expect([kv.reads, kv.writes]).toEqual([0, 0]);
  });

  it.each(["0x2a", "42abc", "4.2e1", "", "-1", "99999999999", "4294967296"])(
    "refuses X-Roster-Id %s before touching storage",
    async (rosterId) => {
      const { kv, pair, putWeek } = weekSetup();
      const res = await putWeek(makeWeek({ builtTs: NOW - 3600, rosterId: pair.rosterId }), { rosterId });
      expect(res.status).toBe(422);
      expect([kv.reads, kv.writes]).toEqual([0, 0]);
    },
  );

  it("refuses a body whose own header disagrees with X-Roster-Id, before touching storage", async () => {
    const { kv, pair, putWeek } = weekSetup();
    // The header names one roster; the body -- built for a different one --
    // names another. Neither the Python client nor a healthy Worker ever
    // produces this, so it must be refused, not resolved by picking one.
    const week = makeWeek({ builtTs: NOW - 3600, rosterId: pair.rosterId + 1 });
    const res = await putWeek(week, { rosterId: String(pair.rosterId) });
    expect(res.status).toBe(422);
    expect([kv.reads, kv.writes]).toEqual([0, 0]);
  });

  it("rejects a well-formed table whose roster is not what lots.json currently publishes", async () => {
    const { kv, pair, putWeek } = weekSetup();
    const week = makeWeek({ builtTs: NOW - 3600, rosterId: pair.rosterId + 1 });
    const res = await putWeek(week);
    expect([res.status, res.headers.get("X-Reject")]).toEqual([409, "roster-mismatch"]);
    expect(kv.writes).toBe(0);
  });

  it("answers a cold start with a retriable 503, not a terminal 409", async () => {
    // Fix round 1, Major 2: the client's UploadGuard treats 409 as "done,
    // never retry today" and anything else (503 included) as "back off and
    // retry" (see upload.py's UploadGuard.record). An empty LATEST_KEY is
    // transient -- the pair lands within five minutes -- so a cold-start PUT
    // here must not be answered the same way as a genuine, permanent roster
    // mismatch, or today's week.bin is parked until tomorrow's rebuild.
    const kv = new FakeKV(); // no LATEST_KEY seeded
    const cache = new LatestCache(() => NOW * 1000);
    const env: Env = { ARTIFACTS: kv, UPLOAD_SECRET: SECRET, PRODUCTION_HOST: HOST };
    const week = makeWeek({ builtTs: NOW - 3600, rosterId: 42 });
    const headers = new Headers({ "X-Roster-Id": "42", Authorization: `Bearer ${SECRET}` });
    const request = new Request(`https://${HOST}/artifacts/week.bin`, { method: "PUT", headers, body: week.week });
    const res = await route(request, env, cache, NOW);
    expect([res.status, res.headers.get("X-Reject")]).toEqual([503, "no-pair"]);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(kv.writes).toBe(0);
  });

  it("refuses a structurally invalid body, before touching storage", async () => {
    const { kv, pair, putWeek } = weekSetup();
    const week = makeWeek({ builtTs: NOW - 3600, rosterId: pair.rosterId });
    const corrupt = week.week.slice();
    corrupt[0] = 0x51; // bad magic
    const res = await putWeek({ ...week, week: corrupt });
    expect(res.status).toBe(422);
    expect([kv.reads, kv.writes]).toEqual([0, 0]);
  });

  it("refuses a declared oversize week body, and an oversize week stream whatever it declares", async () => {
    const { env, kv } = weekSetup();
    const auth = { Authorization: `Bearer ${SECRET}`, "X-Roster-Id": "42" };
    const declared = await handleWeekUpload(
      rawRequest({ ...auth, "Content-Length": String(MAX_WEEK_BODY_BYTES + 1) }, streamOf(10)),
      env,
      NOW,
    );
    expect(declared.status).toBe(413);
    const lying = await handleWeekUpload(
      rawRequest({ ...auth, "Content-Length": "10" }, streamOf(MAX_WEEK_BODY_BYTES + 1)),
      env,
      NOW,
    );
    expect(lying.status).toBe(413);
    const undeclared = await handleWeekUpload(rawRequest(auth, streamOf(MAX_WEEK_BODY_BYTES + 1)), env, NOW);
    expect(undeclared.status).toBe(413);
    expect(kv.writes).toBe(0);
  });
});

describe("parseRosterHeader", () => {
  it("accepts a well-formed roster id", () => {
    expect(parseRosterHeader("42")).toBe(42);
  });

  it.each([null, "0x2a", "42abc", "4.2e1", "", "-1", "99999999999"])("rejects %s", (value) => {
    expect(parseRosterHeader(value)).toBeNull();
  });

  it("rejects a value one above the largest real uint32", () => {
    // "4294967296" is exactly 10 digits, so it passes the length regex --
    // isolating the `> 0xffffffff` bound specifically. This cannot be tested
    // end-to-end through handleWeekUpload: a week blob's own rosterId is a
    // decoded uint32 (see validate.ts's parseWeekHeader), so it can never
    // equal a value this large, and the body-vs-header consistency check a
    // few lines below this one in upload.ts would always catch an
    // over-bound header too -- an end-to-end fixture could never tell the
    // two checks apart. Only a direct call on this pure function can.
    expect(parseRosterHeader("4294967296")).toBeNull();
  });
});
