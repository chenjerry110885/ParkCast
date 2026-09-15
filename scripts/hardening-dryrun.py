"""Rehearse the collector's offline work under the hardened container settings.

Run only through docker/docker-compose.dryrun.yml, against a snapshot copy. It
makes ONE metadata request (what the collector does at startup and each
day-rollover) and never polls availability or uploads. It proves that uid 10001
can write through the Docker Desktop bind mount, that pyproj works on a
read-only root, and that a publish, a compaction and a prune complete.

    ... run --rm rehearsal --day 2026-09-13
"""
import argparse
import os
import sys
import time
from datetime import date
from pathlib import Path

from parkcast import config, store
from parkcast.collector import fetch_json
from parkcast.metadata import parse_metadata
from parkcast.scheduler import archive_day, publish_artifacts


def _peak(name: str) -> str:
    path = Path("/sys/fs/cgroup") / name
    return path.read_text().strip() if path.exists() else "n/a"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--day", required=True, type=date.fromisoformat,
                        help="a completed day in the snapshot whose cold file was removed")
    args = parser.parse_args()

    print(f"uid={os.getuid()} gid={os.getgid()}")
    if os.getuid() != 10001:
        print("FAIL: not running as uid 10001")
        return 1

    probe = config.DATA_DIR / ".write-probe"
    probe.write_bytes(b"ok")
    probe.unlink()
    print("bind mount writable by uid 10001")

    started = time.monotonic()
    lots = parse_metadata(fetch_json(config.METADATA_URL))
    print(f"metadata parsed on a read-only root: {len(lots)} lots in {time.monotonic() - started:.1f}s")

    conn = store.connect(config.DB_PATH)
    try:
        started = time.monotonic()
        publish_artifacts(conn, lots)
        print(f"publish ok in {time.monotonic() - started:.1f}s")

        cold = config.PARQUET_DIR / f"{args.day.isoformat()}.parquet"
        if cold.exists():
            print(f"FAIL: {cold} exists; remove it from the COPY first")
            return 1
        started = time.monotonic()
        archive_day(conn, args.day)
        print(f"compaction ok in {time.monotonic() - started:.1f}s: {cold.exists()=}")

        removed = store.prune(conn, int(time.time()) - config.HOT_RETENTION_SEC)
        print(f"prune ok: {removed} rows")
    finally:
        conn.close()

    print(f"memory.peak={_peak('memory.peak')} pids.peak={_peak('pids.peak')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
