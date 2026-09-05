"""Forecasters producing P(free_car >= 1) for a lot at a future time.

Three implementations share one protocol so Plan 4 can evaluate them against
each other and against a trained model on identical inputs.

Train/test contract
-------------------
The forecasters are not symmetric in what they consume. `Persistence` reads
only the newest tick, but `Climatology` (and therefore `Blend`) counts every
observation in the `History` it was built from. Scoring a Climatology built
over the whole store against observations inside that store lets it see its own
labels: its counts include the very reading being predicted, so it starts the
comparison with an advantage that no honest model can match. Spec section 8
exists to make that comparison meaningful, so it must not be rigged.

`load_history(conn, before_ts=T)` returns a history containing only
observations strictly before `T`. A backtest builds its forecasters from
`load_history(..., before_ts=T)` and scores them against observations at or
after `T`. The cutoff filters the hot query and the cold reader alike, so no
tier of the fallback chain and no lag feature can reach across it. Splits are
by time, never at random -- a random split leaks the future backwards through
those same counts.
"""
import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from heapq import heappush, heappushpop
from pathlib import Path
from typing import Protocol

from parkcast import config

log = logging.getLogger("parkcast.forecast")


@dataclass(frozen=True, slots=True)
class History:
    latest_ts: int
    current: dict[str, int]                     # newest reading per lot
    # The newest `config.HISTORY_TAIL` observations per lot, (data_ts, free_car),
    # ordered. A bounded tail, NOT the corpus: holding every observation reached
    # 1.2 GB by day 30 for a series nothing reads past its end. Climatology gets
    # the whole corpus through `counts` instead.
    recent: dict[str, list[tuple[int, int]]]
    # Hits/totals over the whole corpus, cold and hot alike. Forward-referenced
    # because `Counts` lives beside `week_bucket`, which it calls.
    counts: "Counts"


class Forecaster(Protocol):
    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        """P(free_car >= 1), or None when there is no basis for an answer."""
        ...


def load_history(
    conn, *, cold_dir: Path | None = None, before_ts: int | None = None
) -> History:
    """Read the hot store, optionally extended by the cold Parquet corpus.

    Missing readings are absent rather than zero: a NULL means the feed said
    nothing, and coercing it to 0 would assert the lot was full.

    `before_ts` keeps only observations strictly before it, in both stores --
    the train side of a time split. `current` and `latest_ts` then describe the
    newest tick before the cutoff, not the newest tick overall, so a forecaster
    built from this history cannot see a single label it will be scored on. See
    the train/test contract in the module docstring.

    `latest_ts` and `current` are read off the retained tail rather than queried
    separately, so they follow the history wherever it came from: a cutoff older
    than the 48-hour hot window still yields a working `Persistence`, instead of
    an empty `current` that quietly removes one of the two baselines from the
    comparison.

    What is retained, and why it differs by path
    -------------------------------------------
    `counts` covers the whole corpus; `recent` is only the newest
    `config.HISTORY_TAIL` observations per lot. The two are fed differently:

    * `counts` applies the date-ownership rule -- cold owns every day it holds a
      Parquet file for, so the hot copy of such a day is skipped. Counting a
      reading twice, at its true timestamp and again slot-snapped, would skew a
      rate.
    * `recent` is a tail, not a tally, so re-seeing an observation is harmless
      and the ownership skip does NOT apply to it.

    On the serving path (no cutoff) the cold counts come from a cache that folds
    each Parquet file exactly once, so cold is not re-streamed and cannot feed
    `recent` -- which is fine, because the hot store always holds 48 hours and
    the tail is 2. Filling `recent` from hot *without* the ownership skip is
    load-bearing here: for the first hours after each midnight rollover cold owns
    the day just compacted, and skipping it would leave `recent` -- and with it
    `current`, `latest_ts` and every Persistence answer -- nearly empty.

    On the backtest path the cache is bypassed and the hot store may hold nothing
    at all for an old cutoff, so `recent` is filled from the full cold+hot stream.
    """
    # A bounded min-heap per lot rather than a list to be truncated later: the
    # bound is what stops memory growing with corpus age, so it has to bind while
    # the corpus streams past, not after it has been assembled.
    tails: dict[str, list[tuple[int, int]]] = defaultdict(list)

    # Spliced in only when a cutoff is asked for. A data_ts range predicate on
    # the hot scan tempts the planner back onto idx_obs_data_ts, which is the
    # slow non-covering plan the scan below exists to avoid; backtests run
    # offline and can afford it, the 5-minute publish cannot.
    cut = "" if before_ts is None else " AND data_ts < :before"
    params = {} if before_ts is None else {"before": before_ts}

    cold_counts = Counts()
    owned: frozenset[int] = frozenset()

    if cold_dir is not None:
        from parkcast.compact import day_bounds  # local: compact imports pyarrow

        # Cold owns every Taipei day it holds a Parquet file for, and the hot
        # scan below skips those days when counting. The overlap used to be
        # resolved the other way round -- keep all of hot, drop the cold rows it
        # covers -- but that cutoff was derived from the hot store's own contents
        # and slid forward as the store pruned, which makes the cold counts
        # uncacheable. See `ColdCountCache` for the failure that causes.
        # Ownership never moves once a file exists, so a day is folded in once.
        owned = frozenset(day_bounds(day)[0] for day in compacted_days(cold_dir))

        # The shared cache is valid only for the unfiltered serving path: a
        # backtest cutoff must neither leave truncated counts behind for the
        # collector nor inherit the collector's uncut ones.
        cache = _COLD_CACHE if before_ts is None else ColdCountCache()
        cold_counts = cache.counts_through(cold_dir, before_ts)

        if before_ts is not None:
            # Backtest only. The serving path deliberately does not read the
            # Parquet files a second time here: the cache has already folded
            # them, and re-streaming them for a tail the hot store can supply on
            # its own cost a whole extra pass over the cold corpus every tick.
            for lot_id, ts, free in _read_cold(cold_dir):
                # The cutoff has to bind here too, or a backtest would train on
                # the cold copy of exactly the days it is scored against.
                if ts >= before_ts:
                    continue
                _keep_newest(tails[lot_id], ts, free)

    hot_counts = Counts()

    # Deliberately unordered. `idx_obs_data_ts` is non-covering, so ORDER BY
    # data_ts turns a table scan into one random primary-key lookup per row:
    # measured on the live store at 85,735 rows, 11.19s with the ORDER BY
    # against 0.16s without, and the cost grows with the window. Ordering is
    # `_keep_newest`'s job, and it does not depend on the order rows arrive in.
    for lot_id, ts, free in conn.execute(
        f"SELECT lot_id, data_ts, free_car FROM observations "
        f"WHERE free_car IS NOT NULL{cut}", params
    ):
        _keep_newest(tails[lot_id], ts, free)
        # Taking the hot copy of a day cold already owns would count the same
        # reading twice at two timestamps, silently double-weighting it.
        if not (owned and _taipei_day_start(ts) in owned):
            hot_counts.add(lot_id, ts, free)

    recent = {lot_id: sorted(heap) for lot_id, heap in tails.items()}

    # Derived from the retained tail, not from a second query against the hot
    # store. The hot store is pruned to 48 hours, so for any backtest cutoff
    # older than that -- which is every historical cutoff Plan 4 will use -- the
    # hot query matched nothing: `latest_ts` came back 0 and `current` empty,
    # `Persistence.predict` returned None for every lot, and the model was
    # silently compared against climatology alone. Spec section 8 requires it to
    # beat both. On the backtest path `recent` spans cold and hot alike, so
    # deriving from it reaches the cold corpus without a second read of anything.
    latest_ts = max((series[-1][0] for series in recent.values()), default=0)
    current = {
        lot_id: series[-1][1]
        for lot_id, series in recent.items()
        if series[-1][0] == latest_ts
    }
    return History(latest_ts, current, recent, cold_counts.combined(hot_counts))


def _keep_newest(heap: list[tuple[int, int]], ts: int, free: int) -> None:
    """Add one observation to a lot's tail, evicting the oldest past the bound.

    A min-heap keyed by timestamp rather than a `deque(maxlen=...)`: the hot scan
    carries no ORDER BY (see `load_history`), so arrival order is the storage
    engine's business, and on the backtest path the cold stream is spliced in
    ahead of it. A deque would keep the last rows to *arrive*, which is only
    incidentally the newest. This keeps the newest by timestamp whatever the
    order, in exactly `config.HISTORY_TAIL` slots per lot.
    """
    if len(heap) < config.HISTORY_TAIL:
        heappush(heap, (ts, free))
    else:
        heappushpop(heap, (ts, free))


_TAIPEI_OFFSET = 8 * 3600
_SECONDS_PER_DAY = 24 * 3600


def _taipei_day_start(ts: int) -> int:
    """Epoch second of Taipei midnight on the day containing `ts`.

    Taipei is a fixed UTC+8 with no DST, so this is exact integer arithmetic and
    agrees with `compact.day_bounds` for the corresponding date -- without a
    `datetime` per observation. The hot scan runs it ~85,000 times a tick.
    """
    return ((ts + _TAIPEI_OFFSET) // _SECONDS_PER_DAY) * _SECONDS_PER_DAY - _TAIPEI_OFFSET


def compacted_days(cold_dir: Path) -> frozenset[date]:
    """The Taipei dates the cold store owns -- one per daily Parquet file.

    Cheap by construction: the day is the file name, so this never opens a file
    and its cost is one directory listing regardless of corpus age.
    """
    days = set()
    for path in Path(cold_dir).glob("*.parquet"):
        try:
            days.add(date.fromisoformat(path.stem))
        except ValueError:
            continue        # not one of ours; `_read_parquet_day` skips it too
    return frozenset(days)


def _read_cold(cold_dir: Path):
    """Yield (lot_id, data_ts, free_car) from daily Parquet files, skipping nulls."""
    for path in sorted(Path(cold_dir).glob("*.parquet")):
        yield from _read_parquet_day(path)


def _read_parquet_day(path: Path):
    """Yield (lot_id, data_ts, free_car) from one daily Parquet file.

    A stem that is not an ISO date is not a day this project wrote, so it is
    skipped rather than parsed: one stray file in the cold directory must not be
    able to break a publish.
    """
    import pyarrow.parquet as pq

    from parkcast.compact import SLOTS_PER_DAY, SLOT_SECONDS, day_bounds

    try:
        day = date.fromisoformat(path.stem)
    except ValueError:
        return
    start, _ = day_bounds(day)
    for row in pq.read_table(path, columns=["lot_id", "free_car"]).to_pylist():
        for slot, free in enumerate(row["free_car"]):
            if free is not None and slot < SLOTS_PER_DAY:
                yield row["lot_id"], start + slot * SLOT_SECONDS, free


BUCKETS_PER_WEEK = 7 * 24 * 60 // config.CLIMATOLOGY_BUCKET_MIN


def week_bucket(ts: int) -> int:
    """Index of the Taipei time-of-week bucket containing `ts`.

    Taipei is a whole-hour offset with no DST, so shifting the epoch by 8h and
    bucketing is exact -- no calendar arithmetic needed.
    """
    local_min = (ts + 8 * 3600) // 60
    return int(local_min // config.CLIMATOLOGY_BUCKET_MIN) % BUCKETS_PER_WEEK


class Counts:
    """Accumulated (hits, total) at three tiers, fed one observation at a time.

    Climatology needs only these counts, never the observations behind them --
    which is what lets the corpus be streamed instead of held. Each counter is
    a two-element list so it can be incremented in place without rebuilding.
    """

    __slots__ = ("bucket", "lot", "glob")

    def __init__(self) -> None:
        self.bucket: dict[tuple[str, int], list[int]] = defaultdict(lambda: [0, 0])
        self.lot: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        self.glob: list[int] = [0, 0]

    def add(self, lot_id: str, ts: int, free: int) -> None:
        hit = 1 if free >= 1 else 0
        for counter in (self.bucket[(lot_id, week_bucket(ts))],
                        self.lot[lot_id], self.glob):
            counter[0] += hit
            counter[1] += 1

    def combined(self, other: "Counts") -> "Counts":
        """Elementwise sum. Neither operand is mutated.

        The cold cache is shared across ticks, so summing must never write to
        it -- a tick that mutated the cache would double-count on the next one.
        """
        merged = Counts()
        for src in (self, other):
            for key, counter in src.bucket.items():
                target = merged.bucket[key]
                target[0] += counter[0]; target[1] += counter[1]
            for key, counter in src.lot.items():
                target = merged.lot[key]
                target[0] += counter[0]; target[1] += counter[1]
            merged.glob[0] += src.glob[0]; merged.glob[1] += src.glob[1]
        return merged


class ColdCountCache:
    """Counts for the cold corpus, folded in once per file.

    A completed day's Parquet never changes, so its contribution to the
    climatology counts is fixed. Re-reading every file on every tick cost
    1.44 s per daily file -- 526 s per tick after a year, against a 300 s
    slot. Folding each file exactly once makes the per-tick cost flat.

    A file is identified by NAME, and remembered with the (mtime, size) it
    carried when it was folded. When a name comes back wearing a different
    stamp -- or stops being there at all -- the directory's accumulated counts
    are thrown away and every file is folded again from zero.

    Re-folding just the changed file would ADD its rows to the contribution its
    previous version already made, and `Counts` has no way to subtract. Byte-
    identical content is the case that makes this concrete: restoring `data/cold`
    from a backup, or rsyncing it into place, rewrites the same rows under a new
    mtime, and every counter would double. A uniform doubling leaves the rates
    themselves correct, so nothing looks wrong -- but it halves the weight of
    CLIMATOLOGY_BUCKET_PRIOR and CLIMATOLOGY_LOT_PRIOR relative to n, and every
    published probability sharpens. A partial restore skews the rates outright.

    Discarding the whole directory is the conservative choice rather than the
    lazy one: cold files are immutable in normal operation, so this fires only
    when something outside the collector has been at the corpus, and at that
    point the cheapest trustworthy state is the one read from disk. It is logged
    at WARNING with the file that triggered it -- re-reading the entire corpus is
    too much work to do silently, and by the time the counts look odd the mtime
    that explains them is long gone.

    The overlap with the hot store is resolved by DATE OWNERSHIP, not by a
    timestamp cutoff: cold owns every day that has a Parquet file, and the hot
    stream skips those days. A day's ownership never changes once its file
    exists, which is what makes folding-once correct.

    A timestamp cutoff would NOT be safe here. The old cutoff was the earliest
    hot observation, which slides forward as the store prunes. Day D's file is
    written at midnight while hot still covers D, so every row would be skipped
    as "already hot" and the file marked folded -- and 48 hours later, when hot
    has pruned D, those rows would be owed but never re-read. Every day would
    be silently lost from climatology in turn.

    Counts are held per directory. Production has exactly one cold directory,
    but a single accumulator would answer for whichever directories it happened
    to have been asked about -- so a second directory's totals would arrive
    carrying the first one's, which is wrong rather than merely wasteful.
    """

    def __init__(self) -> None:
        # dir -> (counts folded so far, file name -> the (mtime_ns, size) that
        # was folded). Keyed by name so a stamp change is an UPDATE to a known
        # file rather than the arrival of an unrelated one.
        self._by_dir: dict[Path, tuple[Counts, dict[str, tuple[int, int]]]] = {}

    def counts_through(self, cold_dir: Path, before_ts: int | None) -> Counts:
        key = Path(cold_dir)
        counts, folded = self._by_dir.setdefault(key, (Counts(), {}))

        stamps = {}
        for path in sorted(key.glob("*.parquet")):
            stat = path.stat()
            stamps[path.name] = (stat.st_mtime_ns, stat.st_size)

        # A file already folded whose stamp no longer matches -- rewritten, or
        # gone. Its old rows are inside `counts` and cannot be taken back out,
        # so the only correct move is to start the directory over.
        changed = sorted(name for name, was in folded.items() if stamps.get(name) != was)
        if changed:
            log.warning(
                "cold file(s) changed under the count cache (%s); discarding %s "
                "folded file(s) and re-folding %s from scratch",
                ", ".join(changed), len(folded), key,
            )
            counts, folded = self._by_dir[key] = (Counts(), {})

        for name, stamp in stamps.items():
            if name in folded:
                continue
            for lot_id, ts, free in _read_parquet_day(key / name):
                if before_ts is not None and ts >= before_ts:
                    continue
                counts.add(lot_id, ts, free)
            folded[name] = stamp
        return counts


# The serving path's cache, shared across ticks. Only ever used when `before_ts`
# is None -- see `load_history`.
_COLD_CACHE = ColdCountCache()


def _shrink(counter: list[int], prior_rate: float, strength: float) -> float:
    """Blend a [hits, n] counter toward `prior_rate` with `strength` pseudo-obs.

    Equivalent to a Beta(strength * prior_rate, strength * (1 - prior_rate))
    posterior mean. At n = 0 it returns the prior exactly, which is what makes
    a missing tier fall through to its parent without a special case.
    """
    hits, n = counter
    return (hits + strength * prior_rate) / (n + strength)


class Climatology:
    """P = this lot's historical rate at this time of week, shrunk toward the
    rates above it.

    The tiers are still lot+bucket -> lot -> global, but each one is a
    Beta-smoothed version of the one above rather than a raw fraction:

        lot_rate    = (lot_hits    + BETA  * global_rate) / (lot_n    + BETA)
        bucket_rate = (bucket_hits + ALPHA * lot_rate)    / (bucket_n + ALPHA)

    A 30-minute bucket at a 5-minute cadence sees 6 observations a week, so a
    raw hits/total is 0.0 or 1.0 in 96% of cells -- a baseline that answers a
    probability question with a certainty, and one a model would beat on Brier
    score without being any good. Spec section 8 makes climatology the bar to
    clear, so it has to be a real forecast.

    Shrinkage replaces the old CLIMATOLOGY_MIN_SUPPORT gate rather than joining
    it: a thin bucket is now pulled most of the way to its parent instead of
    being discarded at a threshold, and a bucket with no observations at all
    evaluates to exactly the lot rate, so the fallback chain is continuous
    rather than a cliff. A hard gate on top would only discard smoothed
    evidence that is already mostly its parent's.

    The global tier has nothing above it to shrink toward, so it takes a
    Jeffreys prior instead: (hits + 0.5) / (n + 1). Without it an unseen lot
    returns the raw citywide fraction, and a corpus that happened to be all
    hits -- a fresh store, a quiet night, a feed that briefly reported every
    lot free -- would hand back exactly 1.0 and propagate that certainty down
    every tier beneath it. "Never a certainty" was an empirical property of the
    current corpus; the prior makes it a property of the function.
    """

    def __init__(self, history: History) -> None:
        # Read, not recomputed. `load_history` accumulates these as the corpus
        # streams past, which is what lets the observations behind them be
        # dropped; re-deriving them here from `history.recent` would silently
        # narrow climatology to the last two hours. The counters are shared
        # rather than copied -- 36k buckets on the live store -- and `predict`
        # only reads them.
        self._bucket = history.counts.bucket
        self._lot = history.counts.lot
        self._global = history.counts.glob

    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        if not self._global[1]:
            return None
        # Jeffreys, i.e. _shrink(self._global, 0.5, 1.0): the uniform-ish prior
        # a tier with no parent shrinks toward. Structurally bounds the whole
        # chain away from 0 and 1 rather than relying on the corpus to be mixed.
        rate = (self._global[0] + 0.5) / (self._global[1] + 1)

        lot = self._lot.get(lot_id)
        if lot is None:
            return rate
        rate = _shrink(lot, rate, config.CLIMATOLOGY_LOT_PRIOR)

        bucket = self._bucket.get((lot_id, week_bucket(target_ts)))
        if bucket is None:
            return rate
        return _shrink(bucket, rate, config.CLIMATOLOGY_BUCKET_PRIOR)


class Persistence:
    """P = 1 if the lot currently has a space, else 0. Ignores the horizon.

    Deliberately naive and uncalibrated: this is the bar a real model has to
    clear, not a forecast anyone should ship on its own.
    """

    def __init__(self, history: History) -> None:
        self._current = history.current

    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        free = self._current.get(lot_id)
        return None if free is None else (1.0 if free >= 1 else 0.0)


class Blend:
    """Persistence decaying exponentially toward climatology as the horizon grows.

    The current reading is strong evidence about the next few minutes and
    almost none about two hours from now. Weighting it by 0.5**(h/half_life)
    expresses exactly that, and degrades to whichever component is available
    when the other has no answer.
    """

    def __init__(self, history: History) -> None:
        self._persistence = Persistence(history)
        self._climatology = Climatology(history)

    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        near = self._persistence.predict(lot_id, target_ts, horizon_min)
        far = self._climatology.predict(lot_id, target_ts, horizon_min)
        if near is None:
            return far
        if far is None:
            return near
        weight = 0.5 ** (horizon_min / config.BLEND_HALF_LIFE_MIN)
        return weight * near + (1.0 - weight) * far
