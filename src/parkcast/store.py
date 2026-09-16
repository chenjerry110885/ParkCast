"""SQLite hot store: the rolling 48-hour window of observations."""
import sqlite3
from pathlib import Path

from parkcast import ids
from parkcast.feed import FeedSnapshot
from parkcast.quality import validate

_SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
    lot_id      TEXT    NOT NULL,
    data_ts     INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    free_car    INTEGER,
    free_motor  INTEGER,
    quality     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lot_id, data_ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_obs_data_ts ON observations(data_ts);

CREATE TABLE IF NOT EXISTS sources (
    city        TEXT    NOT NULL PRIMARY KEY,
    first_ts    INTEGER,
    last_ts     INTEGER,
    last_rows   INTEGER NOT NULL DEFAULT 0,
    last_usable INTEGER NOT NULL DEFAULT 0,
    last_ok     INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
"""


def connect(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    # FULL, not NORMAL: NORMAL leaves a committed tick in an unsynced WAL, and
    # tearing a container down loses those frames the same way a power cut
    # would. Observed live -- a tick logged 1177 rows at 20:51:34 and only 1129
    # survived a `docker compose up -d` 45 seconds later. One fsync per tick is
    # one fsync per five minutes; the corpus is worth more than that.
    conn.execute("PRAGMA synchronous=FULL")
    conn.executescript(_SCHEMA)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(observations)")}
    if "city" not in columns:
        # Existing rows are Taipei's -- it is the only city ever collected --
        # and the migration below rewrites both this and the id.
        conn.execute("ALTER TABLE observations ADD COLUMN city TEXT NOT NULL DEFAULT ''")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_obs_city_ts ON observations(city, data_ts)")
    return conn


def insert_snapshot(
    conn: sqlite3.Connection,
    snapshot: FeedSnapshot,
    capacities: dict[str, int | None],
) -> int:
    """Insert a tick. Returns rows actually written.

    DO NOTHING on conflict: a given (lot_id, data_ts) describes one moment, so
    the first sighting is the truthful observed_at. Re-fetching must not rewrite it.

    The whole tick is one explicit transaction, so it is all-or-nothing. Under
    autocommit, executemany commits every row separately and a crash mid-batch
    leaves a truncated tick that looks complete to every later reader; the
    in-slot retry cannot heal it, because by then the feed has advanced.
    """
    rows = []
    for obs in snapshot.observations:
        capacity = capacities.get(obs.lot_id)
        free_car, flags = validate(obs.free_car, capacity)
        free_motor, _ = validate(obs.free_motor, None)
        rows.append(
            (obs.lot_id, snapshot.city, obs.data_ts, snapshot.observed_at,
             free_car, free_motor, int(flags))
        )

    # BEGIN IMMEDIATE, not a deferred BEGIN: take the write lock up front rather
    # than discovering it is held after the batch has already been built.
    conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.executemany(
            """
            INSERT INTO observations
                (lot_id, city, data_ts, observed_at, free_car, free_motor, quality)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(lot_id, data_ts) DO NOTHING
            """,
            rows,
        )
        written = cursor.rowcount
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
    return written


def migrate_to_namespaced_ids(conn: sqlite3.Connection, city: str = "taipei") -> int:
    """Prefix every un-namespaced row's id, once. Returns rows rewritten.

    Called from `__main__.main` at startup, immediately after `connect` and
    before anything reads the store. It has to run there and not lazily: the
    first tick after a deploy writes namespaced ids, so until this has run the
    hot window holds both conventions for the same physical car park -- and
    `forecast.load_history` keys `current` and `counts` on the string, so that
    lot's history is split in half. In the hot store that is the half feeding
    `Persistence` and `store.free_at`: the short-horizon signal and the observed
    count on every card, degraded for as long as the split lasts, and plausible
    the whole time. See `ids.as_stored` for the same failure in the cold half,
    which Parquet keeps forever and which is resolved on read instead.

    One transaction: a half-migrated store has two id conventions in one table
    and every later query silently reads half the corpus. Idempotent, because
    the collector may restart mid-day and this runs on every boot -- the second
    and every later run rewrite 0 rows.

    WHICH ROWS ARE UN-NAMESPACED is decided by `city = ''`, the column's
    ALTER-TABLE default, i.e. "this row predates the city column" -- which is
    exactly "this row predates namespacing", because `connect` added the column
    in the same change that introduced `ids.qualify`. It is a recorded fact
    rather than a guess from the id's shape, and that matters now the store
    holds six cities: the original predicate was `lot_id NOT LIKE 'taipei:%'`,
    written when Taipei was the only source, and against today's store it
    rewrites every Kaohsiung, Tainan, Taoyuan, New Taipei and Hsinchu row to
    `taipei:kaohsiung:PL0001` and stamps `city = 'taipei'` on all of them.
    In place, in one transaction, on the first boot after deploying. Five
    cities' hot windows, unrecoverable.

    Reading the column also keeps the property the prefix check was chosen for:
    a feed id that itself contains a colon (`ids.bare`'s hypothetical
    `PL:0001`) is migrated like any other row rather than looking
    already-namespaced, which `instr(lot_id, ':') = 0` would have got wrong.

    The `NOT LIKE` clause stays as a second, narrower guard. It cannot be what
    identifies a legacy row, but it makes double-prefixing unrepresentable
    rather than merely unreachable, and a doubled prefix is not recoverable
    either. `LIKE` treats `_` and `%` as wildcards, so it is only safe because
    city names are plain lowercase ASCII containing neither; a future city name
    with an underscore would need escaping here.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        prefix = f"{city}{ids.SEPARATOR}"
        cursor = conn.execute(
            "UPDATE observations SET lot_id = ? || lot_id, city = ? "
            "WHERE city = '' AND lot_id NOT LIKE ? || '%'",
            (prefix, city, prefix),
        )
        rewritten = cursor.rowcount
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
    return rewritten


def record_source_health(
    conn: sqlite3.Connection,
    city: str,
    *,
    observed_at: int,
    rows: int,
    usable: int,
    newest_ts: int | None,
    ok: bool,
) -> None:
    """Upsert one city's latest fetch outcome.

    `first_ts = COALESCE(first_ts, excluded.first_ts)`: the first sighting of
    a source is never overwritten by later runs, so `source_health` can report
    how long a city has been collected.
    """
    conn.execute(
        """
        INSERT INTO sources (city, first_ts, last_ts, last_rows, last_usable, last_ok)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(city) DO UPDATE SET
            first_ts = COALESCE(sources.first_ts, excluded.first_ts),
            last_ts = excluded.last_ts,
            last_rows = excluded.last_rows,
            last_usable = excluded.last_usable,
            last_ok = excluded.last_ok
        """,
        (city, newest_ts, observed_at, rows, usable, int(ok)),
    )


def source_health(conn: sqlite3.Connection) -> dict[str, dict]:
    rows = conn.execute(
        "SELECT city, first_ts, last_ts, last_rows, last_usable, last_ok FROM sources"
    )
    return {
        city: {
            "first_ts": first_ts,
            "last_ts": last_ts,
            "rows": rows_,
            "usable": usable,
            "ok": bool(ok),
        }
        for city, first_ts, last_ts, rows_, usable, ok in rows
    }


def latest_data_ts(conn: sqlite3.Connection, city: str | None = None) -> int | None:
    if city is None:
        return conn.execute("SELECT MAX(data_ts) FROM observations").fetchone()[0]
    return conn.execute(
        "SELECT MAX(data_ts) FROM observations WHERE city = ?", (city,)
    ).fetchone()[0]


def oldest_data_ts(conn: sqlite3.Connection, city: str | None = None) -> int | None:
    if city is None:
        return conn.execute("SELECT MIN(data_ts) FROM observations").fetchone()[0]
    return conn.execute(
        "SELECT MIN(data_ts) FROM observations WHERE city = ?", (city,)
    ).fetchone()[0]


def prune(conn: sqlite3.Connection, cutoff_ts: int) -> int:
    cursor = conn.execute("DELETE FROM observations WHERE data_ts < ?", (cutoff_ts,))
    return cursor.rowcount


def count_rows(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]


def free_at(
    conn: sqlite3.Connection, data_ts: int, city: str | None = None
) -> dict[str, int | None]:
    """Each lot's validated free_car at one tick, keyed by lot id.

    Only lots observed at exactly `data_ts` appear. A NULL free_car -- the
    feed's -9 sentinel, or a reading `validate` refused -- maps to None rather
    than being dropped: "seen, reported nothing" and "not seen" are different
    facts, and the card shows them differently.

    `city` narrows the tick to one source. Each city is published from its own
    `data_ts` now (see `forecast.by_city`), and two cities can land on the same
    second -- Kaohsiung and Taoyuan stamp `data_ts = now`, so it is a matter of
    when the fetch returned. Nothing would be *misattributed* (lot ids are
    namespaced, and the caller looks up its own), but the query would drag
    another city's rows through for every shard. `(city, data_ts)` is exactly
    `idx_obs_city_ts`.
    """
    if city is None:
        rows = conn.execute(
            "SELECT lot_id, free_car FROM observations WHERE data_ts = ?", (data_ts,)
        )
    else:
        rows = conn.execute(
            "SELECT lot_id, free_car FROM observations WHERE city = ? AND data_ts = ?",
            (city, data_ts),
        )
    return {lot_id: free for lot_id, free in rows}
