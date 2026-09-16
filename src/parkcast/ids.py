"""Lot identity across cities.

Two cities use bare numeric ids -- New Taipei's `010001` and Tainan's `1` --
so a feed id alone cannot name a lot. The store namespaces every id; the
published artifacts strip it again, because each shard is one city and the
app's stored recents key on the id it already knows.
"""
SEPARATOR = ":"


def qualify(city: str, raw: str) -> str:
    return f"{city}{SEPARATOR}{raw}"


def city_of(lot_id: str) -> str:
    city, sep, _ = lot_id.partition(SEPARATOR)
    if not sep:
        raise ValueError(f"lot id {lot_id!r} is not namespaced")
    return city


def bare(lot_id: str) -> str:
    """The feed's own id. `partition`, not `split`, so a feed id containing a
    colon comes back whole rather than truncated at its first one."""
    _, sep, raw = lot_id.partition(SEPARATOR)
    if not sep:
        raise ValueError(f"lot id {lot_id!r} is not namespaced")
    return raw
