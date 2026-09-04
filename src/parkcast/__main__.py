"""Entry point: python -m parkcast"""
import logging
from datetime import datetime

from parkcast import config, store
from parkcast.collector import fetch_json
from parkcast.metadata import capacity_map, parse_metadata, snapshot_metadata
from parkcast.scheduler import run_forever


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("parkcast")

    conn = store.connect(config.DB_PATH)

    raw_metadata = fetch_json(config.METADATA_URL)
    snapshot_metadata(raw_metadata, config.PARQUET_DIR / "meta", datetime.now(config.TAIPEI_TZ).date())
    capacities = capacity_map(parse_metadata(raw_metadata))
    log.info("loaded capacities for %s lots", len(capacities))

    run_forever(conn, capacities)


if __name__ == "__main__":
    main()
