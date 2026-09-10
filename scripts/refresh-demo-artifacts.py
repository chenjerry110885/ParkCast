"""Rebuild the web app's artifacts from one live reading, with no collector running.

The collector lives on one machine. Anyone working on the *app* is usually on a
different one, and the two files the app reads go stale in two hours by design:
past `HORIZON_COUNT * HORIZON_STEP_MIN` the UI withdraws every probability and
shows the expired state. That is correct behaviour and a useless way to review a
ranked list.

This closes that gap honestly. It takes **one** reading from the public feed,
scores it against the corpus already on this machine, and writes `grid.bin` and
`lots.json` stamped with the real `base_data_ts` of that reading. Nothing is
invented: if the corpus here is a week behind, the climatology is a week behind
and the forecast is worse -- it is just not *stale*, which is a different fault.

**This is not collection, and must never become it.**

  - It writes to `web/public/artifacts/` only. `data/` is opened read-only, and
    the one row this fetches goes into a throwaway copy of `hot.sqlite` in a
    temp directory that is deleted on the way out.
  - So it cannot fork the corpus. Two machines collecting the same feed into two
    stores is the one unrecoverable mistake in this project (`docs/collector-move.md`),
    and the safety property here is structural rather than a warning in a comment.
  - One HTTP GET per run, unauthenticated, against a feed that publishes every
    five minutes. Running it repeatedly is rude, not dangerous; it is not a poll
    loop and should not be made into one.

    python scripts/refresh-demo-artifacts.py
    python scripts/refresh-demo-artifacts.py --out web/public/artifacts
"""
import argparse
import shutil
import struct
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from parkcast import config, store                                   # noqa: E402
from parkcast.artifacts import HEADER_FORMAT, HEADER_SIZE            # noqa: E402
from parkcast.collector import collect_once, fetch_json              # noqa: E402
from parkcast.metadata import capacity_map, parse_metadata           # noqa: E402
from parkcast.scheduler import publish_artifacts                     # noqa: E402


def describe(path: Path) -> str:
    header = struct.unpack(HEADER_FORMAT, path.read_bytes()[:HEADER_SIZE])
    _, _, generated_at, base_data_ts, n_lots, n_horizons, step, roster = header
    reading = datetime.fromtimestamp(base_data_ts, config.TAIPEI_TZ)
    age = (time.time() - base_data_ts) / 60
    span = n_horizons * step
    return (f"  {n_lots} lots x {n_horizons} horizons, roster {roster}\n"
            f"  reading {reading:%Y-%m-%d %H:%M} Taipei, {age:.0f} min old "
            f"(the app expires a forecast past {span - step} min)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="web/public/artifacts",
                        help="where to write grid.bin and lots.json")
    args = parser.parse_args()

    out = ROOT / args.out
    hot = ROOT / config.DB_PATH
    if not hot.exists():
        raise SystemExit(f"no corpus at {hot} -- this needs the history to forecast from")

    scratch = Path(tempfile.mkdtemp(prefix="parkcast-demo-"))
    try:
        # The copy is the safety property: every write below lands here, so the
        # real store cannot gain a row and cannot fork from the collector's.
        shutil.copy2(hot, scratch / "hot.sqlite")
        config.DB_PATH = scratch / "hot.sqlite"

        print("fetching one reading from the live feed...")
        raw_meta = fetch_json(config.METADATA_URL)
        lots = parse_metadata(raw_meta)

        conn = store.connect(config.DB_PATH)
        result = collect_once(conn, capacity_map(lots))
        reading = datetime.fromtimestamp(result.data_ts, config.TAIPEI_TZ)
        print(f"  data_ts {reading:%H:%M} Taipei, {result.rows_written} rows, "
              f"{len(lots)} lots in metadata")

        # `publish_artifacts` reads the cold store through this, and only reads
        # it -- compaction lives in `run_forever`, which is not called here.
        config.PARQUET_DIR = ROOT / "data" / "cold"
        publish_artifacts(conn, lots, out_dir=out)
        conn.close()
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    grid = out / "grid.bin"
    if not grid.exists():
        raise SystemExit(
            "publish_artifacts declined to write -- it refuses a roster that has "
            "collapsed or has no reading behind it. Check the log above."
        )
    print(f"\nwrote {out.relative_to(ROOT).as_posix()}/")
    print(describe(grid))
    return 0


if __name__ == "__main__":
    sys.exit(main())
