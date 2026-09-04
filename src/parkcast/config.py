"""Static configuration. No logic, no I/O."""
from datetime import timedelta, timezone
from pathlib import Path

AVAILABILITY_URL = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json"
METADATA_URL = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json"

DATA_DIR = Path("data")
DB_PATH = DATA_DIR / "hot.sqlite"
PARQUET_DIR = DATA_DIR / "cold"

TAIPEI_TZ = timezone(timedelta(hours=8))

# Feed data_ts minutes are congruent to 3 (mod 5); publication lands ~3 min later,
# i.e. minutes congruent to 1 (mod 5). Poll 30s after that to be safe.
POLL_MINUTE_MOD = 1
POLL_SECOND = 30
POLL_PERIOD_MIN = 5

RETRY_DELAYS_SEC = (45, 45, 60)  # if data_ts has not advanced
HTTP_TIMEOUT_SEC = 30

HOT_RETENTION_SEC = 48 * 3600

# Consecutive slots that may end without a fresh tick before the collector
# gives up and exits non-zero. 12 slots is one hour. Exiting lets Docker's
# restart policy fire and turns a silent stall into a visible restart count;
# looping forever on a feed that changed shape collects nothing while looking
# healthy.
MAX_EXHAUSTED_SLOTS = 12

# Taipei bounding box for coordinate sanity checks.
LAT_MIN, LAT_MAX = 24.5, 25.5
LON_MIN, LON_MAX = 121.0, 122.5
