"""Normalisation and quality flagging for raw feed values.

Counts come in through `clean_count`, timestamps through `data_ts_plausible`.
Both exist for the same reason: a feed is a stranger's process, and a value it
sends that cannot be true must be recognised as such at the point of entry,
not discovered later by whatever reads the corpus.
"""
from enum import IntFlag

from parkcast import config


class Q(IntFlag):
    """Per-observation quality bits, written at insert time.

    FROZEN is the exception: it is detected, not stored. Freezing is a property
    of a run of readings rather than of any single one, so it can only be judged
    after the fact -- see report.find_frozen_lots, which reports the affected
    lots without rewriting their history. Persisting it would mean mutating
    already-collected rows, which is a deliberate design decision and not one
    to make as a side effect of a daily report.

    ASSUMED_TS is the opposite case, and belongs here for the reason FROZEN does
    not: whether the feed stamped a record is known at the instant it is parsed,
    is a fact about that one observation, and is never revised. It is also the
    only place it can be known. Kaohsiung and Taoyuan stamp `data_ts = now` on
    every row, so for them the city would answer it -- but Tainan, New Taipei
    and Hsinchu fall back to fetch time PER RECORD, whenever `update_time` is
    missing or unparseable, so for those three nothing else can.

    It records provenance, not validity. Every other bit here says something is
    wrong with the count; this one says the count is fine and the *timestamp* is
    our clock rather than the feed's. `feed.py` states the consequence: "A
    fetch-time stamp is an assumption, not a reading, and a backtest must be
    able to exclude it."
    """

    OK = 0
    MISSING = 1       # feed reported no data (sentinel or non-numeric)
    CLAMPED = 2       # free count exceeded capacity; clamped down
    NO_CAPACITY = 4   # capacity unknown, so no bound could be checked
    FROZEN = 8        # reserved: detected by report.find_frozen_lots, never written
    ASSUMED_TS = 16   # data_ts is our fetch clock: the feed stamped nothing


def clean_count(raw: object) -> int | None:
    """Convert a raw feed count to an int, or None when it means 'no data'.

    The feed uses -9 as its no-data sentinel. Treating it as a value would
    read as 'nine beyond full' and silently poison training. Zero is a real
    value and must survive: it means the lot is full.
    """
    try:
        value = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if value < 0 else value


def data_ts_plausible(data_ts: int, observed_at: int) -> bool:
    """Could a reading fetched at `observed_at` honestly be stamped `data_ts`?

    The window is `config.DATA_TS_MAX_AGE_SEC` back and
    `config.DATA_TS_MAX_AHEAD_SEC` forward, both inclusive; see those constants
    for the live measurements that motivate each bound.

    Note what this is NOT: a freshness check. A stamp inside the window may
    still be hours old, and `liveness` is what decides whether that lot's
    forecast may be published. This asks only whether the stamp can be a
    timestamp at all -- whether the corpus can key a row on it without
    inventing the fact. A `0` count is a real reading and a stale stamp is a
    real fact; a stamp 400 days in the future is neither.
    """
    return (
        observed_at - config.DATA_TS_MAX_AGE_SEC
        <= data_ts
        <= observed_at + config.DATA_TS_MAX_AHEAD_SEC
    )


def validate(free: int | None, capacity: int | None) -> tuple[int | None, Q]:
    """Bound a count against capacity and describe what happened."""
    if free is None:
        return None, Q.MISSING
    if capacity is None:
        return free, Q.NO_CAPACITY
    if free > capacity:
        return capacity, Q.CLAMPED
    return free, Q.OK
