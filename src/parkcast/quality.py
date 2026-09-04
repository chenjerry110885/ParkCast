"""Normalisation and quality flagging for raw feed counts."""
from enum import IntFlag


class Q(IntFlag):
    OK = 0
    MISSING = 1       # feed reported no data (sentinel or non-numeric)
    CLAMPED = 2       # free count exceeded capacity; clamped down
    NO_CAPACITY = 4   # capacity unknown, so no bound could be checked
    FROZEN = 8        # value unchanged for suspiciously long (set by report.py)


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
