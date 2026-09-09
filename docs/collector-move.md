# Moving the collector to another machine

The collector currently runs on a laptop that sleeps, and the corpus shows it: 37% coverage over
the first six days, with 12:00–14:30 captured on one day in six (`python scripts/corpus-coverage.py`).
Moving it to a machine that stays on is the fix. This is the runbook.

It is written to be followed by someone — or some session — with no memory of how the project got
here. The repository is the handoff.

---

## What travels, and how

| | how | notes |
|---|---|---|
| Code, docs, scripts, `CLAUDE.md` | **git** | 114 tracked files. `git clone` is the whole story. |
| `data/` | **by hand** | ~62 MB. **Irreplaceable — see below.** |
| `web/public/basemap/taipei.pmtiles` | regenerate | 24 MB, `node scripts/build-basemap.mjs` |
| `web/public/artifacts/` | regenerate | `node scripts/sync-artifacts.mjs`, dev only |

**`data/` is the only thing that cannot be rebuilt.** Every observation in it was fetched from a
feed that publishes the present and never the past. Losing it does not cost time; it costs the
data itself, permanently, and Plan 4 has nothing to train on without it.

---

## The two ways to lose the corpus while moving it

**1. Copying a live SQLite database.** `data/hot.sqlite` runs in WAL mode, and the write-ahead log
is routinely tens of megabytes — it was 25 MB at the time of writing, against a 26 MB main file.
Copying `hot.sqlite` alone silently drops everything in that log. Copying all three files while the
collector is mid-write can capture a torn state instead.

This is not hypothetical for this project: during Plan 1 a host-side read of the bind mount while
the container was writing appeared to show a 212-row truncation that had never happened.

**So: stop the container before copying.** A clean shutdown checkpoints the WAL into the main file.

**2. Running both collectors at once.** Two machines polling the same feed write two divergent
corpora, and the daily Parquet files will disagree about the same day. There is no merge tool, and
writing one is not worth it. **Exactly one collector runs at any time.**

---

## The move

### On the old machine

```bash
cd "path/to/ParkCast"
git status --short                      # commit or stash anything outstanding
docker compose -f docker/docker-compose.yml down
```

Record the numbers to check against afterwards:

```bash
python scripts/corpus-coverage.py | tail -5
```

Then copy the whole `data/` directory — USB, network share, `scp`, anything — preserving the
structure:

```
data/
  hot.sqlite            the rolling 48-hour window
  cold/*.parquet        one file per completed Taipei day
  cold/meta/*.json      one raw metadata snapshot per day
  artifacts/            grid.bin and lots.json, regenerated every tick
```

After a clean `down` there should be no `hot.sqlite-wal` or `-shm`. If there is, the container did
not shut down cleanly — copy them too, in the same pass, and do not touch the files in between.

**Leave the collector stopped on the old machine.** Do not restart it "just until the new one is
up": that is how you end up with two corpora.

### On the new machine

Needs Docker, and that is all — the image builds Python 3.13 itself. Node 22 and a Python venv are
only wanted if you also intend to run the web app or the scripts there.

```bash
git clone https://github.com/chenjerry110885/ParkCast.git
cd ParkCast
# put the copied data/ directory here, at the repo root, before starting anything
docker compose -f docker/docker-compose.yml up -d --build
```

`docker-compose.yml` bind-mounts `../data` and sets `TZ: Asia/Taipei`. There are no ports, no
secrets and no environment to configure. `restart: unless-stopped` brings it back after a reboot.

### Check it actually arrived

```bash
docker compose -f docker/docker-compose.yml logs --tail 20
python scripts/corpus-coverage.py | tail -5
```

Within about five minutes the log should show a `tick data_ts=… rows=…` followed by
`published … lots x 24 horizons`. The coverage figures must match what you recorded on the old
machine, give or take the minutes the collector was down. **If coverage is lower, stop and work out
why before letting it run** — a fresh `hot.sqlite` alongside intact Parquet files looks healthy and
is not.

---

## Afterwards

Two things change and should be written down rather than assumed:

- **The gap disclosure.** `CLAUDE.md` and the README both state the coverage limitation as a
  measured fact. Once the machine stops sleeping the numbers improve, and the honest thing is to
  re-measure and say so — including that the *existing* thin buckets stay thin forever, because no
  amount of later collection fills a hole in the past. Any evaluation still has to report
  per-bucket support.
- **`restart: unless-stopped` does not cover sleep.** It fires when the container *exits*. A
  suspended host does not exit it — the process simply resumes mid-`sleep()` on wake, which is what
  happened on 2026-09-09 after a 44-hour suspend. Do not let the move be taken as proof the restart
  policy handles this; what it handles is reboots and crashes.

If the new machine also sleeps, check its power settings before concluding the move worked. One
full day of coverage is the signal to look for, not one successful tick.
