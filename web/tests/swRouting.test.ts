/**
 * Tests for `web/public/sw.js`.
 *
 * The worker is not processed by Vite -- that is the whole point of it living in
 * `public/` -- so there is nothing to `import`. These tests read the file that
 * actually ships and evaluate it with a stubbed worker global, which means they
 * cannot drift from the deployed byte stream the way a copied-out helper would.
 *
 * The routing decision is the valuable part: which requests are the app shell,
 * which are artifacts, and which must not be touched at all.
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
  fetch: ReturnType<typeof vi.fn>;
  cacheStore: Map<string, FakeResponse>;
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
function loadWorker(options: { location?: string; networkFails?: boolean } = {}): Worker {
  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStore = new Map<string, FakeResponse>();

  const self = {
    location: { href: options.location ?? WORKER_URL },
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(type, handler);
    },
  };

  const fetchStub = vi.fn(async (input: string | FakeRequest) => {
    if (options.networkFails) throw new TypeError("offline");
    const url = typeof input === "string" ? input : input.url;
    return response(200, "basic", `network:${url}`);
  });

  const caches = {
    async match(key: string | FakeRequest) {
      return cacheStore.get(typeof key === "string" ? key : key.url);
    },
    async open() {
      return {
        async put(key: string | FakeRequest, value: FakeResponse) {
          cacheStore.set(typeof key === "string" ? key : key.url, value);
        },
      };
    },
    async keys() {
      return [] as string[];
    },
    async delete() {
      return true;
    },
  };

  const factory = new Function(
    "self",
    "caches",
    "fetch",
    `${SOURCE}\nreturn { routeFor, staleCaches, isCacheable, CACHE_NAME, SCOPE };`,
  );
  const exported = factory(self, caches, fetchStub);

  return {
    ...exported,
    fetch: fetchStub,
    cacheStore,
    dispatch(type, event) {
      const handler = listeners.get(type);
      if (!handler) throw new Error(`the worker registered no "${type}" listener`);
      handler(event);
    },
  };
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
    expect(worker.isCacheable(response(0, "opaque"))).toBe(false);
    expect(worker.isCacheable(null)).toBe(false);
  });
});

describe("the fetch listener", () => {
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
