/**
 * Tests for `web/public/sw.js`.
 *
 * The worker is not processed by Vite -- that is the whole point of it living in
 * `public/` -- so there is nothing to `import`. These tests read the file that
 * actually ships and evaluate it with a stubbed worker global, which means they
 * cannot drift from the deployed byte stream the way a copied-out helper would.
 *
 * Two things are being tested here, and the second is the one that took a
 * production incident to learn:
 *
 *  1. The routing decision -- which requests are the app shell, which are
 *     artifacts, and which must not be touched at all. `routeFor` is pure, so
 *     this part is easy.
 *
 *  2. **What actually reaches the cache.** A pure `isCacheable` tested in
 *     isolation proves nothing about whether the code that stores responses ever
 *     calls it, and a `cacheFirst` that silently stops writing breaks offline
 *     with every routing test still green. So `install`, `activate` and `fetch`
 *     are dispatched as real events against a stubbed `caches`, and the
 *     assertions are on the contents of the store afterwards.
 *
 * The stub can also be told to *fail* -- a full quota, or a browser with site
 * data blocked. Those cases are load-bearing rather than exotic: every cache
 * call happens inside `respondWith`, so a rejection that escapes renders a
 * network error for a response that was fetched perfectly well.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Resolved through `fileURLToPath` rather than `new URL("...", import.meta.url)`:
// Vite rewrites that literal pattern at transform time into an asset URL, which
// here would resolve to `http://localhost/sw.js` and never reach the disk.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const SOURCE = readFileSync(join(PUBLIC, "sw.js"), "utf8");

const SCOPE = "https://example.test/ParkCast/";
const WORKER_URL = `${SCOPE}sw.js`;

type Route = "cache-first" | "network-first" | "passthrough";

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  headers?: { get(name: string): string | null };
}

interface FakeResponse {
  status: number;
  type: string;
  body?: string;
  clone(): FakeResponse;
}

interface Worker {
  routeFor(request: FakeRequest, scope: string): Route;
  staleCaches(names: string[], current: string): string[];
  isCacheable(response: FakeResponse | null): boolean;
  CACHE_NAME: string;
  SCOPE: string;
  dispatch(type: string, event: unknown): void;
  /** Dispatch `install` or `activate` and await everything it passed `waitUntil`. */
  lifecycle(type: "install" | "activate"): Promise<void>;
  fetch: ReturnType<typeof vi.fn>;
  /** What is in the cache: URL to response. */
  cacheStore: Map<string, FakeResponse>;
  /** What `caches.keys()` reports. Push to it before dispatching `activate`. */
  cacheNames: string[];
  /** What `caches.delete()` was called with. */
  deleted: string[];
}

interface WorkerOptions {
  location?: string;
  /** Every `fetch` rejects, the way it does with no network at all. */
  networkFails?: boolean;
  /** `caches.open` and `caches.match` reject: a browser with site data blocked. */
  storageFails?: boolean;
  /** `cache.put` rejects: the origin is out of quota. */
  quotaFails?: boolean;
  /** Status the network answers with, by URL. Anything unlisted gets a 200. */
  status?: Record<string, number>;
}

function response(status = 200, type = "basic", body = "ok"): FakeResponse {
  const res: FakeResponse = { status, type, body, clone: () => ({ ...res }) };
  return res;
}

function request(url: string, init: Partial<FakeRequest> & { range?: string } = {}): FakeRequest {
  const { range, ...rest } = init;
  return {
    url,
    method: "GET",
    mode: "no-cors",
    headers: {
      get: (name) => (name.toLowerCase() === "range" ? (range ?? null) : null),
    },
    ...rest,
  };
}

/**
 * Evaluate the shipped worker source against stub globals.
 *
 * `new Function` with `self` as a parameter shadows the real global, so the
 * worker's top-level `self.addEventListener` calls land in `listeners` instead
 * of on jsdom's window. The trailing `return` is how the internals become
 * reachable without the production file exporting anything for the benefit of
 * its tests.
 */
function loadWorker(options: WorkerOptions = {}): Worker {
  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStore = new Map<string, FakeResponse>();
  const cacheNames: string[] = [];
  const deleted: string[] = [];
  const keyOf = (key: string | FakeRequest) => (typeof key === "string" ? key : key.url);

  const self = {
    location: { href: options.location ?? WORKER_URL },
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(type, handler);
    },
  };

  const fetchStub = vi.fn(async (input: string | FakeRequest) => {
    if (options.networkFails) throw new TypeError("offline");
    const url = keyOf(input);
    return response(options.status?.[url] ?? 200, "basic", `network:${url}`);
  });

  const caches = {
    async match(key: string | FakeRequest) {
      if (options.storageFails) throw new TypeError("storage is disabled");
      return cacheStore.get(keyOf(key));
    },
    async open() {
      if (options.storageFails) throw new TypeError("storage is disabled");
      return {
        async put(key: string | FakeRequest, value: FakeResponse) {
          if (options.quotaFails) throw new TypeError("quota exceeded");
          cacheStore.set(keyOf(key), value);
        },
      };
    },
    async keys() {
      return [...cacheNames];
    },
    async delete(name: string) {
      deleted.push(name);
      return cacheNames.includes(name);
    },
  };

  const factory = new Function(
    "self",
    "caches",
    "fetch",
    `${SOURCE}\nreturn { routeFor, staleCaches, isCacheable, CACHE_NAME, SCOPE };`,
  );
  const exported = factory(self, caches, fetchStub);

  const dispatch = (type: string, event: unknown) => {
    const handler = listeners.get(type);
    if (!handler) throw new Error(`the worker registered no "${type}" listener`);
    handler(event);
  };

  return {
    ...exported,
    fetch: fetchStub,
    cacheStore,
    cacheNames,
    deleted,
    dispatch,
    async lifecycle(type: string) {
      const pending: unknown[] = [];
      dispatch(type, { waitUntil: (promise: unknown) => pending.push(promise) });
      await Promise.all(pending);
    },
  };
}

/** A `FetchEvent` stand-in. `responded[0]` is whatever `respondWith` was handed. */
function fetchEvent(req: FakeRequest) {
  const responded: unknown[] = [];
  return {
    request: req,
    responded,
    respondWith(value: unknown) {
      responded.push(value);
    },
  };
}

/** Dispatch a fetch and hand back the promise the worker answered with. */
function respondTo(worker: Worker, req: FakeRequest): Promise<FakeResponse> {
  const event = fetchEvent(req);
  worker.dispatch("fetch", event);
  if (event.responded.length === 0) throw new Error("the worker did not call respondWith");
  return event.responded[0] as Promise<FakeResponse>;
}

describe("routeFor", () => {
  let worker: Worker;
  beforeEach(() => {
    worker = loadWorker();
  });

  it("derives its scope from where the worker is served", () => {
    expect(worker.SCOPE).toBe(SCOPE);
  });

  it("serves hashed assets cache-first", () => {
    // Vite hashes the name, so this URL can never describe stale bytes.
    expect(worker.routeFor(request(`${SCOPE}assets/index-B7xK1a2c.js`), SCOPE)).toBe("cache-first");
    expect(worker.routeFor(request(`${SCOPE}assets/MapView-9f0e1d2b.css`), SCOPE)).toBe(
      "cache-first",
    );
  });

  it("serves the unhashed icons and manifest cache-first", () => {
    expect(worker.routeFor(request(`${SCOPE}favicon.svg`), SCOPE)).toBe("cache-first");
    expect(worker.routeFor(request(`${SCOPE}manifest.webmanifest`), SCOPE)).toBe("cache-first");
    expect(worker.routeFor(request(`${SCOPE}icon-192.png`), SCOPE)).toBe("cache-first");
  });

  it("fetches both artifacts network-first", () => {
    expect(worker.routeFor(request(`${SCOPE}artifacts/grid.bin`), SCOPE)).toBe("network-first");
    expect(worker.routeFor(request(`${SCOPE}artifacts/lots.json`), SCOPE)).toBe("network-first");
  });

  it("fetches the document network-first, because index.html is the one unhashed name", () => {
    expect(worker.routeFor(request(SCOPE, { mode: "navigate" }), SCOPE)).toBe("network-first");
    expect(worker.routeFor(request(`${SCOPE}index.html`, { mode: "navigate" }), SCOPE)).toBe(
      "network-first",
    );
  });

  it("never touches the basemap", () => {
    // 23 MB read by range request. Caching `206 Partial Content` naively is a
    // well-known way to serve corrupt tiles; this rule is why we do not.
    expect(worker.routeFor(request(`${SCOPE}basemap/taipei.pmtiles`), SCOPE)).toBe("passthrough");
    expect(worker.routeFor(request(`${SCOPE}basemap/anything-else`), SCOPE)).toBe("passthrough");
    expect(worker.routeFor(request(`${SCOPE}elsewhere/other.pmtiles`), SCOPE)).toBe("passthrough");
  });

  it("never touches a ranged request, whatever it is for", () => {
    // The general form of the basemap rule, so a future range-reading client is
    // safe before anyone remembers to add it to the list.
    expect(worker.routeFor(request(`${SCOPE}artifacts/grid.bin`, { range: "bytes=0-99" }), SCOPE)).toBe(
      "passthrough",
    );
    expect(worker.routeFor(request(`${SCOPE}assets/index-B7xK1a2c.js`, { range: "bytes=0-" }), SCOPE)).toBe(
      "passthrough",
    );
  });

  it("ignores anything that is not a GET", () => {
    expect(worker.routeFor(request(`${SCOPE}artifacts/grid.bin`, { method: "POST" }), SCOPE)).toBe(
      "passthrough",
    );
    expect(worker.routeFor(request(`${SCOPE}assets/index.js`, { method: "HEAD" }), SCOPE)).toBe(
      "passthrough",
    );
  });

  it("ignores other origins and anything outside its own scope", () => {
    expect(worker.routeFor(request("https://cdn.other.test/thing.js"), SCOPE)).toBe("passthrough");
    expect(worker.routeFor(request("https://example.test/elsewhere/thing.js"), SCOPE)).toBe(
      "passthrough",
    );
  });

  it("does not throw on a request with no headers object", () => {
    const bare: FakeRequest = { url: `${SCOPE}assets/index.js`, method: "GET", mode: "no-cors" };
    expect(worker.routeFor(bare, SCOPE)).toBe("cache-first");
  });

  it("does not throw on an unparseable request URL", () => {
    expect(worker.routeFor(request("not a url"), SCOPE)).toBe("passthrough");
  });

  it("works when the app is deployed at a root, not under /ParkCast/", () => {
    // `PARKCAST_BASE=/` is a supported deploy, so nothing may hardcode the
    // sub-path. The worker derives the base from its own location.
    const root = loadWorker({ location: "https://example.test/sw.js" });
    expect(root.SCOPE).toBe("https://example.test/");
    expect(root.routeFor(request("https://example.test/artifacts/lots.json"), root.SCOPE)).toBe(
      "network-first",
    );
    expect(root.routeFor(request("https://example.test/basemap/taipei.pmtiles"), root.SCOPE)).toBe(
      "passthrough",
    );
    expect(root.routeFor(request("https://example.test/assets/index-abc.js"), root.SCOPE)).toBe(
      "cache-first",
    );
  });

  it("ignores another origin at a root scope, where the path check cannot help", () => {
    // Under `/ParkCast/` the origin check has a backstop: a third-party URL also
    // fails the scope-prefix test, so deleting the origin check changes nothing
    // and no test notices. Under `PARKCAST_BASE=/` -- a deploy `vite.config.ts`
    // names explicitly -- `base.pathname` is `/`, every path starts with it, and
    // the origin check is the *only* thing keeping this worker off a CDN's URLs.
    const root = loadWorker({ location: "https://example.test/sw.js" });
    expect(root.routeFor(request("https://cdn.other.test/assets/index-abc.js"), root.SCOPE)).toBe(
      "passthrough",
    );
    expect(root.routeFor(request("https://cdn.other.test/artifacts/lots.json"), root.SCOPE)).toBe(
      "passthrough",
    );
    expect(root.routeFor(request("https://cdn.other.test/"), root.SCOPE)).toBe("passthrough");
  });
});

describe("cache housekeeping", () => {
  it("versions the cache name", () => {
    expect(loadWorker().CACHE_NAME).toMatch(/^parkcast-v\d+$/);
  });

  it("marks every cache but the current one stale", () => {
    const worker = loadWorker();
    expect(worker.staleCaches(["parkcast-v1", "parkcast-v2", "something-else"], "parkcast-v2")).toEqual(
      ["parkcast-v1", "something-else"],
    );
    expect(worker.staleCaches(["parkcast-v2"], "parkcast-v2")).toEqual([]);
  });

  it("refuses to store a partial, a failure, or an opaque response", () => {
    const worker = loadWorker();
    expect(worker.isCacheable(response(200, "basic"))).toBe(true);
    // 206 is `ok`, which is exactly why it is rejected by status and not by ok.
    expect(worker.isCacheable(response(206, "basic"))).toBe(false);
    expect(worker.isCacheable(response(404, "basic"))).toBe(false);
    // An opaque response reports its status as 0 -- it is rejected *by the
    // status check*, and the worker deliberately has no separate clause for it.
    // This line documents the outcome; it does not prove a second guard exists,
    // and an earlier version of this test that implied otherwise was wrong.
    expect(worker.isCacheable(response(0, "opaque"))).toBe(false);
    expect(worker.isCacheable(null)).toBe(false);
  });
});

describe("the fetch listener", () => {
  it("does not call respondWith for a passthrough, so the browser does the request itself", () => {
    const worker = loadWorker();
    const event = fetchEvent(request(`${SCOPE}basemap/taipei.pmtiles`));
    worker.dispatch("fetch", event);
    expect(event.responded).toHaveLength(0);
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("goes to the network for an artifact and caches what comes back", async () => {
    const worker = loadWorker();
    const url = `${SCOPE}artifacts/grid.bin`;
    const event = fetchEvent(request(url));
    worker.dispatch("fetch", event);
    await expect(event.responded[0]).resolves.toMatchObject({ body: `network:${url}` });
    expect(worker.cacheStore.get(url)).toBeDefined();
  });

  it("falls back to the cached artifact when the network is gone", async () => {
    const worker = loadWorker({ networkFails: true });
    const url = `${SCOPE}artifacts/lots.json`;
    worker.cacheStore.set(url, response(200, "basic", "cached lots"));
    const event = fetchEvent(request(url));
    worker.dispatch("fetch", event);
    await expect(event.responded[0]).resolves.toMatchObject({ body: "cached lots" });
  });

  it("falls back to the cached shell for an offline navigation to index.html", async () => {
    // The precache holds `<scope>`; the navigation asks for `<scope>index.html`.
    // Offline is exactly when that difference must not matter.
    const worker = loadWorker({ networkFails: true });
    worker.cacheStore.set(SCOPE, response(200, "basic", "cached shell"));
    const event = fetchEvent(request(`${SCOPE}index.html`, { mode: "navigate" }));
    worker.dispatch("fetch", event);
    await expect(event.responded[0]).resolves.toMatchObject({ body: "cached shell" });
  });

  it("serves a hashed asset from cache without touching the network", async () => {
    const worker = loadWorker();
    const url = `${SCOPE}assets/index-B7xK1a2c.js`;
    worker.cacheStore.set(url, response(200, "basic", "cached bundle"));
    const event = fetchEvent(request(url));
    worker.dispatch("fetch", event);
    await expect(event.responded[0]).resolves.toMatchObject({ body: "cached bundle" });
    expect(worker.fetch).not.toHaveBeenCalled();
  });
});

describe("install", () => {
  it("precaches the document, the manifest and the icons", async () => {
    // `docs/pwa.md` promises these are available offline from the *first* load.
    // Nothing else can deliver that: the browser fetched the document before
    // this worker existed, so on-demand caching would never see it.
    const worker = loadWorker();
    await worker.lifecycle("install");
    expect([...worker.cacheStore.keys()].sort()).toEqual(
      [
        SCOPE,
        `${SCOPE}favicon.svg`,
        `${SCOPE}icon-192.png`,
        `${SCOPE}icon-512.png`,
        `${SCOPE}icon-maskable-512.png`,
        `${SCOPE}manifest.webmanifest`,
      ].sort(),
    );
  });

  it("bypasses the HTTP cache, so a stale document is not what gets frozen", async () => {
    const worker = loadWorker();
    await worker.lifecycle("install");
    expect(worker.fetch).toHaveBeenCalledWith(SCOPE, { cache: "reload" });
  });

  it("installs anyway when one file 404s, rather than leaving the user no worker", async () => {
    // Why this is not `cache.addAll`: that rejects the whole batch on one bad
    // URL, which fails the install over a single missing icon.
    const worker = loadWorker({ status: { [`${SCOPE}icon-512.png`]: 404 } });
    await expect(worker.lifecycle("install")).resolves.toBeUndefined();
    expect(worker.cacheStore.has(SCOPE)).toBe(true);
    expect(worker.cacheStore.has(`${SCOPE}icon-512.png`)).toBe(false);
  });

  it("installs anyway with no network at all", async () => {
    const worker = loadWorker({ networkFails: true });
    await expect(worker.lifecycle("install")).resolves.toBeUndefined();
    expect(worker.cacheStore.size).toBe(0);
  });
});

describe("activate", () => {
  it("drops every stale cache and keeps the current one", async () => {
    const worker = loadWorker();
    worker.cacheNames.push("parkcast-v0", worker.CACHE_NAME, "some-other-app");
    await worker.lifecycle("activate");
    expect([...worker.deleted].sort()).toEqual(["parkcast-v0", "some-other-app"]);
    // Deleting the current cache would silently empty the app on every update:
    // no test fails, nothing errors, and offline simply stops working.
    expect(worker.deleted).not.toContain(worker.CACHE_NAME);
  });
});

describe("what actually lands in the cache", () => {
  it("stores a hashed asset on the first miss, which is the whole of offline", async () => {
    // Delete the one `cache.put` in `cacheFirst` and offline stops working
    // entirely -- with every routing assertion in this file still green.
    const worker = loadWorker();
    const url = `${SCOPE}assets/index-B7xK1a2c.js`;
    await expect(respondTo(worker, request(url))).resolves.toMatchObject({ body: `network:${url}` });
    expect(worker.cacheStore.get(url)).toMatchObject({ body: `network:${url}` });
  });

  it("consults isCacheable before storing, so a 206 or a 404 never lands", async () => {
    // `isCacheable` is tested as a pure function above, which proves nothing
    // about whether the code that writes to the cache ever calls it. This is
    // that test: the headline "we never cache a partial response" guarantee.
    const asset = `${SCOPE}assets/index-B7xK1a2c.js`;
    const artifact = `${SCOPE}artifacts/grid.bin`;
    const worker = loadWorker({ status: { [asset]: 404, [artifact]: 206 } });

    // Both still reach the page unchanged -- the worker filters what it keeps,
    // not what it serves.
    await expect(respondTo(worker, request(asset))).resolves.toMatchObject({ status: 404 });
    await expect(respondTo(worker, request(artifact))).resolves.toMatchObject({ status: 206 });
    expect([...worker.cacheStore.keys()]).toEqual([]);
  });

  it("never writes the navigation response back", async () => {
    // Critical: `index.html` is unhashed and the bundles it names are cached
    // separately and later, so a shell refreshed at runtime can outrun them.
    // Losing signal in that window leaves a cached document whose scripts are
    // not on disk -- a blank page with the right title. The shell has exactly
    // one writer, `install`.
    const worker = loadWorker();
    await expect(respondTo(worker, request(SCOPE, { mode: "navigate" }))).resolves.toMatchObject({
      body: `network:${SCOPE}`,
    });
    expect(worker.cacheStore.has(SCOPE)).toBe(false);
  });

  it("leaves the installed shell untouched when a newer one is fetched online", async () => {
    const worker = loadWorker();
    await worker.lifecycle("install");
    const installed = worker.cacheStore.get(SCOPE);
    await respondTo(worker, request(SCOPE, { mode: "navigate" }));
    await respondTo(worker, request(`${SCOPE}index.html`, { mode: "navigate" }));
    expect(worker.cacheStore.get(SCOPE)).toBe(installed);
    expect(worker.cacheStore.has(`${SCOPE}index.html`)).toBe(false);
  });
});

describe("a cache that cannot be written or read", () => {
  // Every one of these calls happens inside `respondWith`. An escaping rejection
  // is rendered as a network error for a response that arrived perfectly well,
  // which would make this worker strictly worse than no worker at all -- and
  // persistently so, since a full quota does not clear itself.
  it("serves a cache-first miss when the quota is full", async () => {
    const worker = loadWorker({ quotaFails: true });
    const url = `${SCOPE}assets/index-B7xK1a2c.js`;
    await expect(respondTo(worker, request(url))).resolves.toMatchObject({ body: `network:${url}` });
  });

  it("serves the fresh artifact when the quota is full, not the stale cached one", async () => {
    // The second-order bug: a `keep()` rejection landing in the handler that
    // exists for being *offline* downgrades a fresh forecast to the stale copy,
    // contradicting "a forecast from the network beats one from disk every
    // time" while the network is perfectly healthy.
    const worker = loadWorker({ quotaFails: true });
    const url = `${SCOPE}artifacts/lots.json`;
    worker.cacheStore.set(url, response(200, "basic", "yesterday"));
    await expect(respondTo(worker, request(url))).resolves.toMatchObject({ body: `network:${url}` });
  });

  it("serves every route from the network when site data is blocked", async () => {
    // A private window, or "block all cookies": `caches.match` itself rejects,
    // so an unguarded read fails *every* intercepted request rather than one.
    const worker = loadWorker({ storageFails: true });
    for (const req of [
      request(`${SCOPE}assets/index-B7xK1a2c.js`),
      request(`${SCOPE}artifacts/grid.bin`),
      request(SCOPE, { mode: "navigate" }),
    ]) {
      await expect(respondTo(worker, req)).resolves.toMatchObject({ body: `network:${req.url}` });
    }
  });

  it("still reports being offline when there is no cache to fall back on", async () => {
    // Swallowing storage errors must not swallow a genuine network failure --
    // the page has to see it to render its own error state.
    const worker = loadWorker({ networkFails: true, storageFails: true });
    await expect(respondTo(worker, request(`${SCOPE}artifacts/grid.bin`))).rejects.toThrow();
  });
});

describe("the shell's static fallback", () => {
  // Not decoration, and not something React can own: it has to be in the file
  // the worker caches, because the case it covers is the one where no script
  // ran. Deleting it turns that case back into a blank white page with the
  // right title, which is indistinguishable from a hung app -- and nothing else
  // in the suite would notice.
  const html = readFileSync(join(PUBLIC, "..", "index.html"), "utf8");
  const root = html.slice(html.indexOf('<div id="root">'), html.indexOf("</body>"));

  it("says the app could not load, in both of the app's languages", () => {
    expect(root).toMatch(/could not load/i);
    expect(root).toContain("停車先知無法載入");
  });

  it("carries its own styles, because the stylesheet may be the missing file", () => {
    expect(root).toMatch(/style="[^"]*font-family/);
  });
});

describe("the update policy", () => {
  it("never takes over a running page", () => {
    // Load-bearing, and cheapest to assert against the source: claiming clients
    // mid-session swaps hashed chunks under a page that has not yet lazy-loaded
    // its map chunk, and the map is a `React.lazy` boundary.
    //
    // Comments are stripped first -- the file explains at length *why* it does
    // not call `skipWaiting()`, and a naive substring match would fail on the
    // explanation while passing on the call.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/skipWaiting/);
    expect(code).not.toMatch(/clients\s*\.\s*claim/);
  });
});
