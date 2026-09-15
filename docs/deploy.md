# Deploying ParkCast

**Nothing described here has been deployed yet.** The design was approved 2026-09-14
(`docs/superpowers/specs/2026-09-14-deployment-design.md`); the Worker, the collector's upload path,
the hardened container and the deploy scripts are built and staged on `feat/cloudflare-deploy` but the
Cloudflare account, its KV namespaces and its secret do not exist yet — that is the one-time setup
below, done once by a human. Until it happens, the live address stays a placeholder:
`https://parkcast.<name>.workers.dev`.

---

## 1. What is deployed where

One Cloudflare Worker, `parkcast`, on its own `workers.dev` subdomain. The web app's production build
and the ~23 MB basemap archive are served as **static assets**, free and unlimited on Workers Free. The
forecast lives in exactly **one Workers KV key**, `latest` — `grid.bin` bytes followed by `lots.json`
bytes, with metadata describing the split — written once per publish. The collector, running on the
desktop, hands every successful publish to a background **upload thread** that `PUT`s the pair to the
Worker; the desktop makes only that one outbound call and never listens for a connection.

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

Full design and rationale: `docs/superpowers/specs/2026-09-14-deployment-design.md` §3–§4.

## 2. Rules that keep it free

**Rules that keep it free:** stay on Workers Free; never add a payment method; never enable R2 or any
paid product; any future feature is a static file or a new forecast artifact inside this budget.

| Resource (Free) | Limit | Our use | Headroom |
|---|---|---|---|
| Static asset requests | unlimited | app, basemap | — |
| Worker requests | 100,000 / day (resets 00:00 UTC = 08:00 Taipei) | 288 uploads; ~16 per open tab per hour with cache headers (≤ ~60 without); dev tabs capped by the local-first middleware (§4 below) | thousands of tab-hours/day |
| KV reads | 100,000 / day | ≤ 1 per isolate per 60 s | bounded by Worker requests |
| KV writes | 1,000 / day, per write | 288; the 180-second minimum spacing between accepted uploads caps *all* writers at 480/day | under the limit even with a stolen secret |
| KV storage | 1 GB | ~0.22 MB | — |
| Static asset file size | 25 MiB | basemap ~23 MB | gated on every deploy (`docs/basemap.md`) |
| CPU per request | 10 ms | upload path's validation, measured 2026-09-14 in Node against the real 1,090-lot pair: **~1.5 ms** | Cloudflare's own CPU time is measured after go-live; a cheaper fallback validation is defined in the design spec §4.3 if it ever comes in over budget |

Why KV and not R2: enabling R2 requires a payment method on the account, even to use its free tier — a
free guarantee would then rest on usage staying low, not on a hard cap. KV needs no card and is
included in Workers Free.

## 3. One-time setup (you do every step that touches a credential)

Nobody but the account owner should see a credential, so every step below is done by hand, not by an
agent. Cloudflare and GitHub steps happen in a browser; the two commands happen in a terminal.

1. Create the Cloudflare account with **no card on file**, turn on **two-factor sign-in**, and choose a
   **neutral** `workers.dev` subdomain — it is public and effectively permanent (an installed PWA is
   tied to its origin).
2. On GitHub: turn on **two-factor sign-in** and **secret-scanning push protection**, then enable this
   repository's pre-commit hook once per clone:
   ```
   git config core.hooksPath scripts/hooks
   ```
3. Create a short-lived **setup key** — a custom API token, restricted to this account only, expiring in
   one day, with the permissions Task 13 confirms `wrangler` actually needs for this setup. Enter it in a
   **fresh PowerShell** (Git Bash rewrites a path-like value such as `PARKCAST_BASE=/` into a Windows
   path — measured 2026-09-14 — so set Cloudflare credentials from PowerShell, never Git Bash):
   ```powershell
   $s = Read-Host -AsSecureString -Prompt "Cloudflare API token"
   $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   $env:CLOUDFLARE_ACCOUNT_ID = "<account id from the dashboard>"
   ```
4. Create the two KV namespaces from `worker/`:
   ```
   cd worker
   npx --no-install wrangler kv namespace create ARTIFACTS
   npx --no-install wrangler kv namespace create ARTIFACTS --preview
   ```
   Put the two returned ids into `worker/wrangler.jsonc`'s `kv_namespaces[0].id` (production) and
   `.preview_id` (preview), replacing the `REPLACE_WITH_PROD_KV_ID` / `REPLACE_WITH_PREVIEW_KV_ID`
   sentinels. Also replace `parkcast.REPLACE-SUBDOMAIN.workers.dev` in `vars.PRODUCTION_HOST` and in
   `src/parkcast/config.py`'s `UPLOAD_HOST` with the real subdomain from step 1.
5. Generate the collector's upload secret and push it to the Worker — through `cmd`, not a PowerShell
   pipe, because a PowerShell pipe appends a trailing newline and the file and the value `wrangler`
   sends would then differ:
   ```
   python scripts\new-upload-secret.py
   cmd /c "npx --no-install wrangler secret put UPLOAD_SECRET < ..\docker\secrets\parkcast_upload_secret"
   ```
6. Wire the collector for uploads. Add to the `collector` service in `docker/docker-compose.yml`, with
   the real subdomain from step 1:
   ```yaml
       environment:
         TZ: Asia/Taipei
         PARKCAST_UPLOAD_URL: https://parkcast.<name>.workers.dev/artifacts/latest
       secrets:
         - parkcast_upload_secret
   ```
   and, at the top level of the same file:
   ```yaml
   secrets:
     parkcast_upload_secret:
       file: ./secrets/parkcast_upload_secret
   ```
   Compose refuses to start the collector at all while that file is missing, so before any recreate
   check that it exists (from the repository root; expect `True`):
   ```powershell
   Test-Path docker\secrets\parkcast_upload_secret
   ```
   Then, **once the first release (§5) has passed**, recreate the collector just after a tick (minute
   ≡ 1 mod 5, second ≈ 40), so no slot is lost:
   ```
   docker compose -f docker/docker-compose.yml up -d --build --force-recreate
   ```
   Confirm the next two ticks each log `tick data_ts=... rows=...`, `published N lots x 24 horizons, M
   not updating` and `uploaded: status=204 bytes=N duration=Ss`, with no `uploads disabled` line; that
   `docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}} {{.Config.User}}' docker-collector-1`
   shows `false 0 10001:10001`; and that the `/scratch` bind mount is writable by uid 10001 (Git Bash):
   ```bash
   MSYS_NO_PATHCONV=1 docker exec docker-collector-1 python -c "import pathlib; p = pathlib.Path('/scratch/.probe'); p.write_bytes(b'ok'); p.unlink(); print('scratch writable')"
   ```
7. Clear the setup key from the shell and revoke it in the dashboard — it has done everything it needs
   to:
   ```powershell
   Remove-Item Env:CLOUDFLARE_API_TOKEN
   ```
8. Create the **deploy key** used for every future release: a custom API token, restricted to this
   account only, the least permissions `wrangler` needs to deploy assets, bindings and secrets **and to
   set the Worker's workers.dev subdomain and preview-URL settings** (every release runs `wrangler
   triggers deploy`, §5) — all confirmed by Task 13 — expiring in a small number of days rather than
   never.

## 4. Everyday: test locally against live data

No deploy key is needed for this, and nothing live is written. From the repository root, in PowerShell:

```powershell
$env:PARKCAST_LIVE_ORIGIN = "https://parkcast.<name>.workers.dev"
npm run dev --prefix web
```

`web/vite.config.ts`'s dev middleware then serves `/artifacts/grid.bin` and `/artifacts/lots.json` from
one copy shared across every request, fetched from the live site **at most once a minute**, within
**120 upstream requests an hour** (a local `429` once that's spent), forwarding no request headers to
the upstream at all, and answering only `GET`/`HEAD` locally (anything else gets a local `405`) — so
nothing under active local edit and reload can run up the live site's daily Worker-request budget. The
dev server itself is bound to `127.0.0.1`
(`server: { host: '127.0.0.1', strictPort: true }`); **never pass `--host`** — that would put a
loopback-only dev server, and whatever the live-artifacts middleware relays through it, on the network.

Without `PARKCAST_LIVE_ORIGIN` set, the dev server instead serves `web/.dev-artifacts/` (git-ignored),
filled by `node scripts/sync-artifacts.mjs` from the collector's own output, or by
`python scripts/refresh-demo-artifacts.py` on a machine with no collector.

## 5. Deploying

Install both toolchains from their lockfiles without running any package's install scripts (design
spec §6.1 T8) — once per clone, and again whenever a lockfile changes. Run it inside each directory;
npm does not honour `--prefix` for `ci`:

```
cd web
npm ci --ignore-scripts
cd ../worker
npm ci --ignore-scripts
cd ..
```

Then two phases, in two different shells, so the deploy key is never in the environment while
third-party code — tests, linters, `npm audit` — is running.

**Phase 1 — check, in a normal shell, no key:**

```
npm run deploy:check --prefix worker
```

Add `-- --with-python` when `src/` changed, to also run the Python test suite in a throwaway
`docker-collector:latest` container. The check phase runs the web, worker and script test suites, both
typechecks, the web linter, a production build, and a `wrangler deploy --dry-run --outdir` of the
Worker bundle; it then deletes the local-only `.map` and `README.md` files that dry run writes next to
the built script — but only after confirming `worker/wrangler.jsonc` does not set `upload_source_maps`
(today it does not). If a future config ever sets that flag, the gate stops instead of deleting the
map, because a set `upload_source_maps` means that file would actually be uploaded to Cloudflare, and
silently deleting it before the bundle scan would hide a real source-map upload rather than a harmless
local debug artifact. It then scans the built app and the Worker bundle against an explicit allowlist —
required files present, no `.map`/`.ts`/`.env*`/`.dev.vars*`/database file anywhere, the basemap at
15–25 MiB, no byte of the upload secret's value or shape — and finally runs `npm audit` in both
`web/` and `worker/` for review (informational, not a gate). `deploy-check.mjs` itself refuses to run at
all if `CLOUDFLARE_API_TOKEN` is set in the shell.

**Phase 2 — release, in a fresh PowerShell, deploy key entered by hand:**

```powershell
$s = Read-Host -AsSecureString -Prompt "Cloudflare API token"
$env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$env:CLOUDFLARE_ACCOUNT_ID = "<account id from the dashboard>"
npm run deploy:release --prefix worker
Remove-Item Env:CLOUDFLARE_API_TOKEN
```

The release phase re-scans the bundle (now also for the deploy key's own value, since it exists to leak
for the first time), uploads a new version (`wrangler versions upload`), promotes it to 100% of traffic
(`wrangler versions deploy <id>@100% --yes`), then applies the committed `workers_dev: true` and
`preview_urls: false` with `wrangler triggers deploy --config wrangler.jsonc`. That last step is needed:
in the pinned wrangler, `versions upload` and `versions deploy` never apply either setting — only
`wrangler deploy` and `wrangler triggers deploy` do. If `triggers deploy` fails, the release stops there
without a smoke test, says the new version is already live, and names the commands to finish by hand.

It then smoke-tests the live site (`scripts/smoke-live.mjs`) up to three times, twenty seconds apart, to
give the new version time to reach the edge. The smoke test never crashes the release: a request error
or a 15-second timeout counts as a smoke failure like any other check, so a network hiccup during those
retries still ends in the normal path below rather than a half-finished, half-crashed release. If every
attempt still fails, the release rolls itself back automatically (`wrangler rollback --yes --message
"smoke test failed"`) and exits non-zero — on a first-ever release that rollback lands on the empty
placeholder Worker `wrangler secret put` created during setup, which serves no site; if the rollback
itself fails, it says so and names the manual command to run. After a passing smoke test, the release
requests the new version's own preview address once, `https://<first 8 characters of the version
id>-parkcast.<name>.workers.dev` (15-second timeout): a `2xx` there means preview URLs are still on, and
the release stops with that error — without rolling back, since the site itself is fine. Any other
status, or no answer, is the expected outcome.

`npm run deploy:preview --prefix worker` runs the same release script with `--preview`: it writes a
temporary config with `preview_urls: true`, applies it with `wrangler triggers deploy` so the upload
gets a preview URL, uploads a version under it for a phone test, prints the preview URL, and **never
promotes it**. Preview URLs then **stay on** until the next normal `deploy:release`, whose `triggers
deploy` applies the committed `preview_urls: false` and whose final check confirms the new version's own
preview address no longer serves. Whether an older, already-handed-out preview URL also stops answering
is unconfirmed until Task 13's first live release (design spec §10.13).

## 6. The collector's upload

`src/parkcast/upload.py` logs one line per attempt. Bytes and duration cover the whole pair
(`grid.bin` + `lots.json`); `N`/`S` stand for the actual numbers logged.

| Line | Meaning |
|---|---|
| `uploaded: status=204 bytes=N duration=Ss` | Accepted; this pair is now the live forecast. |
| `upload not needed: status=409 reject=<token> duration=Ss bytes=N` | `<token>` is `stale` (the Worker already has this reading or a newer one) or `too-soon` (it accepted one under 180 seconds ago). Not a failure — no back-off. |
| `upload rejected: <token> status=409 duration=Ss bytes=N` | Logged as a warning: the Worker refused the reading itself. `<token>` is `future` or `too-old` (outside the Worker's time window, design spec §4.3 step 5), `roster-shrink` (under half the stored lot count), or `unknown` if the Worker sent anything else — the unknown value itself is never logged. No back-off either, but worth a look at the container's clock, the feed or the roster. |
| `upload skipped: paused` / `backing off` / `daily cap reached` | The collector's own guard didn't even attempt the request. A duplicate reading (identical to the last one already sent) is skipped silently, with no log line at all. |
| `upload skipped: previous attempt still running` | A slow attempt overlapped the next publish; the newer pair is dropped rather than queued. |
| `upload abandoned after 30s (bytes=N)` | The whole attempt — DNS included — exceeded its 30-second deadline. Counted as a failure (exponential back-off). |
| `upload failed: <ExceptionType> (duration=Ss bytes=N)` | The send raised. Only the exception's **type name** is logged, never its message or a traceback, either of which could contain the secret. |
| `upload unauthorized: status=401 duration=Ss bytes=N; retrying in an hour` | The secret the collector has doesn't match the Worker's. Retried at most once an hour, so a stale secret can't become 288 failed attempts a day. |
| `upload refused: status=429 duration=Ss bytes=N; pausing` | The Worker's daily-limit response (provisional — Task 13 confirms the exact status and error signature). The guard pauses until at most the next 00:00 UTC (08:00 Taipei), when the daily limit resets, probing at most once an hour. |
| `upload failed: status=<code> duration=Ss bytes=N` | Any other status. Back-off doubles each time this happens (1, 2, 4, 8 ticks, capped at 12) and resets on the next success. |
| `container clock differs from the server by <N>s` | Logged once: the Worker's `Date` header disagreed with the container's own clock by more than 60 seconds. |
| `uploads disabled (no valid upload URL)` / `(no valid secret file)` / `(<ExceptionType>)` | Logged once at startup. Uploads are off: `PARKCAST_UPLOAD_URL` isn't set to the exact pinned host, `/run/secrets/parkcast_upload_secret` is missing or the wrong shape, or building the uploader raised (type name only, never the message). |

None of this can block collection or raise into `run_forever` — an upload failure only ever costs an
upload.

## 7. Runbook

| Situation | Action |
|---|---|
| Upload secret may have leaked | `python scripts\new-upload-secret.py --force` to write a new one; from a fresh PowerShell with the deploy key, `cd worker` then `cmd /c "npx --no-install wrangler secret put UPLOAD_SECRET < ..\docker\secrets\parkcast_upload_secret"`. That command refuses when the latest uploaded version is not the deployed one (after a rollback or a `deploy:preview`); then run `cmd /c "npx --no-install wrangler versions secret put UPLOAD_SECRET < ..\docker\secrets\parkcast_upload_secret"` instead, followed by `npx --no-install wrangler versions deploy <the version id it printed>@100% --yes` — but that new version copies the latest *uploaded* version's code, so after rolling back a bad deploy, release a good build with `deploy:release` first and then use plain `secret put`; `docker compose -f docker/docker-compose.yml up -d --build --force-recreate` so the collector picks up the new secret file after its next tick; if a false forecast is already live, `npx --no-install wrangler kv key delete latest --binding ARTIFACTS` |
| Deploy key may have leaked | revoke it on the Cloudflare dashboard; review recent deployments there; treat any deployment you don't recognise as a malicious one |
| Malicious or broken deploy | `npx --no-install wrangler rollback --yes --message "<reason>"` (the same call `deploy:release` already makes automatically on a failed smoke test); redeploy with `web/public/sw.js`'s `VERSION` bumped so every visitor's cached worker drops its old cache; rotate both the deploy key and the upload secret |
| Flooding | nothing to do until 00:00 UTC (08:00 Taipei), when the daily Worker-request limit resets — the app, the map and the last forecast keep serving from static assets throughout, nothing is billed, and the collector pauses uploads on its own; if it recurs, revisit a custom domain with firewall rules, deliberately out of scope today |
| The PC may be compromised | revoke the deploy key and rotate the upload secret as above; sign other sessions out of the Cloudflare and GitHub dashboards |

## 8. Security rules

- **Never add a payment method to the Cloudflare account, and never enable R2 or any other product
  that bills.** Workers Free "cannot result in charges" only for as long as that stays true.
- **Never set the deploy key (`CLOUDFLARE_API_TOKEN`) in the check-phase shell.** `deploy-check.mjs`
  refuses to run at all if it finds one set — the check phase runs third-party test/lint/build tooling,
  and none of it should ever get to see the key.
- **Never `wrangler login`.** Every command here runs the pinned, locally-installed `wrangler`
  (`npx --no-install`) against an explicit `CLOUDFLARE_API_TOKEN`; a browser OAuth login would leave a
  longer-lived credential on the machine than the short-lived tokens this project uses.
- **Never pass `--host` to `npm run dev` or `npm run preview`.** Both are bound to `127.0.0.1` in
  `web/vite.config.ts` on purpose — the dev server can read local files and relay the live site, and
  `--host` would put that on the network.
- **Never commit `docker/secrets/`, `.dev.vars*`, `.wrangler/`, `.env*` (other than `.env.example`), or
  `*.pem`.** All are git-ignored, and the pre-commit hook (enabled with
  `git config core.hooksPath scripts/hooks`) additionally refuses any staged line shaped like the
  upload secret or containing its actual bytes — GitHub's own push protection cannot recognise a
  random per-project secret, so this hook is the real control.
- **Rotate on suspicion, not on certainty.** See the runbook above.
- **The accepted flooding limit.** Every request that reaches the Worker counts toward the 100,000/day
  Worker-request limit, including ones it rejects with a 404 or 401, and possibly including requests
  for paths that match no static file. About 70 requests a minute, sustained for a day, exhausts it.
  Cloudflare firewall rules could block such traffic before it counts, but they need a custom domain,
  which the free-address requirement rules out — so this residual risk is accepted rather than closed.
  If abuse happens, adding a domain later is an additive change, not a rebuild.
