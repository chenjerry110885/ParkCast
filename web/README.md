# ParkCast web app

The client half of ParkCast. There is no API: the browser downloads the two static
artifacts the Python collector publishes and does the ranking and time-scrubbing locally.

| Artifact | Contents |
|---|---|
| `grid.bin` | 21-byte header + `n_lots x n_horizons` uint8 percentages, row-major. `255` means UNKNOWN, never 0. |
| `lots.json` | Metadata and parsed prices, index-aligned with the grid's rows. |

The pair is validated on `roster_id`, a CRC32 of the ordered lot ids — **not** on
`generated_at`, which changes every five minutes while the roster almost never does.
That is what lets a client cache the ~186 KB `lots.json` and re-fetch only the ~26 KB grid.

## Dev

```bash
node ../scripts/sync-artifacts.mjs   # copy data/artifacts/ -> .dev-artifacts/
npm install
npm run dev
```

`data/` is gitignored and the collector rewrites it every five minutes, so the app never
reads it directly — `sync-artifacts` takes a snapshot the dev server can hold still, now written to
the git-ignored `web/.dev-artifacts/` (not `public/artifacts/` — nothing under `public/` may hold dev
data, since everything there is copied into every build). Run the sync after a fresh clone or the
fetch 404s.

**Testing against the live site instead**, once it exists (`docs/deploy.md`): set
`PARKCAST_LIVE_ORIGIN` from PowerShell, not Git Bash, which rewrites path-like values —

```powershell
$env:PARKCAST_LIVE_ORIGIN = "https://parkcast.<name>.workers.dev"
npm run dev
```

— and the dev server relays the two artifact files from one shared copy, refreshed from the live site
at most once a minute and capped at 120 upstream requests an hour, instead of reading
`.dev-artifacts/`.

## Checks

```bash
npm test        # vitest, jsdom
npm run typecheck   # tsc -b, strict
npm run build
```
