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


# The city every un-namespaced id in the corpus belongs to. The cold Parquet
# corpus is never rewritten, so every day compacted before namespacing still
# holds bare `TPE0001` ids -- and they are Taipei's for exactly the reason
# `store.migrate_to_namespaced_ids` assumes: it was the only city ever
# collected.
LEGACY_CITY = "taipei"


def as_stored(lot_id: str) -> str:
    """One id in the convention the store uses today: namespaced.

    Read a pre-namespacing Parquet file and you get `TPE0001` where the hot
    store, the metadata roster and every lookup in the codebase say
    `taipei:TPE0001`. Those are the same physical car park, and everything that
    joins the two sides -- `forecast.Counts`, the publish roster filter
    (`lot.id in history.counts.lot`), `evaluate`'s labels -- joins on the string.

    Leaving them unequal does not fail; it *splits*. Measured on a cold day of
    100 readings beside a hot day of 3 for one lot: `counts.lot` came back
    holding both `TPE0001` (100 observations) and `taipei:TPE0001` (3), and
    `Climatology.predict`, which is called with the namespaced `Lot.id`, saw
    only the 3. The lot and bucket tiers silently lose the entire
    pre-namespacing corpus -- the only long history this project has -- and
    every lot drifts toward the citywide rate. Nothing looks wrong, because the
    *global* tier still counts the cold rows, so the numbers stay plausible.

    So normalising has to happen where the corpus is READ, before any of those
    keys exist -- `forecast._read_parquet_day` and `evaluate.load_labels` --
    not merely where they are partitioned afterwards. An id that already carries
    a separator is returned untouched, so this is a no-op for every file written
    since namespacing.
    """
    return lot_id if SEPARATOR in lot_id else qualify(LEGACY_CITY, lot_id)


def city_of_stored(lot_id: str) -> str:
    """`city_of`, but total: an un-namespaced id is `LEGACY_CITY`, not an error.

    `city_of` is the strict form and stays strict -- an id arriving from a feed
    adapter or a metadata parser without a namespace is a bug, and raising is
    how it gets found. This is a BACKSTOP, for wherever a bare id might still
    reach a caller that only needs to know whose it is: raising there would take
    publishing down for every city at once, and `run_forever` catches the
    exception, logs it and carries on collecting -- so the failure is a site
    that silently stops updating while the collector looks perfectly healthy.

    It is not, and must not be treated as, the fix for a bare id in the corpus.
    Attributing such an id to Taipei without rewriting it leaves it a *separate
    key* from the namespaced form of the same lot, which splits that lot's
    history in half -- see `as_stored`, which is what actually resolves it, at
    the point the corpus is read.
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
