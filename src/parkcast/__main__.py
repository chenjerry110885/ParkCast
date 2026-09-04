"""Entry point: python -m parkcast"""
import logging
from datetime import date, datetime

from parkcast import config, store
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

    run_forever(
        conn,
        capacities,
        refresh_metadata=build_capacities,
        publish=lambda conn: publish_artifacts(conn, _lots),
    )


if __name__ == "__main__":
    main()
