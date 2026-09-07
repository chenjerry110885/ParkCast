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
 * ## Nothing here may fail a request
 *
 * Every cache operation is best-effort and every failure is swallowed. A browser
 * with site data blocked -- a private window, or "block all cookies" -- rejects
 * `caches.open`, `caches.match` and `cache.put` outright, and a full quota
 * rejects the write. Those rejections are reached from inside
 * `event.respondWith`, so letting one through renders a network error for a
 * response that was fetched successfully: strictly worse than shipping no worker
 * at all, and persistent. Losing a cache entry is acceptable. Losing the
 * response is not. That is what `cached()` and `keep()` are for, and it is why
 * neither of them ever rejects.
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
 *
 * **This is the only writer of the cached shell**, and that is load-bearing.
 * Caching the navigation response as well would refresh `index.html` on every
 * online visit while the hashed bundles it names are cached separately and
 * later -- so losing signal in that window (driving into a basement, which is
 * this app's own headline scenario) leaves a cached shell pointing at bundles
 * that are not on disk, and the app opens as a blank white page with the right
 * title. Writing the shell only here keeps the offline pair at one version of
 * each. Online is unaffected: navigations are network-first regardless.
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
 *  5. **Navigations** -- network-first, and *never written back*. `index.html`
 *     is the one file Vite does *not* hash, so it is the one file for which "a
 *     cached URL can never be stale" is false: serving it cache-first would pin
 *     the app to whichever hashed bundle names the first visit happened to see,
 *     forever. The fallback copy comes from `PRECACHE` alone -- see there for
 *     why the runtime must not touch it.
 *
 *  6. **Everything else** -- cache-first. That is `/assets/*`, whose filenames
 *     Vite hashes, so a cached URL genuinely cannot be stale: a changed file has
 *     a different name and is simply a cache miss. It is also the unhashed
 *     icons and the manifest, which is a real if minor caveat: those names are
 *     fixed, so a cached copy *can* be stale, and nothing revalidates it until
 *     `VERSION` is bumped. Traded on purpose -- an icon is not worth a
 *     conditional request on every load.
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
 * prevent.
 *
 * There is deliberately no separate test for `type === "opaque"`: an opaque
 * response has an unreadable status, which the platform reports as `0`, so
 * `status === 200` already excludes every one of them. The clause that used to
 * be here was dead code, and the test that appeared to cover it passed
 * `status: 0` and so proved only what the status check already guarantees.
 */
function isCacheable(response) {
  return Boolean(response) && response.status === 200;
}

/**
 * Read from the cache, treating any storage failure as a miss.
 *
 * `caches.match` rejects outright where site data is blocked, and this is called
 * from inside `respondWith`, so an unguarded rejection would fail *every*
 * intercepted request in a private window. A miss falls through to the network,
 * which is the correct behaviour for a browser that cannot store anything.
 */
async function cached(key) {
  try {
    return await caches.match(key, { cacheName: CACHE_NAME });
  } catch {
    return undefined;
  }
}

/**
 * Store a response, best-effort.
 *
 * Both callers `await` this *before returning a response they already fetched
 * successfully*, so a rejection here would turn a healthy 200 into a rendered
 * network error -- and inside `networkFirst` it would be caught by the handler
 * that exists for being offline, silently downgrading a fresh forecast to the
 * stale cached one. Hence: swallow. A quota error costs a cache entry, and that
 * is all it may cost.
 */
async function keep(request, response) {
  if (!isCacheable(response)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch {
    // Out of quota, or storage is switched off. The response is unaffected.
  }
}

async function cacheFirst(request) {
  const hit = await cached(request);
  if (hit) return hit;
  const response = await fetch(request);
  await keep(request, response);
  return response;
}

async function networkFirst(request, scope) {
  try {
    const response = await fetch(request);
    // Artifacts are written back; the document is not. See `PRECACHE`: a shell
    // refreshed here would outrun the hashed bundles it names, and the pair is
    // only consistent offline if one writer owns it.
    if (request.mode !== "navigate") await keep(request, response);
    return response;
  } catch (error) {
    const hit = await cached(request);
    if (hit) return hit;
    // A navigation to `/ParkCast/index.html` and one to `/ParkCast/` are
    // different cache keys for the same document, and the precache only holds
    // the second. Offline is exactly when that difference must not matter.
    if (request.mode === "navigate") {
      const shell = await cached(scope);
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
