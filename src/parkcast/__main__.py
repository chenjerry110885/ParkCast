"""Entry point: python -m parkcast"""
import logging
from datetime import date, datetime

from parkcast import config, store
from parkcast.collector import fetch_json
from parkcast.metadata import capacity_map, parse_metadata, snapshot_metadata
from parkcast.scheduler import run_forever


def build_capacities(day: date) -> dict[str, int | None]:
    """Fetch metadata, snapshot it for `day`, and return the capacity map."""
    raw = fetch_json(config.METADATA_URL)
    snapshot_metadata(raw, config.PARQUET_DIR / "meta", day)
    return capacity_map(parse_metadata(raw))


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("parkcast")

    conn = store.connect(config.DB_PATH)

    capacities = build_capacities(datetime.now(config.TAIPEI_TZ).date())
    log.info("loaded capacities for %s lots", len(capacities))

    run_forever(conn, capacities, refresh_metadata=build_capacities)


if __name__ == "__main__":
    main()
