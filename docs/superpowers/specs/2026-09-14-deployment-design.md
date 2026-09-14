# ParkCast deployment — design

**Date:** 2026-09-14 · **Status:** approved in conversation (Parts 1–3); revised after an adversarial
security review (§14); awaiting the user's review of this written spec
**Path:** architectural (new subsystem: public hosting plus a data pipeline off the collector)

---

## 1. Goal and hard requirements

Put the PWA on the public internet with a forecast that stays fresh, under requirements the user set
explicitly and repeated:

1. **Free, for the prototype and for future enhancements.** No payment method on any account; no
   product that can bill.
2. **A free address:** `https://parkcast.<account-subdomain>.workers.dev`. No custom domain.
3. **Local first.** Enhancements are tested on the desktop against the live forecast, then deployed.
4. **Strict security.** No loop in our own code can burn a limit; users and bots cannot flood the limits
   beyond what a free address allows (§6.3); no repository source is uploaded beyond the Worker's own
   bundle (which Cloudflare holds, visible to the account only); no attacker can alter what the site
   shows without the upload secret, and even with it cannot blank the site or lock out the collector;
   **the desktop cannot be compromised through any of this.**

The collector keeps running on the desktop. The user sometimes pauses it while gaming; the site must
survive that and no check may treat it as a failure.

## 2. Decisions, and what was rejected

Every limit below was read from the provider's own documentation on 2026-09-14 (sources in §13).

| Option | Verdict | Why |
|---|---|---|
| **Cloudflare Workers + static assets + Workers KV** | **chosen** | Workers Free needs no card and "cannot result in charges": past a limit, operations "fail with an error". Static-asset requests are "free and unlimited". KV is included in Workers Free. |
| Cloudflare R2 for the forecast | rejected | Enabling R2 requires a payment method, and R2 is billed separately — a free guarantee would rest on usage staying low, not on a hard cap. |
| Cloudflare Pages | not chosen | Same free limits here; Workers has the broader feature set and Cloudflare publishes a Pages → Workers migration guide. Pages is not documented as deprecated. |
| GitHub Pages | rejected | Every 5-minute forecast would be a site deploy; GitHub serves `Cache-Control: max-age=600` (measured); pushing data on a timer is the "24/7 polling cron" use the project spec rules out; the credential on the desktop could rewrite the repository. |
| Netlify | rejected | A production deploy costs 15 of 300 free monthly credits — about 20 deploys a month. |
| Serve from the desktop (e.g. a tunnel) | rejected | The site would go down whenever the PC or Docker is off, and it opens a path from the internet towards the PC. |

## 3. Architecture

```
 desktop                                                 Cloudflare (Workers Free)
 ┌───────────────────────────────────────────┐          ┌──────────────────────────────────────────┐
 │ collect → publish data/artifacts/          │  HTTPS   │ Worker "parkcast"                        │
 │         → hand bytes to upload thread ─────┼─────────►│  path not /artifacts/* → constant 404    │
 │  outbound only; nothing listens            │   PUT    │  PUT /artifacts/latest (prod host only)  │
 └───────────────────────────────────────────┘          │     → auth → validate → 1 KV write        │
                                                         │  GET /artifacts/{grid.bin,lots.json}     │
 browser ──────────────── GET ─────────────────────────►│     ← in-isolate copy ← KV (≤1 read/min) │
                                                         │  static assets: app, 404.html, basemap   │
                                                         │ KV: one key "latest" (+ preview namespace)│
                                                         └──────────────────────────────────────────┘
```

- **One Worker,** `parkcast`, on `workers.dev`, with static assets from the production build (`web/dist`,
  including `basemap/taipei.pmtiles`, ~23 MB, under the 25 MiB per-file limit — its presence and size
  are gated on every deploy, §8.3, because without it every tile request would reach the Worker).
- **Worker code is placed first only for `/artifacts/*`** (`run_worker_first: ["/artifacts/*"]`). Real
  files are served as static assets at no cost. A request that matches no file *may* still run the
  Worker (§10.2); the Worker's first statement answers any path outside `/artifacts/` with a constant
  `404` without touching storage or bindings.
- **Workers KV holds one key, `latest`:** `grid.bin` bytes followed by `lots.json` bytes, with metadata
  describing the split (§4.3). One write per publish; the two files are never served from different
  publishes. KV's up-to-60-second propagation is harmless on a 5-minute cadence, and the app already
  tolerates a cross-publish pair (`loadArtifacts` pairs by `rosterId`).
- **The collector hands each successful publish to an upload thread** (§5). Collection never waits on
  the network, and an upload failure never affects collection or the local publish.
- **When the collector is paused or the PC is off,** the site still loads, shows the last forecast with
  its age, and expires it after ~115 minutes as it does today.
- **The production build is served from `/`.** The GitHub Pages default base `/ParkCast/` in
  `web/vite.config.ts` is retired; `PARKCAST_BASE` remains an override.

### 3.1 Free-tier budget

| Resource (Free) | Limit | Our use | Headroom |
|---|---|---|---|
| Static asset requests | unlimited | app, basemap | — |
| Worker requests | 100,000 / day (resets 00:00 UTC = 08:00 Taipei) | 288 uploads; ~16 per open tab per hour with §4.2's cache headers (≤ ~60 without); dev tabs capped by §7 | thousands of tab-hours/day |
| KV reads | 100,000 / day | ≤ 1 per isolate per 60 s (§4.2) | bounded by Worker requests |
| KV writes | 1,000 / day, per write | 288; the 180-second rule caps *all* writers at 480/day (§4.3) | under the limit even with a stolen secret |
| KV storage | 1 GB | ~0.22 MB | — |
| Static asset file size | 25 MiB | basemap ~23 MB | gated on every deploy |
| CPU per request | 10 ms | upload path to be measured (§10.9) | fallback defined in §4.3 |

**Rules that keep it free:** stay on Workers Free; never add a payment method; never enable R2 or any
paid product; any future feature is a static file or a new forecast artifact inside this budget.

## 4. The Worker

Plain TypeScript with **zero runtime dependencies**. No scheduled triggers, no subrequests (`fetch` is
never called), no Durable Objects, `observability.enabled: false`, no logging of bodies or headers.

### 4.1 Routes (evaluated in this order)

| Request | Response | Storage |
|---|---|---|
| path not starting `/artifacts/` | `404`, constant body, before reading `env` | none |
| `GET`/`HEAD /artifacts/grid.bin`, `/artifacts/lots.json` | the bytes (§4.2) | 0–1 KV read |
| `PUT /artifacts/latest` on the production hostname | upload (§4.3) | none until auth passes; then ≤ 1 read + ≤ 1 write |
| `PUT /artifacts/latest` on any other hostname (preview URLs) | `404` | none |
| anything else under `/artifacts/` | `404` | none |
| wrong method on a known path | `405` with `Allow` | none |

**Every** Worker response carries `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and an explicit `Cache-Control`
(`_headers` does not apply to Worker-generated responses). A top-level `try/catch` turns any unexpected
error into a generic `500`. Error bodies never echo input.

### 4.2 Serving

- **In-isolate copy:** `{bytes, metadata, readAt}` in a module variable, refreshed from KV when older
  than 60 s. Concurrent refreshes share one in-flight promise (one expiry = one KV read). A "nothing
  stored" result is cached for 60 s too.
- **Headers:** `Content-Type` (`application/octet-stream` / `application/json; charset=utf-8`);
  `ETag` = the SHA-256 the Worker computed at upload, compared **weakly** against `If-None-Match`
  (Cloudflare may weaken ETags when compressing) → `304`.
  - `lots.json`: `Cache-Control: max-age=900` — it changes rarely, and the app already bypasses the HTTP
    cache when the roster moves (`web/src/artifacts.ts`, the `cache: "reload"` retry).
  - `grid.bin`: `Cache-Control: max-age=` `clamp(generatedAt + 330 − now, 0, 300)` — cached until the
    next publish is due, never longer.
  - **No CORS headers:** other sites' pages cannot read the forecast through visitors' browsers.
- **Nothing stored yet:** `503`; the app shows its existing "could not load" state.

### 4.3 Upload — checks in order

1. **Host, method, path:** `PUT /artifacts/latest` and `url.hostname` exactly equal to the `PRODUCTION_HOST`
   variable. Preview versions therefore can never write production data.
2. **Authentication before anything else.** `Authorization` present and ≤ 200 bytes, of the form
   `Bearer <secret>`. The Worker compares SHA-256 digests of the presented value and of `UPLOAD_SECRET`
   (the latter hashed once per isolate) with `crypto.subtle.timingSafeEqual`. Failure → `401`: **no
   body read, no storage.**
3. **Size.** `Content-Length` > 1 MiB → `413`; the body is read through a counting reader that aborts
   past 1 MiB whatever `Content-Length` claimed. `X-Grid-Length` must match `^[0-9]{2,7}$` and be
   ≤ the body length.
4. **Shape** (any failure → `422`, generic body):
   - `grid`: ≥ 21 bytes; magic `PCG1`; the version the app parses; `nHorizons` = 24; `stepMin` = 5;
     `1 ≤ nLots ≤ 4000` (4,000 rows of `lots.json` at ~215 B plus the grid stay under the 1 MiB cap);
     `21 + nLots × nHorizons` = `grid` length exactly.
   - `lots`: fatal UTF-8 decode; a JSON object; `v` matches; `n_lots` = `nLots`; `roster_id` = grid
     `rosterId`; `generated_at` and `base_data_ts` equal the grid header's; `lots` an array of length
     `n_lots`; each row: `i` equals its index, `y`/`x` finite and inside the bounding box in
     `src/parkcast/config.py`, `c` an integer ≥ 0 or `null`, strings ≤ 200 characters, `p.k` one of the
     kinds the app knows, `u` absent or an integer.
5. **Time and order** (all against the Worker's own clock, `now`; any failure → `409` with an enumerated
   `X-Reject: future|too-old|stale|too-soon|roster-shrink`, never echoing input):
   - `baseDataTs` ∈ [`now − 6 h`, `now + 10 min`]; `generatedAt` ∈ [`baseDataTs − 10 min`, `now + 10 min`].
   - Read the stored metadata (one KV read). **A stored value whose `baseDataTs` is more than 10 minutes
     in the future is void** and blocks nothing.
   - Newer means `baseDataTs > stored.baseDataTs`, or equal and `generatedAt > stored.generatedAt`
     (ordered by the feed's clock, so drift in the PC's clock cannot lock uploads out).
   - `now − stored.uploadedAt ≥ 180 s` (at most 480 writes a day from all writers combined).
   - `nLots ≥ 0.5 × stored.nLots`, unless the stored upload is more than 24 h old.
6. **Write** `put("latest", grid‖lots, {metadata})` with metadata computed by the Worker:
   `{v, gridLength, nLots, rosterId, generatedAt, baseDataTs, uploadedAt: now, gridSha256, lotsSha256}`
   (far under KV's 1,024-byte metadata limit). Refresh the in-isolate copy. `204`.

A rejected upload changes nothing; the previous forecast stays live.

**CPU fallback.** If §10.9 finds the upload path above 10 ms of CPU, the per-row checks in step 4 shrink
to `i`-equals-index plus the bounding box, then `lotsSha256` is dropped in favour of an ETag of
`generatedAt`; no other check is relaxed.

### 4.4 Configuration (`worker/wrangler.jsonc`, committed — nothing in it is secret)

`name: "parkcast"`; pinned `compatibility_date`; `workers_dev: true`; **`preview_urls: false`** (it
defaults to `workers_dev`); `observability: { enabled: false }`;
`assets: { directory: "../web/dist", run_worker_first: ["/artifacts/*"], not_found_handling:
"404-page" }` with a static `404.html`; `kv_namespaces: [{ binding: "ARTIFACTS", id: "<prod id>",
preview_id: "<separate namespace id>" }]`; `vars: { PRODUCTION_HOST: "parkcast.<sub>.workers.dev" }`;
`secrets: { required: ["UPLOAD_SECRET"] }`. The secret's value is set only with `wrangler secret put`.

## 5. The collector

### 5.0 Fix first: prune must never delete an unarchived day (existing data-loss bug)

Found by the review and confirmed in the code: `run_forever` stops compacting at the first failure
(`scheduler.py` `break`), then calls `store.prune(conn, now − HOT_RETENTION_SEC)` regardless. If
compaction of a day keeps failing for about a day, prune deletes that day's rows although no Parquet
file holds them. The fix makes the cutoff
`min(now − HOT_RETENTION_SEC, start of archived_day)`, with a test that fails today. It ships before any
container limit (§5.3), because limits make compaction failures more likely.

### 5.1 Upload code

- New `src/parkcast/upload.py`, standard library only.
- After `artifacts.publish(...)` succeeds, `publish_artifacts` hands the same two blobs to an `Uploader`,
  which runs **one daemon thread** fed by a single-slot, latest-only handoff. The collection loop never
  blocks on the network. If the previous attempt is still running, the new publish replaces the waiting
  one; nothing queues.
- **Enabled only when fully configured:** `PARKCAST_UPLOAD_URL` must be `https://` with a host equal to
  `UPLOAD_HOST` pinned in `config.py` (not secret — the repository is public), and
  `/run/secrets/parkcast_upload_secret` must contain exactly `pcu_` followed by 43 base64url characters
  (surrounding whitespace stripped, anything else refused). Otherwise uploads are off, logged once
  without the value. A local or test container never uploads by accident.
- **Request:** `PUT` via an opener built with `ProxyHandler({})` (no proxy from the environment),
  redirects refused (a handler that raises), default certificate verification, `Authorization` added
  with `add_unredirected_header`, 10-second socket timeout and a 30-second wall-clock deadline after which
  the attempt is abandoned. The response body is not read.
- **Logging:** status, `X-Reject` token, duration, bytes. Exceptions from the send path are logged as the
  exception **type name only** — never `str(exc)` or a traceback, which can contain header values. A test
  plants a secret with a trailing newline, forces the send to raise, and asserts the secret appears in no
  captured record. One line when the response `Date` header differs from the container clock by > 60 s.

### 5.2 Loop and limit guards (`UploadGuard`, unit-tested)

- **Dedupe** on `(base_data_ts, roster_id, sha256 of the pair)`: a restart republishing the same reading
  does not upload it again.
- **Hard cap:** 300 attempts per Taipei day.
- **`409`:** log the reason and move on — no back-off (the next reading is the retry).
- **`401`:** retry at most once an hour (a wrong secret must not become 288 failures a day).
- **The daily-limit response** (exact status and error signature confirmed in §10.6, matched exactly):
  pause until 00:00 UTC, probing at most once an hour.
- **Anything else:** skip the next 1, 2, 4, 8 … ticks, capped at 12; reset on success.
- Nothing in the guard or the thread can raise into `run_forever`.

### 5.3 Feed fetch hardening (existing code)

`collector.py` fetches with `requests.get(url, timeout=30)`, which follows redirects anywhere and reads an
unbounded body. After confirming the two feed URLs do not redirect and measuring their sizes (§10.16), it
uses `allow_redirects=False` and a streamed read capped at 10× the largest observed size.

### 5.4 Container hardening and rollout

- **Image:** non-root user (uid 10001); `PYTHONDONTWRITEBYTECODE=1`.
- **Compose:** `read_only: true`; `tmpfs: /tmp` with an explicit `size`; `cap_drop: [ALL]`;
  `security_opt: ["no-new-privileges:true"]`; a `cpus` limit (throttles, never kills); `pids_limit` at 4×
  the measured peak including pyarrow's thread pools, never below 256. **No hard memory limit:** an
  OOM kill of the one irreplaceable process is worse than the memory it would save, and Docker Desktop's
  VM already bounds memory. No published ports, host network or Docker socket (already true).
- **Secret:** a compose file secret from git-ignored `docker/secrets/parkcast_upload_secret`, mounted at
  `/run/secrets/…` — not in the image, the environment or `docker inspect`.
- **Snapshots move off `/tmp`:** the documented `backup()` procedure writes to a bind-mounted scratch
  directory outside the repository and outside `data/`, so a snapshot never fills a tmpfs or the
  container's memory. `docker/README.md` changes with it.
- **Dry run first,** using a separate `docker/docker-compose.dryrun.yml` with its own project `name:`,
  a snapshot copy as its bind source, **no secret and no upload URL** — it cannot touch the live corpus
  or upload. It must show non-root writes through the Docker Desktop bind mount, pyproj loading
  `proj.db` on a read-only root, a compaction, a prune and a publish, and `OOMKilled=false`.
- **Live rollout** just after a tick, keeping the previous compose file to revert to; check
  `OOMKilled` and the log after the first live midnight.

## 6. Security

### 6.1 Threat model

| # | Asset | Threat | Controls | Residual |
|---|---|---|---|---|
| T1 | Money | usage becomes a bill | Workers Free cannot charge; no payment method; no paid products | none |
| T2 | Daily limits | our own loops | §5.2; upload thread with latest-only handoff; Worker: no triggers, no subrequests, ≤ 1 read + 1 write per request; app refetch bounded; dev middleware budget (§7) — each bound has a test that fails if it breaks | none known |
| T3 | Daily limits | request flood | static assets unlimited; non-artifact paths answered without storage; unauthenticated uploads touch no storage; reads cached in-isolate; browser caching cuts legitimate use | §6.3 |
| T4 | Forecast integrity | forged, replayed or future-dated upload | 256-bit secret, timing-safe comparison, auth first, size cap, strict shape and per-row checks, time window on the Worker's clock, stored future values void, 180-second write spacing, roster floor, preview hosts cannot write | a stolen secret allows a well-formed false forecast (under the roster floor and time window) until rotated; it cannot blank the site, lock out the collector or exhaust KV writes |
| T5 | Visitors | script injection | no raw-HTML sinks in `web/src` (checked); React escapes text; CSP with no inline script or style; artifact responses `default-src 'none'`; a future-dated forecast shown as unusable, not "0 min old" | MapLibre's attribution box renders the basemap archive's attribution HTML through its sanitiser; a tampered basemap build could put HTML (not script, under the CSP) there |
| T6 | Source and secrets | uploaded with the site | explicit allowlist over everything uploaded; required files present; no source maps; secret-value, `pcu_` and deploy-key scans; dev artifacts no longer under `public/` | the Worker bundle itself is uploaded (account-private) |
| T7 | **Your PC** | reached from the internet | nothing listens (checked: no Docker/WSL listener beyond loopback; Docker's unencrypted TCP API off); dev server bound to `127.0.0.1`; the collector makes only outbound HTTPS calls, to the pinned upload host and the two feed URLs, with redirects refused on both paths and bounded reads | none known |
| T8 | **Your PC** | malicious npm or Python dependency | Worker has zero runtime deps; collector gains no Python deps; web and Worker toolchains installed with `npm ci --ignore-scripts` from the lockfiles (§10.7); the check phase runs with **no deploy key in the environment**; the release phase runs only the pinned `wrangler` and a dependency-free script | the pinned `wrangler` runs with the key; kept to exact versions and reviewed `npm audit` |
| T9 | **Your PC** | compromised collector container | non-root, read-only, no capabilities, no privilege escalation, no socket, pids and CPU limits | a container escape needs a Docker/kernel bug; keep Docker Desktop updated |
| T10 | Accounts | takeover | two-factor sign-in on Cloudflare and GitHub; a custom deploy key: this account only, least permissions `wrangler` needs (§10.18), expiry of days, client-IP filter where practical; a separate short-lived key for one-time setup; never `wrangler login` | phishing — official dashboards only |
| T11 | Deploy key | leaks from the PC | entered with `Read-Host -AsSecureString` in a fresh PowerShell (not saved to PSReadLine history), used by the release command only, never in the collector or any file | revoke and reissue (§6.4) |
| T12 | Visitors | a malicious deploy leaves poisoned service-worker caches after rollback | `/sw.js` served `Cache-Control: no-cache`; runbook redeploys with `sw.js` `VERSION` bumped, which deletes every old cache | visitors who loaded the bad version are exposed until their next visit |
| T13 | Secrets | committed by accident | `.gitignore` gains `.dev.vars*`, `.env*` (except `.env.example`), `.wrangler/`, `docker/secrets/`, `*.pem`; `.dockerignore` gains `docker/secrets`; tests use a fixed dummy secret; a versioned pre-commit hook (`core.hooksPath`) rejects staged content containing `pcu_` or the secret file's bytes | GitHub push protection does not recognise a random secret; the hook is the control |
| T14 | Limits, PC | the dev server | dev middleware serves two exact paths, GET/HEAD only, one shared copy refreshed ≤ once a minute, ≤ 120 upstream requests an hour, forwards no request headers except `If-None-Match`; `server.host: '127.0.0.1'`, `strictPort`, never `--host` | none known |

### 6.2 Site hardening

`web/public/_headers`:

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  X-Frame-Options: DENY
/sw.js
  Cache-Control: no-cache
```

- `worker-src 'self'` suffices: the app already calls `setWorkerUrl` with a same-origin URL
  (`web/src/map/useMapLibre.ts`), so MapLibre creates no blob worker.
- The inline `style=` of the static fallback in `web/index.html` moves to an **unhashed**
  `public/fallback.css`, linked from `index.html` and added to the service worker's precache — it stays
  available in the offline case it exists for, and `style-src` needs no `'unsafe-inline'`.
- **Client:** a grid whose `baseDataTs` is more than 10 minutes in the future is treated as unusable
  (the "could not load" state), never shown as "0 min old".
- **Acceptance:** zero CSP violations across first load, map pan/zoom, search, destination tap, language
  toggle, time slider and an offline reload.
- `robots.txt` disallows `/artifacts/`. `workers.dev` is HSTS-preloaded as a `.dev` domain.

### 6.3 Flooding — what a free address can and cannot do (accepted by the user)

Every request that runs the Worker counts towards the 100,000 a day, including requests it rejects — its
rate limiter acts only once it is running — and possibly including requests for paths that match no file
(§10.2), not only `/artifacts/*`. About 70 requests a minute, sustained for a day, exhausts the limit.
Then forecasts and uploads fail until 08:00 Taipei; the app and map still load from static assets and
show the last forecast with its age; nothing is billed or altered; the PC is unaffected; the collector
pauses uploads (§5.2). Blocking such traffic before it counts needs Cloudflare firewall rules, which need
a domain — outside the free requirement. If abuse happens, adding a domain is an additive change.

### 6.4 Incident runbook

| Situation | Action |
|---|---|
| Upload secret may have leaked | new secret (script); `wrangler secret put UPLOAD_SECRET` only when no undeployed version is pending (§10.11); replace the file; recreate the collector after a tick; if a false forecast is live, `wrangler kv key delete latest` |
| Deploy key may have leaked | revoke in the dashboard; audit recent deployments; if any is unknown, treat as a malicious deploy |
| Malicious or broken deploy | `wrangler rollback`; then deploy with `sw.js` `VERSION` bumped; rotate the deploy key and the upload secret |
| Flooding | nothing until 08:00 Taipei; if it recurs, decide on a domain with firewall rules |
| The PC may be compromised | revoke the deploy key, rotate the upload secret, sign out other Cloudflare and GitHub sessions |

## 7. Local-first workflow

**Everyday, on the desktop — no deploy key needed, nothing live written:**
- `npm run dev` (bound to `127.0.0.1`). With `PARKCAST_LIVE_ORIGIN` set, a small Vite middleware (not a
  generic proxy) serves `/artifacts/grid.bin` and `/artifacts/lots.json` from one shared copy fetched from
  the live site at most once a minute, within 120 upstream requests an hour (then a local `429`), forwarding
  no request headers except `If-None-Match`, GET/HEAD only. Unset, it serves `web/.dev-artifacts/`
  (git-ignored), where `scripts/sync-artifacts.mjs` and `scripts/refresh-demo-artifacts.py` now write —
  so no data sits under `public/`, and nothing there reaches a build.
- Worker logic is plain functions tested with vitest; `wrangler dev` runs locally against Wrangler's
  simulated KV (never `--remote`), seeded from the live copy through the middleware.
- Collector upload, guard and prune fix: pytest in the usual throwaway container, with a fake sender.

**A test address (optional):** `npm run deploy:preview` = the check phase, then the release phase's
`wrangler versions upload`. Preview URLs are enabled only for this step. Preview versions cannot write
production data (§4.3 step 1) and use the preview KV namespace for development.

**Going live — only after the user's explicit yes, in two phases (§8.3):**
1. `npm run deploy:check` in a normal shell, **no key in the environment**.
2. `npm run deploy:release` in a fresh PowerShell where the user enters the key with
   `Read-Host -AsSecureString`. It runs only the pinned `wrangler` (`npx --no-install`) and a
   dependency-free script, then clears the key.

Rollback: `wrangler rollback`. Collector changes keep the existing procedure (tests in a container,
rebuild just after a tick, then confirm the tick, publish and `uploaded` log lines).

## 8. Implementation outline

### 8.1 New and changed files

| Path | Change |
|---|---|
| `src/parkcast/scheduler.py`, `src/parkcast/store.py` + test | §5.0 prune fix |
| `src/parkcast/upload.py`, `scheduler.py`, `config.py` + tests | §5.1–5.2 |
| `src/parkcast/collector.py` + test | §5.3 |
| `docker/Dockerfile`, `docker/docker-compose.yml`, `docker/docker-compose.dryrun.yml`, `.dockerignore` | §5.4 |
| `worker/src/{index,serve,upload,validate}.ts`, `worker/tests/`, `worker/wrangler.jsonc`, `worker/package.json` + lockfile | §4, exact-pinned dev deps |
| `web/vite.config.ts` (+ middleware module and test) | base `/`; `127.0.0.1`; §7 middleware |
| `web/public/_headers`, `404.html`, `robots.txt`, `fallback.css`; `web/index.html`; `web/public/sw.js` | §6.2 |
| `web/src/App.tsx` + test | future-dated grid unusable |
| `scripts/sync-artifacts.mjs`, `scripts/refresh-demo-artifacts.py` | write `web/.dev-artifacts/` |
| `scripts/check-deploy-bundle.mjs`, `scripts/release.mjs`, `scripts/smoke-live.mjs`, `scripts/new-upload-secret.py`, `scripts/hooks/pre-commit` | §8.3, §6.1 T13 |
| `.gitignore` | T13 entries and `web/.dev-artifacts/` |
| `docs/deploy.md` (new); `README.md`, `CLAUDE.md`, `docs/state-of-play.md`, `docker/README.md`, `docs/pwa.md`, `web/README.md` | §12 |

### 8.2 One-time setup (the user performs every credential step; exact commands in `docs/deploy.md`)

1. Cloudflare account (no card), two-factor sign-in, and a **neutral** `workers.dev` subdomain — it is
   public and effectively permanent (installed PWAs are tied to the origin).
2. GitHub two-factor sign-in and secret-scanning push protection; `git config core.hooksPath scripts/hooks`.
3. A short-lived setup key to create the production and preview KV namespaces (ids go into
   `wrangler.jsonc`) and to set the secret.
4. `python scripts/new-upload-secret.py` writes `docker/secrets/parkcast_upload_secret` (no newline,
   `pcu_` + 43 base64url characters, never printed); then `wrangler secret put UPLOAD_SECRET` reads that
   file on stdin.
5. The deploy key: custom, this account only, least permissions, expiry of days.
6. Approve the `go-pmtiles` download so the basemap can be rebuilt (`docs/basemap.md`).

### 8.3 The deploy gate

**Check phase (no key):**
1. Web and Worker tests, typecheck, lint; Python tests when `src/` changed.
2. Production build, base `/`, source maps off.
3. `check-deploy-bundle.mjs`: every file in `web/dist` and the Worker bundle matches an explicit
   allowlist; required files exist (`index.html`, `sw.js`, the manifest, `_headers`, `404.html`,
   `fallback.css`, `basemap/taipei.pmtiles` at 15–25 MiB); fails on any `.map`, `.ts`/`.tsx`/`.py`,
   `.env*`, `.dev.vars*`, `.sqlite`/`.parquet`, anything under `artifacts/` or `data/`, any file ≥ 25 MiB,
   and on the upload secret's value or the `pcu_` prefix in any byte.
4. `npm audit` for both toolchains, reviewed.

**Release phase (key present):**
5. Scan the bundle again for the deploy key's value (dependency-free script).
6. `wrangler versions upload`.
7. Smoke-test the new version before promotion, via Cloudflare's version-override mechanism if it works
   for a not-yet-deployed version (§10.17); otherwise immediately after promotion, with automatic
   `wrangler rollback` on failure.
8. `wrangler versions deploy`.
9. Smoke test (`smoke-live.mjs`): `/` loads with the §6.2 headers; `/sw.js` is `no-cache`; `grid.bin` and
   `lots.json` parse and pair by `rosterId`; `/src/main.tsx`, `/assets/x.map`, `/.env`, `/_headers`,
   `/wp-login.php` return `404`; `PUT` without the secret → `401`; `PUT` to a non-production host path →
   `404`. **Freshness is a warning, not a failure** — the collector may be paused.

## 9. Testing and acceptance

- **Prune fix (pytest):** a day whose compaction keeps failing is still whole after 72 simulated hours;
  prune resumes once it archives.
- **Worker (vitest, fake KV counting operations):** unauthenticated → 0 reads, 0 writes; oversized
  `Authorization`; honest, lying and chunked bodies; each shape and per-row rule; lenient `X-Grid-Length`
  forms (`0x15`, `21abc`, `1e3`, empty) rejected; each time rule including a stored future value that must
  not block; 180-second spacing; roster floor and its 24-hour escape; preview host `PUT` → 404; non-artifact
  path → 404 without reading `env`; in-isolate copy: one read per minute under concurrency, empty result
  cached; weak `If-None-Match`; cache headers per file; every response's security headers; `fetch` never
  called.
- **Collector (pytest):** thread handoff never blocks the loop and never queues; dedupe across a restart;
  daily cap; 409 no back-off; 401 hourly; daily-limit pause with hourly probe; back-off and reset;
  deadline; redirect refused; proxy environment ignored; wrong host or `http://` refused; malformed secret
  file refused without logging it; the secret absent from all log records including exception paths;
  local publish unaffected; feed fetch refuses a redirect and an oversized body.
- **Web (vitest):** middleware — 10,000 local requests cause ≤ 2 upstream requests, non-GET rejected,
  request headers not forwarded, hourly budget enforced; app — refetch count bounded over an hour of fake
  time with every fetch failing; a future-dated grid is unusable; no inline `style=` in `index.html`;
  `_headers` contains the §6.2 policy.
- **Scripts:** the bundle check fails on each planted violation (a `.map`, a `.env`, a `.dev.vars`, a `.ts`,
  `artifacts/grid.bin`, a missing basemap, an oversize file, the secret, `pcu_`) and passes on a clean
  build; the pre-commit hook rejects a staged `pcu_` string.
- **Live:** the smoke test; zero CSP violations; `uploaded` in the collector log each tick; `OOMKilled`
  false after the first midnight.

## 10. To confirm during implementation (documentation did not settle these)

1. A preview version reads the namespace its config names (production `id`), and `preview_id` applies only
   to `wrangler dev --remote`.
2. With `not_found_handling: "404-page"`, whether unmatched requests run the Worker — measured by probing
   random paths and reading invocation counts. §6.3 is updated with the answer either way.
3. `_headers` is applied, and `/_headers` itself is not served.
4. `workers.dev` offers no firewall rules (dashboard).
5. Non-root writes through the Docker Desktop bind mount; pyproj `proj.db` on a read-only root; a
   compaction under the hardened settings (dry run).
6. The exact status and error signature when the daily Worker limit is exhausted, and when per-request CPU
   is exceeded (they must be told apart, §5.2).
7. Both toolchains install and run with `npm ci --ignore-scripts`; any exception documented with its reason.
8. MapLibre renders under the §6.2 CSP with zero violations.
9. CPU time of the upload path in a cold isolate against the 10 ms Free limit (fallback in §4.3).
10. Whether any Cloudflare logging records request headers when observability is off.
11. Whether `wrangler secret put` deploys an undeployed latest version.
12. A compose file secret is readable by uid 10001 on Docker Desktop for Windows.
13. Older versions' preview URLs are unreachable once `preview_urls` is false again.
14. The PSReadLine version in the user's PowerShell, and that the `Read-Host -AsSecureString` path leaves
    no history.
15. Whether Cloudflare weakens the Worker's ETag on compressed JSON.
16. The two feed URLs do not redirect; their largest body sizes (sets the §5.3 cap).
17. The version-override smoke test works before promotion (§8.3 step 7).
18. The least permissions `wrangler` needs to deploy assets, bindings and secrets.

## 11. Out of scope, and rejected ideas

Out of scope: a custom domain and firewall rules; deploying from GitHub Actions; analytics or accounts;
any change to the forecast or ranker.

Rejected from the review: a collector heartbeat lock that refuses to start beside a fresh heartbeat —
the documented deploy recreates the container seconds after a tick, and the lock would block exactly that
restart and lose ticks; the separate dry-run compose file (§5.4) removes the case it was for. A hard
memory limit — see §5.4.

## 12. Documentation updates

`docs/deploy.md` (setup, workflow, runbook, the free rules, the security rules); `README.md` (reaching and
deploying the app); `CLAUDE.md` (deployment facts; never add a payment method; the two-phase deploy; the
prune fix); `docs/state-of-play.md` (deployed state; collector pauses are the user's own and not an
incident); `docker/README.md` (hardened container, dry-run compose, secret file, snapshot scratch
directory, upload log lines); `docs/pwa.md` (base `/`; `fallback.css`; `/sw.js` no-cache); `web/README.md`
(`.dev-artifacts/` and the live middleware).

## 13. Sources (read 2026-09-14)

- Workers pricing and Free plan behaviour — https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits — https://developers.cloudflare.com/workers/platform/limits/
- Static assets billing — https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- `run_worker_first`, routing — https://developers.cloudflare.com/workers/static-assets/binding/ ,
  https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
- Wrangler configuration — https://developers.cloudflare.com/workers/wrangler/configuration/
- Wrangler commands — https://developers.cloudflare.com/workers/wrangler/commands/workers/
- Preview URLs — https://developers.cloudflare.com/workers/configuration/previews/
- Versions — https://developers.cloudflare.com/workers/configuration/versions-and-deployments/
- workers.dev — https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Rate Limiting binding — https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Web Crypto — https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- KV limits, pricing, consistency — https://developers.cloudflare.com/kv/platform/limits/ ,
  https://developers.cloudflare.com/kv/platform/pricing/ , https://developers.cloudflare.com/kv/concepts/how-kv-works/
- R2 pricing and payment method — https://developers.cloudflare.com/r2/pricing/ ,
  https://community.cloudflare.com/t/why-using-r2-free-tier-involves-giving-card-info/945179
- Pages limits — https://developers.cloudflare.com/pages/platform/limits/
- API token restrictions — https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- Deploy-key template — https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- GitHub Pages limits — https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- GitHub secret scanning — https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning
- MapLibre CSP — https://maplibre.org/maplibre-gl-js/docs/
- Netlify free-plan credits — https://netli.fyi/blog/netlify-free-plan-limits-2026

## 14. Review history

2026-09-14: an independent adversarial review read this spec against the code (read-only) and reported
0 Critical, 3 High, 12 Medium, 11 Low and 12 open questions. The High findings — a future-dated upload
that could lock out every later one, the deploy key exposed to the whole web toolchain, and container
limits that could kill the collector and let prune delete an unarchived day — and every Medium and Low
finding are addressed above, except the two ideas rejected in §11. The prune bug predates this design and
is fixed first (§5.0).
