"""One row of features, defined once and used by both the trainer and the collector.

Why this is a module and not two convenient helpers
---------------------------------------------------
Training/serving skew is the failure mode that produces a model scoring well
offline and badly in production with nothing raising anywhere. It happens when
the trainer computes a feature one way and the server another -- a different
default for a missing capacity, a different day-of-week anchor, a category
hashed with a different function. Every one of those is invisible: the model
still returns a number between 0 and 1, the grid still publishes, the logs stay
green.

The only reliable defence is that there is one function, so `tests/test_trainset.py`
asserts the training row and the serving row are identical rather than merely
similar.

What is deliberately NOT here
-----------------------------
No imputation. LightGBM handles missing values natively, so an absent feature
stays absent and the model learns what absence means. Filling one in with 0
would state something the corpus does not: `capacity_car = 0` means a lot with
no car spaces, `free_car = 0` means a full one, and neither is "we do not know".
That distinction is the same one `grid.UNKNOWN` exists to protect at the other
end of the pipeline.

The order in `FEATURES` is part of the model's contract. It is recorded in the
manifest and checked on load, because feeding values to the wrong splits
produces entirely plausible probabilities and nothing else.

What this module can and cannot keep honest
-------------------------------------------
Every feature read from a lot's *tail* is cut at the origin here, whatever the
caller passed -- see `_at_or_before`. Every feature read from `counts` is not,
and cannot be: `Counts.add` folds a reading into three counters and the reading
is gone, so a future observation already counted cannot be subtracted at any
price. `load_history(before_ts=...)` is the only thing that can prevent that,
which is why the train/test contract lives in `forecast.py` and not here.
`tests/test_features.py` pins both halves of that boundary, so nobody later
assumes this module makes a leaky history safe.
"""
import math
from collections.abc import Sequence
from zlib import crc32

from parkcast import config, pricing
from parkcast.forecast import Climatology, History, week_bucket

#: Buckets a string category is hashed into. Taipei has ~12 districts and a
#: handful of lot types, so collisions at 1024 are vanishingly unlikely; the
#: alternative -- a vocabulary carried in the manifest -- would have to be
#: threaded through both callers to buy very little here.
CATEGORY_BUCKETS = 1024

_TAIPEI_OFFSET = 8 * 3600
_SECONDS_PER_DAY = 86400
#: 336 half-hours a week / 7 -- see `forecast.week_bucket`.
_BUCKETS_PER_DAY = 48

#: Minutes back that `trend_*` looks. The tail `load_history` keeps is
#: `config.HISTORY_TAIL` readings, 24 at a five-minute cadence, so 60 minutes is
#: comfortably inside it and 120 would not be.
TREND_WINDOWS_MIN = (15, 30, 60)

FEATURES: tuple[str, ...] = (
    "horizon_min",
    # the reading, and how it is moving
    "free_now", "free_ratio", "is_free_now", "staleness_min",
    "trend_15", "trend_30", "trend_60",
    # climatology, carried in rather than relearnt
    "clim_p", "clim_support", "lot_rate", "lot_n",
    # the clock
    "tod_sin", "tod_cos", "dow",
    # the lot
    "capacity_car", "capacity_motor", "charging", "serves_cars",
    "price_low", "price_high", "price_kind", "lot_type", "area", "city",
    # the neighbourhood
    "nbr_free", "nbr_seen",
)

#: Told to LightGBM as categorical rather than ordered. `dow` is included
#: because Saturday is not "one more than Friday" in any useful sense.
CATEGORICAL: tuple[str, ...] = ("dow", "price_kind", "lot_type", "area", "city")


def category(value: str | None) -> int | None:
    """A string category as a stable integer, or None when there is no value.

    `crc32`, never the builtin `hash`. Python salts `hash()` for str with
    PYTHONHASHSEED, so the trainer and the collector -- separate processes --
    would disagree about what a district means, consistently within each run and
    never between them. That is invisible to every test that runs in one
    process, which is why `tests/test_features.py` spawns a second interpreter
    with a different seed to check it.

    An empty string is absence, not a category: a lot whose `area` the feed
    omitted has an unknown district, and hashing "" would put every such lot in
    one bucket and invite the model to treat "unknown" as a place.
    """
    if not value:
        return None
    return crc32(value.encode("utf-8")) % CATEGORY_BUCKETS


def day_of_week(ts: int) -> int:
    """Taipei day of week, 0 = Thursday.

    Anchored on `forecast.week_bucket`, which counts 30-minute buckets from the
    Unix epoch -- and 1970-01-01 was a Thursday, so bucket 0 is Thursday 00:00
    Taipei and not Monday. This function exists so that fact is stated once:
    re-deriving it with `datetime.weekday()` would silently shift every weekday
    feature by three days while every probability stayed plausible.
    """
    return week_bucket(ts) // _BUCKETS_PER_DAY


def _at_or_before(series: Sequence[tuple[int, int]], ts: int) -> tuple[int, int] | None:
    """The newest reading no later than `ts`, or None.

    Callers are meant to hand over a history built with `before_ts`, and the
    backtest does. Serving does not -- it passes the live history, and
    `quality.data_ts_plausible` accepts a stamp up to `DATA_TS_MAX_AHEAD_SEC`
    ahead of the fetch, so a reading later than the origin can genuinely be
    sitting in the tail. Cutting here rather than trusting the caller is what
    makes the two paths agree in that case instead of differing invisibly, and
    it makes the leak property a test rather than a convention.

    A linear scan from the end: the tail is `config.HISTORY_TAIL` long (24), so
    this is a handful of comparisons and never worth a bisect.
    """
    for point in reversed(series):
        if point[0] <= ts:
            return point
    return None


def _trend(series, *, origin_ts: int, minutes: int, free_now: int | None) -> float | None:
    """Change in free spaces since `minutes` ago, or None with nothing to compare.

    None rather than 0.0 when the lot has only one reading: 0.0 says "not
    moving", which is a claim about a lot we have seen exactly once.
    """
    if free_now is None:
        return None
    past = _at_or_before(series, origin_ts - minutes * 60)
    if past is None or past[0] == origin_ts:
        return None
    return float(free_now - past[1])


def row(
    history: History,
    clim: Climatology,
    lot,
    *,
    origin_ts: int,
    horizon_min: int,
    neighbours: Sequence[str] = (),
) -> list[float | None]:
    """The feature vector for one (lot, origin, horizon), in `FEATURES` order.

    `neighbours` is the lot ids of the nearest few car parks, passed in rather
    than computed here: the geometry is static, so resolving it once per city
    costs nothing and resolving it per row would dominate the build.
    """
    target_ts = origin_ts + horizon_min * 60
    series = history.recent.get(lot.id, ())
    reading = _at_or_before(series, origin_ts)
    free_now = None if reading is None else reading[1]

    capacity = lot.capacity_car
    free_ratio = (None if free_now is None or not capacity
                  else min(1.0, free_now / capacity))

    bucket = history.counts.bucket.get((lot.id, week_bucket(target_ts)), (0, 0))
    lot_counter = history.counts.lot.get(lot.id, (0, 0))

    price = pricing.parse_fare(lot.fare_text)
    taipei_second = (origin_ts + _TAIPEI_OFFSET) % _SECONDS_PER_DAY
    angle = 2 * math.pi * taipei_second / _SECONDS_PER_DAY

    seen = [history.recent[n] for n in neighbours if n in history.recent]
    ratios = []
    for other in seen:
        point = _at_or_before(other, origin_ts)
        if point is not None:
            ratios.append(1.0 if point[1] >= 1 else 0.0)

    return [
        float(horizon_min),
        None if free_now is None else float(free_now),
        free_ratio,
        None if free_now is None else float(free_now >= 1),
        None if reading is None else (origin_ts - reading[0]) / 60.0,
        *(_trend(series, origin_ts=origin_ts, minutes=m, free_now=free_now)
          for m in TREND_WINDOWS_MIN),

        clim.predict(lot.id, target_ts, horizon_min),
        float(bucket[1]),
        None if not lot_counter[1] else lot_counter[0] / lot_counter[1],
        float(lot_counter[1]),

        math.sin(angle),
        math.cos(angle),
        float(day_of_week(origin_ts)),

        None if capacity is None else float(capacity),
        None if lot.capacity_motor is None else float(lot.capacity_motor),
        None if lot.charging is None else float(lot.charging),
        float(lot.serves_cars),
        None if price.low is None else float(price.low),
        None if price.high is None else float(price.high),
        category(price.kind),
        category(lot.lot_type),
        category(lot.area),
        category(lot.id.partition(":")[0]),

        None if not ratios else sum(ratios) / len(ratios),
        float(len(ratios)),
    ]
