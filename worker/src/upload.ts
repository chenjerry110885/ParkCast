import type { LatestCache } from "./cache";
import { TEXT, respond } from "./http";
import { LATEST_KEY, WEEK_KEY, asStoredMeta, type Env, type StoredMeta, type WeekMeta } from "./kv";
import { MAX_LOTS, WEEK_BUCKETS, WEEK_HEADER_SIZE, checkOrder, checkWeekRoster, validatePair, validateWeek } from "./validate";

export const MAX_BODY_BYTES = 1024 * 1024;
/** Headroom for `MAX_LOTS` lots at `WEEK_BUCKETS` buckets x 2 bytes each
 * (~2.56 MB for 4000 lots), the same way `MAX_BODY_BYTES` bounds the pair. */
export const MAX_WEEK_BODY_BYTES = WEEK_HEADER_SIZE + MAX_LOTS * WEEK_BUCKETS * 2;
export const MAX_AUTH_HEADER_LENGTH = 200;
const GRID_LENGTH = /^[0-9]{2,7}$/;
const DECIMAL = /^[0-9]+$/;
/** `roster_id` is a `zlib.crc32(...) & 0xFFFFFFFF` -- at most 10 decimal digits. */
const ROSTER_ID = /^[0-9]{1,10}$/;

/** The `X-Roster-Id` header as a validated uint32, or null if malformed or
 * out of range. Split out from `handleWeekUpload` so the `0xffffffff` bound
 * is directly testable: a week blob's own decoded `rosterId` is *also*
 * always `<= 0xffffffff` (it comes from `DataView.getUint32`), so an
 * over-bound header can never be caught "anyway" by the body-vs-header
 * consistency check downstream -- no real body can hold a value that large
 * to compare against, which makes an end-to-end fixture unable to isolate
 * this bound from that check. A direct unit test on this function can. */
export function parseRosterHeader(value: string | null): number | null {
  if (value === null || !ROSTER_ID.test(value)) return null;
  const n = Number(value);
  return n > 0xffffffff ? null : n;
}

type TimingSafeSubtle = SubtleCrypto & {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
};

/** The secret's digest, computed once per isolate. */
let secretDigest: { secret: string; digest: Promise<ArrayBuffer> } | null = null;

const encode = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

export async function authorized(header: string | null, secret: string): Promise<boolean> {
  // A missing or short secret refuses everything: an unset binding must never
  // match an empty or guessable token. The real secret is 47 characters.
  if (typeof secret !== "string" || secret.length < 32) return false;
  if (header === null || header.length > MAX_AUTH_HEADER_LENGTH || !header.startsWith("Bearer ")) {
    return false;
  }
  if (secretDigest === null || secretDigest.secret !== secret) {
    secretDigest = { secret, digest: crypto.subtle.digest("SHA-256", encode(secret)) };
  }
  // Comparing equal-length digests keeps timingSafeEqual from throwing and hides the secret's length.
  const [presented, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(header.slice("Bearer ".length))),
    secretDigest.digest,
  ]);
  return (crypto.subtle as TimingSafeSubtle).timingSafeEqual(presented, expected);
}

/** The whole body, or null as soon as it passes `cap` bytes -- whatever Content-Length claimed. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleUpload(request: Request, env: Env, cache: LatestCache, nowSec: number): Promise<Response> {
  // 1. Authentication before anything else: no body read, no storage touched.
  if (!(await authorized(request.headers.get("Authorization"), env.UPLOAD_SECRET))) {
    return respond(401, "Unauthorized", TEXT);
  }
  // 2. Size, by declaration and then by counting.
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!DECIMAL.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return respond(413, "Too large", TEXT);
  }
  const gridHeader = request.headers.get("X-Grid-Length") ?? "";
  if (!GRID_LENGTH.test(gridHeader)) return respond(422, "Invalid upload", TEXT);
  const body = await readCapped(request.body, MAX_BODY_BYTES);
  if (body === null) return respond(413, "Too large", TEXT);
  const gridLength = Number(gridHeader);
  if (gridLength > body.byteLength) return respond(422, "Invalid upload", TEXT);

  // 3. Shape.
  const grid = body.subarray(0, gridLength);
  const lots = body.subarray(gridLength);
  const result = validatePair(grid, lots);
  if (!result.ok) return respond(422, "Invalid upload", TEXT);

  // 4. Time and order, against what is stored (one KV read).
  const stored = await env.ARTIFACTS.getWithMetadata(LATEST_KEY, { type: "arrayBuffer" });
  const reject = checkOrder(result.header, asStoredMeta(stored.metadata), nowSec);
  if (reject !== null) return respond(409, "Not accepted", { ...TEXT, "X-Reject": reject });

  // 5. One write, with metadata the Worker computed itself.
  const meta: StoredMeta = {
    v: 1,
    gridLength,
    nLots: result.header.nLots,
    rosterId: result.header.rosterId,
    generatedAt: result.header.generatedAt,
    baseDataTs: result.header.baseDataTs,
    uploadedAt: nowSec,
    gridSha256: await sha256Hex(grid),
    lotsSha256: await sha256Hex(lots),
  };
  await env.ARTIFACTS.put(LATEST_KEY, body, { metadata: meta });
  cache.set({ bytes: body, meta });
  return respond(204, null);
}

/** `week.bin`'s own PUT, mirroring `handleUpload`'s shape but never touching
 * `LATEST_KEY` or `LatestCache` -- the five-minute pair's handling and its
 * one write per tick are exactly what they were before this existed. This
 * handler adds exactly one KV write, on its own once-a-day cadence, plus one
 * read of the pair's key to learn the roster it must agree with. */
export async function handleWeekUpload(request: Request, env: Env, nowSec: number): Promise<Response> {
  // 1. Authentication before anything else: no body read, no storage touched.
  if (!(await authorized(request.headers.get("Authorization"), env.UPLOAD_SECRET))) {
    return respond(401, "Unauthorized", TEXT);
  }
  // 2. Size, by declaration and then by counting.
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!DECIMAL.test(declared) || Number(declared) > MAX_WEEK_BODY_BYTES)) {
    return respond(413, "Too large", TEXT);
  }
  const claimedRosterId = parseRosterHeader(request.headers.get("X-Roster-Id"));
  if (claimedRosterId === null) return respond(422, "Invalid upload", TEXT);
  const body = await readCapped(request.body, MAX_WEEK_BODY_BYTES);
  if (body === null) return respond(413, "Too large", TEXT);

  // 3. Shape -- including that the body's own roster agrees with the header
  // that named it, so the two can never silently drift apart.
  const result = validateWeek(body);
  if (!result.ok || result.header.rosterId !== claimedRosterId) {
    return respond(422, "Invalid upload", TEXT);
  }

  // 4. Roster, against what is stored (one KV read of the pair's own key --
  // never written here). This is the check that matters: a table indexed
  // against a roster other than the one lots.json currently publishes would
  // attach every lot's climatology to the wrong lot.
  //
  // "no-pair" gets its own status, 503, not 409: the client's UploadGuard
  // (upload.py) treats 409 as terminal for the day and anything else as
  // retriable. An empty LATEST_KEY is transient -- the pair uploads every
  // five minutes -- so it must retry, unlike a genuine roster-mismatch,
  // which is permanent (identical bytes will never pass) and correctly
  // never retried.
  const stored = await env.ARTIFACTS.getWithMetadata(LATEST_KEY, { type: "arrayBuffer" });
  const reject = checkWeekRoster(result.header, asStoredMeta(stored.metadata)?.rosterId ?? null);
  if (reject === "no-pair") {
    return respond(503, "No pair uploaded yet", { ...TEXT, "X-Reject": reject, "Retry-After": "300" });
  }
  if (reject !== null) return respond(409, "Not accepted", { ...TEXT, "X-Reject": reject });

  // 5. One write, to its own key.
  const meta: WeekMeta = {
    v: 1,
    nLots: result.header.nLots,
    rosterId: result.header.rosterId,
    builtTs: result.header.builtTs,
    uploadedAt: nowSec,
    sha256: await sha256Hex(body),
  };
  await env.ARTIFACTS.put(WEEK_KEY, body, { metadata: meta });
  return respond(204, null);
}
