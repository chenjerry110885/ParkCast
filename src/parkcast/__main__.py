"""Entry point: python -m parkcast"""
import logging
from datetime import date, datetime

from parkcast import config, store, upload
from parkcast.collector import fetch_json
from parkcast.metadata import Lot, capacity_map, parse_metadata, snapshot_metadata
from parkcast.scheduler import publish_artifacts, run_forever

# The lot list `publish_artifacts` reads each tick. `build_capacities` refreshes
# it alongside the capacity map on every day-rollover, so it is never frozen at
# whatever the feed looked like on day one - a bug this codebase has already
# had to fix once for capacities themselves.
_lots: tuple[Lot, ...] = ()


def build_capacities(day: date) -> dict[str, int | None]:
    """Fetch metadata, snapshot it for `day`, and return the capacity map."""
    global _lots
    raw = fetch_json(config.METADATA_URL)
    snapshot_metadata(raw, config.PARQUET_DIR / "meta", day)
    _lots = parse_metadata(raw)
    return capacity_map(_lots)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("parkcast")

    conn = store.connect(config.DB_PATH)

    # Before anything reads the store. The first tick below writes namespaced
    # ids, so any row still carrying a pre-namespacing one would sit in the same
    # hot window as the namespaced rows for the same physical car park -- and
    # `forecast.load_history` keys `current` and `counts` on that string, so the
    # lot's history splits in two. That is the half feeding `Persistence` and
    # `store.free_at`: the short-horizon forecast and the observed count on
    # every card, wrong for as long as the split lasts and entirely plausible
    # throughout. Waiting for prune to age the old rows out would mean two days
    # of it on the only corpus this project has.
    #
    # Logged at INFO every boot, including the zeroes: the first run after the
    # migration lands reports a large one-off number worth seeing, and every
    # later run reporting 0 is the signal that it is idempotent and has nothing
    # left to do.
    #
    # Survivable, because collection is the irreplaceable half and this is not.
    # The migration runs in one transaction that rolls itself back, so a failure
    # leaves the store exactly as it was -- two id conventions in one window,
    # which costs precision on the short-horizon forecast and the observed count
    # until it is resolved. Dying here instead would cost every tick, on every
    # restart, until someone ran SQL by hand: a strictly worse outcome than the
    # one the migration exists to prevent. Same reasoning as the metadata fetch
    # below, and as `run_forever`'s net around publishing.
    try:
        migration = store.migrate_to_namespaced_ids(conn)
    except Exception:
        log.exception(
            "id migration failed and was rolled back; collecting anyway. Until "
            "this succeeds the hot window may hold both id conventions for one "
            "car park, which splits its history across `current` and `counts`"
        )
    else:
        log.info(
            "id migration rewrote %s pre-namespacing row(s) and dropped %s "
            "already superseded by a namespaced twin",
            migration.rewritten, migration.dropped,
        )

    # The metadata blob is 2.85 MB and separate from the availability blob, so
    # it can be unavailable while collection would be perfectly fine. Dying
    # here costs ticks that cannot be re-fetched; starting with no capacities
    # costs nothing but a NO_CAPACITY flag on every lot, and the day-rollover
    # refresh fills them in. This mirrors the rollover path, which already
    # treats a metadata failure as survivable.
    try:
        capacities = build_capacities(datetime.now(config.TAIPEI_TZ).date())
        log.info("loaded capacities for %s lots", len(capacities))
    except Exception:
        capacities = {}
        log.exception(
            "metadata unavailable at startup; collecting with no capacities "
            "(every lot flags NO_CAPACITY) until the next day-rollover refresh"
        )

    # None unless the upload URL and the secret file are both valid; logs why once.
    uploader = upload.from_environment()

    run_forever(
        conn,
        capacities,
        refresh_metadata=build_capacities,
        publish=lambda conn: publish_artifacts(conn, _lots, uploader=uploader),
    )


if __name__ == "__main__":
    main()
