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


# The city every un-namespaced id in the corpus belongs to. `store.connect`
# migrates the hot store on startup, but the *cold* Parquet corpus is never
# rewritten, so every day compacted before namespacing still holds bare
# `TPE0001` ids -- and they are Taipei's for exactly the reason
# `store.migrate_to_namespaced_ids` assumes: it was the only city ever
# collected.
LEGACY_CITY = "taipei"


def city_of_stored(lot_id: str) -> str:
    """`city_of`, but total: an un-namespaced id is `LEGACY_CITY`, not an error.

    `city_of` is the strict form and stays strict -- an id arriving from a feed
    adapter or a metadata parser without a namespace is a bug, and raising is
    how it gets found. This is the form for ids read back out of the corpus,
    where a pre-namespacing Parquet file is not a bug but history, and where
    raising would take publishing down for every city at once: `run_forever`
    catches the exception, logs it and carries on collecting, so the failure is
    a site that silently stops updating while the collector looks healthy.

    Attributing those ids to Taipei rather than dropping them also keeps
    Taipei's published bytes where they are -- they already count toward its
    climatology today, and a bare id matches no namespaced `Lot.id`, so this
    changes which counts Taipei sees and nothing else.
    """
    city, sep, _ = lot_id.partition(SEPARATOR)
    return city if sep else LEGACY_CITY


def prefix_range(city: str) -> tuple[str, str]:
    """Half-open [lo, hi) bounds matching exactly `city`'s namespaced ids.

    `SEPARATOR` is ":" (0x3A) and the bound below is ";" (0x3B), the next code
    point, so the range is every id beginning `city:` and nothing else. Under
    SQLite's default BINARY collation this is a primary-key range on
    `observations(lot_id, data_ts)`: measured on a synthetic 180,000-row store,
    `SEARCH ... USING PRIMARY KEY` with no sort, where the equivalent
    `city = ?` predicate drops onto the non-covering `idx_obs_city_ts` and adds
    a `USE TEMP B-TREE FOR ORDER BY` -- the plan `liveness` and
    `forecast.load_history` both exist to keep the planner away from.
    """
    return f"{city}{SEPARATOR}", f"{city}{chr(ord(SEPARATOR) + 1)}"
