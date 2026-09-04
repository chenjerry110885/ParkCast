"""Normalisation and quality flagging for raw feed counts."""
from enum import IntFlag


class Q(IntFlag):
    """Per-observation quality bits, written at insert time.

    FROZEN is the exception: it is detected, not stored. Freezing is a property
    of a run of readings rather than of any single one, so it can only be judged
    after the fact -- see report.find_frozen_lots, which reports the affected
    lots without rewriting their history. Persisting it would mean mutating
    already-collected rows, which is a deliberate design decision and not one
    to make as a side effect of a daily report.
    """

    OK = 0
    MISSING = 1       # feed reported no data (sentinel or non-numeric)
    CLAMPED = 2       # free count exceeded capacity; clamped down
    NO_CAPACITY = 4   # capacity unknown, so no bound could be checked
    FROZEN = 8        # reserved: detected by report.find_frozen_lots, never written


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


def validate(free: int | None, capacity: int | None) -> tuple[int | None, Q]:
    """Bound a count against capacity and describe what happened."""
    if free is None:
        return None, Q.MISSING
    if capacity is None:
        return free, Q.NO_CAPACITY
    if free > capacity:
        return capacity, Q.CLAMPED
    return free, Q.OK
