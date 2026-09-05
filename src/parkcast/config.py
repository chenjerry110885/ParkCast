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

# --- forecasting ---
HORIZON_STEP_MIN = 5
HORIZON_COUNT = 24            # +5 min through +120 min
CLIMATOLOGY_BUCKET_MIN = 30   # time-of-week bucket width
# Hierarchical shrinkage strengths, in pseudo-observations. A 30-min bucket at a
# 5-min cadence accrues only 6 observations per week, so an unsmoothed bucket
# rate is 0/6 or 6/6 far more often than not: measured, 96.1% of bucket rates
# came back as exactly 0.0 or 1.0 and 79% of published grid bytes were 0 or 100.
# Shrinking the bucket toward the lot and the lot toward the city removes that
# entirely (0.0% degenerate) while preserving the mean at the true base rate.
# Both levels are needed -- many lots are themselves at exactly 1.0, so shrinking
# the bucket alone only moves 96% to 79%.
CLIMATOLOGY_BUCKET_PRIOR = 8  # bucket shrinks toward the lot rate
CLIMATOLOGY_LOT_PRIOR = 20    # lot shrinks toward the citywide rate
BLEND_HALF_LIFE_MIN = 30      # persistence weight halves every 30 min of horizon

# Observations retained per lot in `History.recent`: 2 hours at the 5-minute
# cadence. Only the newest reading is actually consumed today (Persistence, and
# the freshness stamp on the artifacts), but a short tail is what a lag feature
# will need and it costs nothing. Climatology reads `History.counts`, which
# covers the whole corpus, so this bound does not truncate what it learns --
# which is the point: memory stops growing with corpus age.
HISTORY_TAIL = 24

ARTIFACT_DIR = DATA_DIR / "artifacts"
# Refuse to publish a grid holding less than this fraction of the lots the
# currently published grid holds. A partially restored store that yields 40 lots
# would otherwise replace a 1,088-lot grid with the city losing 96% of its
# parking -- the same failure the empty guard already covers, one notch down.
MIN_PUBLISH_LOT_FRACTION = 0.5
