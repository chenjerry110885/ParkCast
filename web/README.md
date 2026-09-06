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
node ../scripts/sync-artifacts.mjs   # copy data/artifacts/ -> public/artifacts/
npm install
npm run dev
```

`data/` is gitignored and the collector rewrites it every five minutes, so the app never
reads it directly — `sync-artifacts` takes a snapshot the dev server can hold still.
`public/artifacts/` is gitignored too; run the sync after a fresh clone or the fetch 404s.

## Checks

```bash
npm test        # vitest, jsdom
npm run typecheck   # tsc -b, strict
npm run build
```
