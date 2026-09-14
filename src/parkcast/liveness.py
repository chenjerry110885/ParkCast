"""Which lots' feeds have stopped updating, judged from the hot store.

Measured 2026-09-14: over 82 hours of unbroken collection, 92 car parks did not
change their reading once. The 40 sitting at 0 free were published as a 0%
chance of a space; the rest, stuck at a fixed number or at capacity, as 100% --
陽明山花鐘停車場 reported all 34 of its spaces free for a whole weekend. For 3-4%
of destinations the app's top recommendation was one of them. That is the
complaint this project exists to answer -- it said there was a space, and there
wasn't -- produced by the app itself.

So a lot whose feed has not updated in `config.NOT_UPDATING_AFTER_SEC` gets no
forecast: every cell of its grid row is UNKNOWN, and `lots.json` says when it
last updated. It is not dropped. A missing car park is invisible; one marked
"not updating" is a true statement a driver can act on.

What this is not
----------------
* **Not a collection rule.** The readings are still collected and stored
  exactly as the feed sent them. Judging a lot frozen is a decision about what
  to *publish*, and the corpus has to stay a faithful record of the feed -- the
  same line `Lot.serves_cars` draws.
* **Not `report.find_frozen_lots`.** That counts 6-hour runs for the daily log
  and flags ~45% of lots on a full day, because a quiet night is a 6-hour run.
  It is left as it is; this is the rule that decides something.
* **Not a claim about the cause.** For most of these lots the feed keeps
  sending a number; all we can see is that it stopped changing. Hence "not
  updating", never "offline".

Stateless on purpose
--------------------
Recomputed from the store on every publish rather than tracked across ticks, so
a restart loses nothing and a lot rejoins the forecast on the tick its reading
moves. One pass cost 0.23 s over 635,563 rows on a snapshot of the live store,
because the query walks the primary key backwards and SQLite needs no sort.

The hot store holds 48 hours, so no run can be seen to be longer than that,
and "no change in N h" is a lower bound on what was *observed*. It assumes
nothing changed while the collector itself was not collecting: the coverage
guard rejects a run that is mostly gap, but a run half observed and half gap
still counts, and after a collector outage of a day or more a lot whose first
reading back is missing is withheld from its last reading. Both clear on the
next reading; ending runs at collector gaps is a known follow-up.
"""
from collections.abc import Collection, Iterable
from dataclasses import dataclass
from itertools import groupby
from operator import itemgetter

from parkcast import config, store

SLOT_SECONDS = config.POLL_PERIOD_MIN * 60

# Both columns DESC, deliberately. The table is WITHOUT ROWID on (lot_id,
# data_ts), so a fully reversed order is a backwards walk of the primary key.
# `lot_id, data_ts DESC` mixes directions and makes SQLite build a temporary
# B-tree for the second term.
_READINGS_NEWEST_FIRST = (
    "SELECT lot_id, data_ts, free_car FROM observations "
    "WHERE free_car IS NOT NULL ORDER BY lot_id DESC, data_ts DESC"
)


@dataclass(frozen=True, slots=True)
class Run:
    """The run of identical readings that ends at a lot's newest reading."""
    newest_ts: int
    since_ts: int      # data_ts of the run's first, oldest reading
    readings: int
    value: int


def unchanged_run(newest_first: Iterable[tuple[int, int]]) -> Run | None:
    """The run of identical readings ending at the newest, or None if there are none.

    `newest_first` is (data_ts, free_car) with NULLs already removed: a missing
    reading says nothing about whether the value changed, so it neither ends a
    run nor counts towards one. Stops at the first different value, so a live
    lot costs a step or two however much history it has.
    """
    readings = iter(newest_first)
    first = next(readings, None)
    if first is None:
        return None
    newest_ts, value = first
    since_ts, count = newest_ts, 1
    for ts, free in readings:
        if free != value:
            break
        since_ts, count = ts, count + 1
    return Run(newest_ts, since_ts, count, value)


def last_update(run: Run | None, *, window_start: int) -> int:
    """When the app treats this lot as having last updated.

    * No reading in the window: the window's start, the latest it could have been.
    * A run with readings on at least `NOT_UPDATING_MIN_COVERAGE` of its
      5-minute slots: the run's first reading.
    * A sparser run: its newest reading. A value seen either side of a long
      collector outage may have changed in between, so the run proves nothing.
    """
    if run is None:
        return window_start
    slots = (run.newest_ts - run.since_ts) // SLOT_SECONDS + 1
    if run.readings >= config.NOT_UPDATING_MIN_COVERAGE * slots:
        return run.since_ts
    return run.newest_ts


def withheld_since(run: Run | None, *, as_of: int, window_start: int) -> int | None:
    """The lot's last update if it is old enough to withhold the forecast, else None."""
    updated = last_update(run, window_start=window_start)
    return updated if as_of - updated >= config.NOT_UPDATING_AFTER_SEC else None


def not_updating(conn, lot_ids: Collection[str], *, as_of: int) -> dict[str, int]:
    """{lot_id: last update} for each of `lot_ids` that has not updated in time.

    `as_of` is the reading being published, `History.latest_ts`. Readings after
    it are skipped here rather than filtered in SQL: a `data_ts` predicate
    tempts the planner onto `idx_obs_data_ts`, the slow non-covering plan
    `forecast.load_history` documents.
    """
    window_start = store.oldest_data_ts(conn)
    if window_start is None:
        return {}
    wanted = set(lot_ids)
    runs: dict[str, Run | None] = {}
    for lot_id, rows in groupby(conn.execute(_READINGS_NEWEST_FIRST), key=itemgetter(0)):
        if lot_id in wanted:
            runs[lot_id] = unchanged_run((ts, free) for _, ts, free in rows if ts <= as_of)
    withheld = {}
    for lot_id in wanted:
        since = withheld_since(runs.get(lot_id), as_of=as_of, window_start=window_start)
        if since is not None:
            withheld[lot_id] = since
    return withheld


class Withholding:
    """A forecaster with no answer for the lots in `withheld`.

    A wrapper rather than an edit to the grid bytes afterwards, so everything
    that asks a forecaster -- the grid and the backtest alike -- gets the same
    answer: for a lot that is not updating, there is no forecast.
    """

    def __init__(self, inner, withheld: Collection[str]) -> None:
        self._inner = inner
        self._withheld = withheld

    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        if lot_id in self._withheld:
            return None
        return self._inner.predict(lot_id, target_ts, horizon_min)
