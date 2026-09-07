/*
 * ParkCast's service worker: open the app in a basement car park.
 *
 * The whole read path is two static files and a tile archive, so there is
 * nothing here that *needs* a network -- only something that needs a cache. A
 * cached forecast is still honest because every artifact carries its own
 * `base_data_ts`: the UI already renders an age and expires the forecast on its
 * own, and this file deliberately adds no second notion of freshness. An
 * "you are offline" badge would be a prettier lie than the age line already
 * tells the truth about.
 *
 * ## Why there is no precache manifest
 *
 * Vite does not process `public/`, so this file cannot see the hashed asset
 * names. Generating a manifest would mean a build plugin, i.e. a new dependency
 * on a project that has spent four plans avoiding them. So responses are cached
 * **as they are fetched**. The cost is one uncached load; the benefit is that
 * this worker has no build-time coupling at all and cannot ship a manifest that
 * disagrees with the bundle.
 *
 * `PRECACHE` below is not a manifest -- it is the short, hand-written list of
 * files whose names are fixed forever because they are not hashed.
 *
 * ## Versioning
 *
 * A browser updates a worker when its **bytes** change, so editing this file at
 * all is what ships a new worker. Bump `VERSION` when you additionally want the
 * accumulated cache dropped -- old hashed assets are never evicted otherwise,
 * and `activate` deletes every cache that is not the current one.
 */

const VERSION = "v1";
const CACHE_NAME = `parkcast-${VERSION}`;

/**
 * Where this worker is served from, which is also its scope: `sw.js` sits at
 * the deployment root, so `./` relative to it is `/ParkCast/` in production and
 * `/` when previewing at a root. Deriving it beats hardcoding a base that
 * `vite.config.ts` is allowed to override via `PARKCAST_BASE`.
 */
const SCOPE = new URL("./", self.location.href).href;

/**
 * Unhashed files, listed by hand. Fetched at install so the *document* is
 * available offline from the first load onward -- it is the one file Vite does
 * not hash, and the one the browser has already fetched by the time this worker
 * exists, so on-demand caching alone would never reach it on a first visit.
 */
const PRECACHE = [
  "./",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

/** Serve from cache, fall back to the network. */
const CACHE_FIRST = "cache-first";
/** Try the network, fall back to cache. */
const NETWORK_FIRST = "network-first";
/** Do not touch this request at all. */
const PASSTHROUGH = "passthrough";

/**
 * Which strategy a request gets. Pure, total, and the only interesting decision
 * in this file -- which is why it is a separate function with its own tests
 * (`web/tests/swRouting.test.ts`) rather than a chain of `if`s inside the
 * `fetch` listener where nothing can reach it.
 *
 * `request` needs only `url`, `method`, `mode` and `headers`; `scope` is an
 * absolute URL ending in `/`.
 *
 * The rules, in order, and every one of them is load-bearing:
 *
 *  1. **Not a GET, or not ours** -- passthrough. Nothing else in this app makes
 *     a POST, but a worker that quietly cached one would be a nasty surprise.
 *
 *  2. **Anything carrying a `Range` header** -- passthrough. A partial response
 *     is `206`, and a cache that stores a 206 and later replays it against a
 *     *different* range hands back the wrong bytes. This is the general form of
 *     rule 3, and it is here so that a future range-reading client is safe
 *     before anyone remembers to add it to the list.
 *
 *  3. **The basemap** -- passthrough, unconditionally. `taipei.pmtiles` is 23 MB
 *     read by HTTP range request, and naively caching its `206 Partial Content`
 *     responses is a well-known way to serve corrupt tiles. The browser's own
 *     HTTP cache handles it correctly; there is nothing to improve here, and an
 *     attempt to improve it would be a regression. Leave it alone.
 *
 *  4. **The artifacts** -- network-first. A forecast from the network beats one
 *     from disk every time. The cached copy is the fallback, and it carries its
 *     own timestamp, so falling back costs honesty nothing.
 *
 *  5. **Navigations** -- network-first. `index.html` is the one file Vite does
 *     *not* hash, so it is the one file for which "a cached URL can never be
 *     stale" is false: serving it cache-first would pin the app to whichever
 *     hashed bundle names the first visit happened to see, forever. Same
 *     strategy as the artifacts, for the same reason -- freshness matters and a
 *     stale copy is still a working one.
 *
 *  6. **Everything else** -- cache-first. That is `/assets/*`, whose filenames
 *     Vite hashes, so a cached URL genuinely cannot be stale: a changed file has
 *     a different name and is simply a cache miss.
 */
function routeFor(request, scope) {
  if (request.method !== "GET") return PASSTHROUGH;

  let url;
  let base;
  try {
    url = new URL(request.url);
    base = new URL(scope);
  } catch {
    return PASSTHROUGH;
  }
  if (url.origin !== base.origin) return PASSTHROUGH;
  if (!url.pathname.startsWith(base.pathname)) return PASSTHROUGH;

  // `headers` is optional so the function stays callable with a plain object.
  if (request.headers && request.headers.get && request.headers.get("range")) {
    return PASSTHROUGH;
  }

  const path = url.pathname.slice(base.pathname.length);
  if (path.startsWith("basemap/") || path.endsWith(".pmtiles")) return PASSTHROUGH;
  if (path.startsWith("artifacts/")) return NETWORK_FIRST;
  if (request.mode === "navigate") return NETWORK_FIRST;
  return CACHE_FIRST;
}

/** Cache names to delete on activate: every one that is not the current one. */
function staleCaches(names, current) {
  return names.filter((name) => name !== current);
}

/**
 * Whether a response is safe to keep.
 *
 * `206` is rejected explicitly and not merely by `ok` (which is true for 206),
 * because storing a partial response is the exact failure rule 2 above exists to
 * prevent. Opaque cross-origin responses are rejected because their status is
 * unreadable, so "did this succeed" is unanswerable -- and this app has no
 * third-party origins to fetch from in the first place.
 */
function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type !== "opaque";
}

async function keep(request, response) {
  if (!isCacheable(response)) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: CACHE_NAME });
  if (cached) return cached;
  const response = await fetch(request);
  await keep(request, response);
  return response;
}

async function networkFirst(request, scope) {
  try {
    const response = await fetch(request);
    await keep(request, response);
    return response;
  } catch (error) {
    const cached = await caches.match(request, { cacheName: CACHE_NAME });
    if (cached) return cached;
    // A navigation to `/ParkCast/index.html` and one to `/ParkCast/` are
    // different cache keys for the same document, and the precache only holds
    // the second. Offline is exactly when that difference must not matter.
    if (request.mode === "navigate") {
      const shell = await caches.match(scope, { cacheName: CACHE_NAME });
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener("install", (event) => {
  // Best-effort, one request at a time rather than `cache.addAll`: that rejects
  // the whole batch if any single URL fails, which would fail the install and
  // leave the user with no worker at all over one missing icon.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE.map(async (path) => {
          const url = new URL(path, SCOPE).href;
          try {
            const response = await fetch(url, { cache: "reload" });
            if (isCacheable(response)) await cache.put(url, response);
          } catch {
            // Fine. On-demand caching picks it up on the next load.
          }
        }),
      );
    })(),
  );
  // No `skipWaiting()`, on purpose. Claiming clients mid-session swaps the cache
  // under a page that has not yet lazy-loaded its map chunk -- and the map is a
  // `React.lazy` boundary, so that is a live code path, not a hypothetical. One
  // visit of lag on the shell is the cheaper failure, and the data is
  // network-first anyway.
  //
  // A waiting worker takes over once *no client is controlled by the old one*,
  // which is a stronger condition than a reload: measured in Edge 152, a
  // same-tab reload left the old worker active with the new one waiting, and
  // handover happened only after navigating the tab away and back. Say "the next
  // time the app is closed and reopened", not "the next reload".
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(staleCaches(names, CACHE_NAME).map((name) => caches.delete(name)));
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const route = routeFor(event.request, SCOPE);
  // Returning without calling `respondWith` is what "do not intercept" means:
  // the browser performs the request itself, range headers and all.
  if (route === PASSTHROUGH) return;
  if (route === NETWORK_FIRST) {
    event.respondWith(networkFirst(event.request, SCOPE));
    return;
  }
  event.respondWith(cacheFirst(event.request));
});
