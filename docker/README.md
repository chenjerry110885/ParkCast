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
`published N lots x 24 horizons` line per five-minute slot. Both should appear
within the first five minutes of a restart; if the publish line is missing, the
artifacts are stale even though collection is healthy.
