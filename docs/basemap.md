# Basemap

ParkCast's map needs basemap tiles -- roads, water, place labels, the geography a driver orients
by. Every hosted tile provider (MapTiler, Mapbox, Stadia) requires an API key and a billing
account, and this project has no server and no secrets: no backend to hide a key behind, no billing
relationship to maintain. So the basemap is **self-hosted**: a single [Protomaps][protomaps]
`.pmtiles` archive, checked out of the public planet build, served as a plain static file, and read
by the browser via HTTP range request (no tile server -- MapLibre's `pmtiles://` protocol fetches
byte ranges directly).

[protomaps]: https://protomaps.com/

## The file

`web/public/basemap/taipei.pmtiles` -- **not committed to git** (see `.gitignore`). It is
regenerable in about 15 seconds from a public source with no key, so it does not belong in version
control any more than `node_modules` does.

| | |
|---|---|
| Source | `https://build.protomaps.com/20260914.pmtiles` (128 GB planet build, public, no auth) |
| Bounding box | `121.4433,24.9576,121.6405,25.1999` -- all 1,088 tracked lots plus ~2 km margin |
| Zoom levels | 0-15 |
| Result | **~23 MB**, 633 tiles |
| Extract time | ~15 s over ~40 HTTP range requests (nothing else downloads) |

Zoom 15 is not an arbitrary cutoff: it is the planet build's own ceiling for this bbox. An extract
requesting `--maxzoom=16` against the same source came back byte-identical to the zoom-15 one --
there is no zoom-16 data to have.

**The pinned source build gets deleted.** Protomaps prunes most dated planet builds after a week or
two (`20260901` was already gone by 2026-09-15, returning HTTP 404). If the extract fails with a 404,
pick a current build from <https://build-metadata.protomaps.dev/builds.json> -- one with a `version`
starting `4.` so it stays on the tile schema the `protomaps-themes-base` style reads -- and update
`SOURCE_URL` in `scripts/build-basemap.mjs` and the table above. The file already extracted keeps
working; only rebuilding needs a live source.

**The deploy gate requires this file, sized 15–25 MiB.** `scripts/check-deploy-bundle.mjs` (run by
`npm run deploy:check --prefix worker`, `docs/deploy.md`) fails the build if
`web/dist/basemap/taipei.pmtiles` is missing, or is outside that range -- 15 MiB as a floor against a
truncated or empty extract, 25 MiB because that is Cloudflare Workers' own per-file size limit for a
static asset (this file, at ~23 MB, is the only asset anywhere near it). Rebuild it before deploying if
`web/dist/` doesn't have it yet -- the build does not generate it, only copies whatever
`web/public/basemap/taipei.pmtiles` already holds.

## Labels

Street, place and water names are drawn from **glyph files** in `web/public/basemap/fonts/`, served
from the app's own origin like the archive. Unlike the archive they **are committed**: they are small,
and regenerating them needs a separate download.

| | |
|---|---|
| Source | `fonts/` of [protomaps/basemaps-assets][assets] at commit `83bc11ea49e5c024df51979d5953ee841fd06584`, under the SIL Open Font License (`OFL.txt`, shipped alongside) |
| Fonts | Noto Sans Regular, Medium and Italic -- the three the Protomaps label layers name |
| Ranges | only the ones Taipei's labels use: 20 per font, **60 files, 3.9 MB**, out of the full 768-file, 11 MB set (2026-09-15) |
| Chinese, Japanese, Korean | **no glyph files at all.** MapLibre draws these with the device's own fonts (`localIdeographFontFamily`, on by default), so the thousands of Han characters in Taipei's names cost nothing to ship |
| Language | the app's 中文 setting labels in `name:zh-Hant`, English in `name:en`; the map keeps the language it opened in until the next load (`web/src/map/basemapStyle.ts`) |
| POI icons | **not shipped.** They need a sprite sheet; `basemapStyle.ts` drops `icon-image` from the label layers instead, so station, park and peak names draw without their icon and MapLibre has no missing image to warn about |

Most of the non-Latin ranges (Arabic, Devanagari, Thai, Cyrillic, ...) are country and ocean names at
world zoom, which the archive's low-zoom tiles carry. They cost nothing until a browser actually draws
one: MapLibre fetches a glyph file only when a label on screen needs it.

**Known gaps, drawn with the device's own fonts instead:** the Devanagari font (India's name at world
zoom), and a handful of characters outside the font set -- emoji and mathematical bold letters in a few
shop names. For each such range MapLibre logs one `Unable to load glyph range` warning and draws the
character locally; nothing breaks.

**The deploy gate requires the fonts.** `scripts/check-deploy-bundle.mjs` requires `OFL.txt` and each
font's `0-255.pbf`, and allows nothing under `basemap/fonts/` but range files of those three fonts.
After a release, `scripts/smoke-live.mjs` checks that the live site serves both the archive and a glyph
file.

[assets]: https://github.com/protomaps/basemaps-assets

### Rebuilding the label set

Re-run this after rebuilding the archive -- new place names can need new ranges:

1. Download `fonts/` from basemaps-assets at the pinned commit (or a newer one, then update the table
   above), checking every file against the git blob SHA-1 GitHub's contents API reports for it.
2. `node scripts/select-glyphs.mjs --fonts <download>/fonts` -- it reads every tile, keeps the ranges
   the label layers could need, and replaces `web/public/basemap/fonts/` with them. Like
   `build-basemap.mjs`, it downloads nothing itself.
3. Commit the result.

## Rebuilding it

```bash
node scripts/build-basemap.mjs
```

The script needs a `go-pmtiles` binary (the CLI, not a library) to do the actual extraction, and it
will not fetch one for you. Downloading and executing a third-party binary without a human looking
at it first is not a decision a build script gets to make on its own.

- If it finds `pmtiles` on `PATH`, or `PMTILES_BIN` pointing at one, it runs the extract and prints
  the resulting file size.
- If it finds neither, it prints the exact download URL, the checksum to verify the download
  against, and the manual verify-then-run steps, then **exits non-zero having downloaded nothing.**

### Getting the binary

- Binary: **go-pmtiles v1.31.2** -- <https://github.com/protomaps/go-pmtiles/releases>
- Windows x86_64 asset: `go-pmtiles_1.31.2_Windows_x86_64.zip`
- Windows x86_64 SHA-256: `a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1`

**What that checksum does and does not prove.** It is GitHub's own digest of the asset as stored on
its release servers. Matching it tells you the file you downloaded is byte-identical to the one
GitHub is serving -- i.e. it was not corrupted or tampered with in transit. It is **not** an
independent publisher signature: it does not prove the Protomaps maintainers built that binary from
the source they claim to, and anyone who could alter the release asset could alter this digest
alongside it. Treat it as tamper-evidence for the download, nothing stronger. If you want a real
provenance guarantee, build `go-pmtiles` from source instead of trusting a release binary.

Other platforms' assets and checksums are on the [releases page][releases] -- only the Windows
x86_64 checksum is recorded here because that is what this project's dev machine runs.

[releases]: https://github.com/protomaps/go-pmtiles/releases/tag/v1.31.2

### Refresh cadence

OSM data drifts -- roads open, buildings get added, place names change. There is no schedule for
re-extracting this file; once or twice a year is plenty for a citywide road/label basemap, and nothing
here depends on the basemap being current the way the parking forecasts do. Re-run the command above
when the map visibly looks stale, not on a timer.
