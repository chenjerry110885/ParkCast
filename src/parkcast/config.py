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

# How much of the 300s slot the in-slot retry loop must leave behind it.
#
# The retry budget above was tuned when there was one source: 4 attempts x 30s
# of socket timeout plus 45+45+60s of delay is 270s, just inside the slot. With
# six sources one attempt costs `len(pending) x HTTP_TIMEOUT_SEC`, so the same
# budget runs to 870s in the worst case. An overrun is not merely a late
# publish: `next_poll_ts` returns the *next* slot boundary after the loop
# finishes, so a slot that ends past its successor's start skips that
# successor outright -- and every healthy city loses that reading with it.
# Measured by the reviewer against the real loop: two hanging feeds stretch a
# slot to ~390s and Taipei, which succeeded on attempt 1, polls 12 times in 24
# slots, permanently. Taipei's readings cannot be re-fetched.
#
# So the loop gets a deadline at `slot start + 300 - this`, and the reserve is
# what publishing (six shards), the day-rollover compaction and prune get to
# spend after it. 45s is roughly three times the longest publish measured
# (0.22s for the liveness pass over 635,563 rows, a few seconds for the whole
# six-shard path) and equals one retry delay, so it is also the granularity at
# which the loop can give an attempt up.
SLOT_RESERVE_SEC = 45

# Plausibility window for a feed's own `data_ts`, measured against the fetch
# time. Counts go through `quality.clean_count` and coordinates through
# `geo.in_taiwan`; until this, timestamps went through nothing.
#
# Live, not theoretical: one fetch of Tainan on 2026-09-16 returned 16 of 268
# records stamped more than 48 h old, the worst by 2.3 years. Those rows insert
# and then prune inside the same slot -- never compacted, a silent hole in the
# corpus -- and their lots can never pass the publish filter. The future
# direction is worse and unrecoverable: one record stamped 400 days ahead pins
# `store.latest_data_ts` to itself forever, so the city reads stalled on every
# healthy tick and is retried four times a slot; `base_data_ts` publishes 400
# days in the future; `free_at` matches only the poisoned lot, so every other
# card loses its observed count; and the row neither prunes nor compacts.
#
# 48 h is the hot window itself (`HOT_RETENTION_SEC`): a stamp older than that
# is one no reader could ever have used. 15 min forward is the whole retry
# budget plus a margin for a feed clock that runs fast -- generous enough that
# no honest publication is refused, tight enough that nothing can outrun prune.
DATA_TS_MAX_AGE_SEC = 48 * 3600
DATA_TS_MAX_AHEAD_SEC = 15 * 60

# Largest feed body accepted. Measured 2026-09-14: availability 421,825 B,
# metadata 2,883,343 B. 32 MiB is ~11x the larger, so growth never trips it,
# while a hijacked or broken endpoint cannot stream gigabytes into memory.
MAX_FEED_BYTES = 32 * 1024 * 1024

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

# Nationwide bounding box, for the other five adapters' coordinate sanity
# checks (`sources.geo.in_taiwan`). Wide enough to include Kinmen and Penghu,
# both far west of the main island, without widening Taipei's own box above.
TW_LAT_MIN, TW_LAT_MAX = 21.5, 25.5
TW_LON_MIN, TW_LON_MAX = 118.0, 122.5

# --- forecasting ---
HORIZON_STEP_MIN = 5
HORIZON_COUNT = 24            # +5 min through +120 min
# Time-of-week bucket width. MUST stay a whole number of compaction slots
# (compact.SLOT_SECONDS, 300s) -- test_config pins it.
#
# `compact_day` files each reading at the start of its 5-minute slot, so the cold
# copy of an observation carries a data_ts up to one slot earlier than the hot
# copy of the same reading (in practice exactly 180s earlier: feed data_ts minutes
# are congruent to 3 mod 5). The two copies agree on climatology only because a
# bucket boundary can never fall between them, and that holds only while the
# bucket width is a multiple of the slot. A finer 12-minute bucket, say, would put
# some readings in one bucket via hot and the neighbouring one via cold -- so the
# counts would depend on which side of a midnight compaction each reading was
# seen on, and would shift under themselves as days rolled into the cold store.
CLIMATOLOGY_BUCKET_MIN = 30
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

# --- feed liveness ---
# How long a lot may go without an update before its forecast is withheld. A
# lot's "last update" is the start of its current run of identical readings, or
# its last reading if it stopped reporting -- see `liveness.last_update`.
#
# Measured 2026-09-14 over 82 h of unbroken collection: the longest unchanged
# run falls smoothly -- 80% of lots have one of 3 h, 28% of 12 h, 12.8% of 24 h,
# 8.6% of 72 h -- so there is no natural gap to pick. Overnight runs of 6-12 h
# are ordinary, which is why the daily report's 72-observation
# `find_frozen_lots` flags ~45% of lots on a full day. 24 h is the shortest
# window that always spans a daytime period, and a live car park's count moves
# at least once across one.
NOT_UPDATING_AFTER_SEC = 24 * 3600
# A run is only trusted to have been unchanged if readings exist on at least
# this share of its 5-minute slots. Without it, a lot that read 5 before a long
# collector outage and 5 again after it would look frozen straight across it.
NOT_UPDATING_MIN_COVERAGE = 0.5

# --- uploading to the deployed site (docs/deploy.md) ---
# The Worker's hostname. Not secret -- the repository is public. A host
# containing "REPLACE" keeps uploads switched off; `upload.upload_url` refuses
# any URL whose host is not exactly this.
UPLOAD_HOST = "parkcast.tpe-dev.workers.dev"
UPLOAD_URL_ENV = "PARKCAST_UPLOAD_URL"
# Cloudflare refuses urllib's default "Python-urllib/3.x" user agent at its edge
# (403, "error code: 1010") before the Worker ever sees the request -- measured
# on the first live upload, 2026-09-15. Any honest name of our own gets through.
UPLOAD_USER_AGENT = "parkcast-collector/1"
UPLOAD_SECRET_PATH = Path("/run/secrets/parkcast_upload_secret")
UPLOAD_TIMEOUT_SEC = 10          # per socket operation
UPLOAD_DEADLINE_SEC = 30         # whole attempt, DNS included
UPLOAD_DAILY_CAP = 300           # attempts per Taipei day; 288 slots exist
UPLOAD_MAX_SKIP_TICKS = 12       # back-off ceiling: one hour of slots
UPLOAD_AUTH_RETRY_SEC = 3600     # after a 401
UPLOAD_LIMIT_PROBE_SEC = 3600    # after the daily-limit response
