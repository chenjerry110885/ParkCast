# Installing ParkCast, and opening it with no signal

A driver looking for a space is often in a basement car park, and a basement car park has no
signal. ParkCast's whole read path is two static files and a tile archive, so it can work down
there: nothing needs a server, only a cache.

Three pieces make that true -- generated icons, a web app manifest, and a service worker. None of
them adds a dependency, a build plugin, or a third-party origin.

## Icons

```bash
python scripts/build-icons.py
```

Writes four files into `web/public/`, all committed:

| file | size | purpose |
|---|---|---|
| `favicon.svg` | 377 B | browser tab |
| `icon-192.png` | 1,788 B | manifest, `purpose: any` |
| `icon-512.png` | 5,587 B | manifest, `purpose: any` |
| `icon-maskable-512.png` | 3,485 B | manifest `purpose: maskable`, and `apple-touch-icon` |

The mark is a white parking `P` on the app's own accent blue (`--accent`, `#1d5fd0`). It has to
read at 16 px in a browser tab, so it is a legibility exercise and not a branding one.

**No image library.** `scripts/build-icons.py` is pure standard library: `zlib` for the pixel
stream, `struct` for the PNG chunk headers, and a 4x supersampled coverage pass standing in for
anti-aliasing. Pillow would be a new dependency on a project whose premise is no cost and no new
attack surface, to draw a rounded square and a letter.

The SVG is emitted from the same geometry the PNGs are rasterised from, so the two cannot drift.
Edit the constants in the script, re-run it, and commit the result -- do not edit the outputs.

**The maskable variant is a different image, not a resize.** Android applies its own mask -- circle,
squircle, teardrop -- and guarantees only the central 80% survives. So that file is full bleed with
no transparency anywhere and the glyph shrunk into the safe zone: an icon with transparent corners
paints those corners as holes behind whatever shape the launcher picked. `web/tests/icons.test.ts`
asserts both halves of that (every pixel opaque, every pixel outside the safe zone still accent
blue), because it is invisible until it is on someone's home screen.

## Manifest

`web/public/manifest.webmanifest`. `start_url`, `scope` and every icon `src` are **relative**
(`./`), and that is load-bearing: the app deploys to GitHub Pages under `/ParkCast/`, Vite does not
process a `.webmanifest`, and so nothing rewrites an absolute path in it with the deployment base.
`"/"` would scope the installed app to the whole `github.io` origin and start it on somebody else's
project.

`index.html` is the opposite case: Vite *does* rewrite a leading-slash `href` that resolves into
`public/`, so the links there are written absolute and come out as `/ParkCast/...` in a build.

## Service worker

`web/public/sw.js`, registered from `main.tsx` **only under `import.meta.env.PROD`**. A worker in
front of the Vite dev server serves yesterday's module for today's edit, and the resulting bug reads
as haunted code rather than as a caching problem.

### Routing

| request | strategy | why |
|---|---|---|
| `taipei.pmtiles`, anything under `basemap/`, anything with a `Range` header | **never intercepted** | 23 MB read by HTTP range request. Caching `206 Partial Content` naively is a well-known way to serve corrupt tiles. The browser's own HTTP cache handles it correctly. |
| `artifacts/grid.bin`, `artifacts/lots.json` | **network-first**, cache as fallback | A forecast from the network beats one from disk every time. |
| navigations (`index.html`) | **network-first**, cache as fallback, and **never written back** | `index.html` is the one file Vite does *not* hash, so it is the one file for which "a cached URL cannot be stale" is false. Cache-first would pin the app to whichever hashed bundle names the first visit saw. The fallback copy is the one `install` stored and the runtime never replaces it -- see [one writer for the shell](#the-cached-shell-has-exactly-one-writer). |
| hashed assets (`assets/*`) | **cache-first** | Vite hashes these filenames, so a changed file has a different name and is simply a cache miss. |
| unhashed files under scope (`manifest.webmanifest`, `favicon.svg`, `icon-*.png`) | **cache-first, and nothing revalidates them** | A real if minor caveat, and the reason this is its own row: their names are fixed, so unlike `assets/*` a cached copy genuinely *can* be stale, and it stays until `VERSION` is bumped and `activate` drops the old cache. Traded on purpose -- an icon is not worth a conditional request on every load -- but it does mean re-running `build-icons.py` is not enough to ship a new icon. |
| non-GET, other origins, outside scope | **never intercepted** | The origin check is not redundant with the scope check. Under `PARKCAST_BASE=/` the scope prefix is `/`, which every path starts with, so origin is the only thing left. |

### The cached shell has exactly one writer

`install` stores `index.html`; the runtime never does. This is load-bearing rather than tidy.

`index.html` is unhashed and the bundles it names are cached separately and *later* -- so if the
navigation response were also written back, an online visit would refresh the shell while the
bundles it points at were still being fetched. Lose signal in that window -- driving into a basement,
which is this app's entire premise -- and the cached shell references bundles that are not on disk.
Measured, with the server genuinely stopped:

```
RESP 200 fromSW=true  /ParkCast/
FAIL  net::ERR_FAILED type=Script
RESP 200 fromSW=true  /ParkCast/assets/index-Bmp4thyU.css
app rendered: false
```

A page with the right title and nothing in it. With one writer the offline pair stays at one version
of each, and the same measurement renders the app in full. Online is unaffected: navigations are
network-first either way.

**And `index.html` ships a static fallback inside `#root`** -- two lines, English and 繁體中文,
saying the app could not load and to reload when back online. React clears the container on its
first render, so it is invisible in a working app (asserted both ways in the measurement above). It
exists because the shell/bundle window cannot be closed completely without a precache manifest: the
worker does not control the page that installs it, so a first visit interrupted before the second
load has a cached document and no cached bundles. That case now shows a sentence instead of a white
page.

### Nothing in the worker may fail a request

Every cache operation is best-effort and every failure is swallowed. This is not defensive
programming for its own sake -- `caches.open`, `caches.match` and `cache.put` all reject on a full
quota or in a browser with site data blocked, and all of them are reached from inside
`event.respondWith`. A rejection that escapes is rendered as a network error **for a response that
was fetched perfectly well**, which is strictly worse than shipping no worker at all, and a full
quota does not clear itself.

Measured with `Storage.overrideQuotaForOrigin` set to one byte over CDP, network healthy throughout:

| | unguarded | guarded |
|---|---|---|
| cache-first miss | `REJECTED TypeError: Failed to fetch` | `OK status 200` |
| artifact with a stale cached copy | served the stale copy | served the fresh network response |

The second row is the subtler half. A `cache.put` rejection inside `networkFirst` was caught by the
handler that exists for being *offline*, so a full quota quietly downgraded a fresh forecast to
yesterday's -- contradicting the "a forecast from the network beats one from disk every time" row
above while the network was fine.

### Why offline is honest here

Every artifact carries its own `base_data_ts`, and the UI already renders an age from it and expires
the forecast on its own. So a cached forecast tells the truth about how old it is without the worker
doing anything. **The worker deliberately adds no second notion of freshness** -- an "you are
offline" badge would be a prettier lie than the age line already tells the truth about, and two
notions of staleness would eventually disagree.

Offline, the app renders in full -- the ranked list, the arrival-time scrubber, every lot marker on
the map, and the age line -- on a **blank basemap**. The roads and labels come from the 23 MB
`.pmtiles` archive that the worker deliberately never caches, so whatever the browser's own HTTP
cache still holds is what draws. That is the trade being made on purpose: the answer to the question
survives offline, the scenery may not.

### Why there is no precache manifest

Vite does not process `public/`, so `sw.js` cannot see the hashed asset names. Generating a manifest
would mean a build plugin, i.e. a new dependency. Responses are cached **as they are fetched**
instead. The `PRECACHE` list in the worker is not a manifest -- it is the short, hand-written list of
files whose names are fixed forever because they are not hashed (`./`, the manifest, the icons).

**What that means in practice.** The document, the manifest and the icons are cached when the worker
installs, on the first load. The hashed bundles and the artifacts are cached the first time the
worker *sees them fetched* -- and on a first load the worker does not yet control the page, so that
is the second load. So: **load one installs the worker, load two is the first one it can cache, and
from there the app opens with no network.** That is one load later than a precache manifest would
give, and it is the price of not having a build plugin.

### No `skipWaiting`, no `clients.claim`

Claiming clients mid-session swaps the cache under a page that has not yet lazy-loaded its map chunk
-- and `MapView` is a `React.lazy` boundary, so that is a live code path and not a hypothetical. One
visit of lag on the shell is the cheaper failure, and the data is network-first regardless.
`web/tests/swRouting.test.ts` asserts neither call appears in the shipped source.

**A waiting worker needs more than a reload**, and it is worth being precise about because the
obvious phrasing is wrong. It activates once *no client is controlled by the old worker*. Measured
in Edge 152: after changing `sw.js` and rebuilding, a same-tab reload left the old worker `active`
and the new one `waiting` -- handover happened only after navigating the tab away and back, at which
point `activate` also dropped the old cache. So the honest wording is "the next time the app is
closed and reopened", not "the next reload".

None of that delays a *content* change. `index.html` is network-first, so a reload after a deploy
loads the new hashed bundles through the old worker immediately -- verified: after a rebuild the
reloaded page ran `index-DFwMeP80.js` while the v1 worker was still in control.

### `PARKCAST_BASE` takes a path, not a URL

`vite.config.ts` lets `PARKCAST_BASE` override the deployment base, and describes it as being for "a
root domain or a CDN prefix". A **path** works either way: `/ParkCast/` (the default) and `/` both
deploy correctly, and `sw.js` derives its scope from its own location rather than hardcoding either.

An **absolute URL** -- `PARKCAST_BASE=https://cdn.example.com/parkcast/` -- builds, serves, looks
fine, and silently turns the entire PWA off:

- `main.tsx` registers `${BASE_URL}sw.js`, which is now a cross-origin script. Measured in Edge 152:
  `SecurityError: Failed to register a ServiceWorker: The origin of the provided scriptURL
  ('https://cdn.example.com') does not match the current origin`. Registration failures are
  swallowed on purpose, so nothing is logged and nothing looks broken -- there is simply no worker.
- Even given a worker, the artifacts would be on another origin, and rule 1 routes another origin to
  passthrough. Nothing cached, so nothing offline.

This cannot be fixed inside the worker: a service worker may not be served cross-origin, by design.
If the app ever needs a CDN, the document and `sw.js` have to stay on the app's own origin and only
`assets/*` can move -- which also means the routing rules would need revisiting. Until then, treat
`PARKCAST_BASE` as a path.

### Versioning

A browser updates a worker when its **bytes** change, so editing `sw.js` at all ships a new worker.
Bump `VERSION` when you additionally want the accumulated cache dropped: `activate` deletes every
cache that is not the current one, and old hashed assets are never evicted otherwise.

## Verifying by hand

```bash
npm run build --prefix web
npm run preview --prefix web   # http://localhost:4173/ParkCast/
```

`vite.config.ts` gives `preview` the same `/ParkCast/` base as a build, because it serves that
build's HTML and that HTML already points at `/ParkCast/assets/...`. Restart the preview server after
any rebuild that *adds* a file -- it snapshots the directory once at boot, so a file created later
404s into the SPA fallback and comes back as `index.html` with a 200.

Then, in DevTools:

- **Application → Manifest** parses with no errors and shows all three icons.
- **Application → Service Workers** shows one activated worker scoped to `/ParkCast/`.
- Reload once, then **Network → Offline** and reload again: the list still renders, with the
  staleness line reporting an honest age, on a blank basemap.
- **Network** shows `taipei.pmtiles` requests served by the browser, *not* by the worker (no
  "ServiceWorker" in the Size column), and returning `206`.
- After changing `sw.js` and rebuilding, the new worker sits in "waiting" until every tab on the app
  has been closed -- a reload alone will not hand over.

**Two traps when checking offline behaviour, both measured the hard way.**

*Emulated offline is not offline.* CDP's `Network.emulateNetworkConditions` does not apply to
fetches made from *inside* a service worker, so a page can look offline while the worker is quietly
still reaching the server -- which is exactly backwards for testing a worker. To test the real
thing, **stop the server**. `vite preview` also snapshots `dist/` at boot, so restart it after any
build that adds a file, or drive the checks against a static server that reads from disk per request.

*A missing file is not always a 404.* `vite preview` answers an unknown path with `index.html` and a
200, so deleting an asset to simulate a failed fetch gets the worker to cache HTML under a `.js`
URL. GitHub Pages returns a real 404 there. Do not reason about caching behaviour from a
preview-server 404.
