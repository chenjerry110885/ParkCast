# Running the collector

The collector is the only always-on component. Every day it is not running is a
training day that cannot be recovered, so the operational rules below matter
more than they would for a stateless service.

```bash
docker compose -f docker/docker-compose.yml up -d --build --force-recreate
docker compose -f docker/docker-compose.yml logs -f collector
```

## `--force-recreate` is not optional

`docker compose up -d --build` rebuilds the image but **can leave the old
container running**. Compose recreates a container when it decides the service
changed; a rebuilt image with the same tag does not always count, so the
container keeps running the code it started with. The build output scrolls past
looking completely successful and the fix appears not to work — this cost real
confusion during Plan 2, where a change was debugged for several ticks before
anyone noticed the running container predated it.

Always deploy with:

```bash
docker compose -f docker/docker-compose.yml up -d --build --force-recreate
```

Confirm the new code is actually live before believing a result:

```bash
docker inspect -f '{{.State.StartedAt}}' docker-collector-1   # after the build
docker exec docker-collector-1 python -c \
  "import parkcast.forecast as f; print(f.__file__)"          # spot-check a change
```

## Never read `data/` from the host while the collector runs

The hot store is a WAL-mode SQLite file the collector is writing to. Read row
counts and run queries inside the container instead:

```bash
docker exec docker-collector-1 python -c \
  "import sqlite3; c=sqlite3.connect('/app/data/hot.sqlite'); \
   print(c.execute('SELECT COUNT(*) FROM observations').fetchone())"
```

For anything heavier, take a consistent snapshot with SQLite's backup API and
copy that out, rather than copying a file that is mid-write:

```bash
docker exec docker-collector-1 python -c \
  "import sqlite3; s=sqlite3.connect('/app/data/hot.sqlite'); \
   d=sqlite3.connect('/tmp/snap.sqlite'); s.backup(d)"
docker cp docker-collector-1:/tmp/snap.sqlite ./snap.sqlite
```

## Restarts are safe, and are verified

`PRAGMA synchronous=FULL` fsyncs every tick, so a stop loses nothing that was
already committed. Still, compare the row count before and after any restart:
an unexplained drop means the store, not the schedule, is the problem.

The collector logs one `tick data_ts=... rows=...` line and one
`published N lots x 24 horizons, M not updating` line per five-minute slot. Both
should appear within the first five minutes of a restart; if the publish line is
missing, the artifacts are stale even though collection is healthy. `M` counts
the lots published with no forecast because their feed has gone 24 hours without
an update (`src/parkcast/liveness.py`). A container still running an image built
before that rule logs the line without the `, M not updating` part — which is
also a quick way to tell whether a deploy actually took.

## A pause is not a stop

`restart: unless-stopped` covers a container that *exits*. A **paused**
container never exits: Docker freezes the process, the restart policy sees
nothing. On unpause the collector's overdue `sleep()` returns at once: it
polls immediately, off its usual phase (the tick after the 2026-09-13 pause
landed at 23:44:47), and is back in phase from the next slot. It logs nothing
about the gap itself — no error, no retry, no exhausted slot.

Measured 2026-09-13: a **Pause** click on the stack in Docker Desktop at
21:26:41 Taipei and a **Start** click at 23:44:46 cost 26 five-minute slots. The
collector's log went straight from the 21:26 tick to the 23:44 one. The host had
not slept — the Docker VM's `/proc/uptime` matched wall-clock time to within a
minute over 85 hours — and the container had not restarted.

The stack shows in the Docker Desktop dashboard as **`docker`**, because a
compose project takes the name of the directory its file lives in. That is
exactly the kind of name that gets paused while tidying up.

When coverage shows a gap, tell the causes apart before guessing:

```bash
docker inspect -f 'status={{.State.Status}} paused={{.State.Paused}} restarts={{.RestartCount}} started={{.State.StartedAt}}' docker-collector-1
```

- **Paused from the dashboard:** Docker Desktop's UI log records the click.
  Search `%LOCALAPPDATA%\Docker\log\host\electron-*.log` for
  `composePauseClicked` and `composeStartClicked`.
- **Host asleep:** the VM's uptime (`docker exec docker-collector-1 cat
  /proc/uptime`) should fall behind wall-clock time since Docker Desktop
  started by roughly the length of the gap, since a suspended VM does not
  count the time — this was used to rule a sleep *out* on 2026-09-13, not yet
  seen to rule one in — and the Windows System log carries Kernel-Power sleep
  and wake events.
- **Crash or stall:** the restart count rises, or the log shows
  `slot exhausted without a fresh tick`.

## Analysing the corpus while it runs

Anything heavier than a row count — `scripts/corpus-coverage.py`,
`scripts/evaluate-forecast.py`, an ad-hoc query — runs against a **snapshot**, in
a **throwaway container**, never against `data/` on the host:

```bash
# Written for Git Bash on the Windows desktop: MSYS_NO_PATHCONV=1 stops Git Bash
# rewriting container paths such as /tmp/snap into Windows paths.

# 1. A consistent copy taken by SQLite itself, plus the cold store, which is
#    only ever written by atomic rename.
MSYS_NO_PATHCONV=1 docker exec -i docker-collector-1 python - <<'EOF'
import os, shutil, sqlite3
os.makedirs("/tmp/snap/data", exist_ok=True)
src = sqlite3.connect("/app/data/hot.sqlite")
dst = sqlite3.connect("/tmp/snap/data/hot.sqlite")
src.backup(dst)
dst.close(); src.close()
shutil.copytree("/app/data/cold", "/tmp/snap/data/cold", dirs_exist_ok=True)
EOF
MSYS_NO_PATHCONV=1 docker cp docker-collector-1:/tmp/snap ../parkcast-snap
MSYS_NO_PATHCONV=1 docker exec docker-collector-1 rm -rf /tmp/snap

# 2. Run the working tree's code on a writable copy inside a fresh container.
#    The scripts put ../src first on sys.path, so the image's installed copy is not used.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "D:/Projects/ParkCast/src:/repo/src:ro" -v "D:/Projects/ParkCast/scripts:/repo/scripts:ro" \
  -v "D:/Projects/parkcast-snap:/snapro:ro" docker-collector:latest \
  sh -c "mkdir -p /work && cp -r /snapro/data /work/data && cd /work && python /repo/scripts/evaluate-forecast.py"
```

The snapshot lands beside the repository, not inside it — it is a copy of
`data/` — and can be deleted when you are done. On Linux or macOS drop the
`MSYS_NO_PATHCONV=1` prefixes and use the repository's own paths.

The Python test suite runs the same way on a machine whose Python has no pytest:
mount `src/`, `tests/` and `pyproject.toml` read-only into a throwaway
`docker-collector:latest` container and run `python -m pytest` there.
