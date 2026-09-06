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
| Source | `https://build.protomaps.com/20260901.pmtiles` (128 GB planet build, public, no auth) |
| Bounding box | `121.4433,24.9576,121.6405,25.1999` -- all 1,088 tracked lots plus ~2 km margin |
| Zoom levels | 0-15 |
| Result | **~23 MB**, 633 tiles |
| Extract time | ~15 s over ~40 HTTP range requests (nothing else downloads) |

Zoom 15 is not an arbitrary cutoff: it is the planet build's own ceiling for this bbox. An extract
requesting `--maxzoom=16` against the same source came back byte-identical to the zoom-15 one --
there is no zoom-16 data to have.

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
