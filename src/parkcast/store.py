"""SQLite hot store: the rolling 48-hour window of observations."""
import sqlite3
from pathlib import Path

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
"""


def connect(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
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
            (obs.lot_id, snapshot.data_ts, snapshot.observed_at,
             free_car, free_motor, int(flags))
        )

    # BEGIN IMMEDIATE, not a deferred BEGIN: take the write lock up front rather
    # than discovering it is held after the batch has already been built.
    conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.executemany(
            """
            INSERT INTO observations
                (lot_id, data_ts, observed_at, free_car, free_motor, quality)
            VALUES (?, ?, ?, ?, ?, ?)
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


def latest_data_ts(conn: sqlite3.Connection) -> int | None:
    return conn.execute("SELECT MAX(data_ts) FROM observations").fetchone()[0]


def prune(conn: sqlite3.Connection, cutoff_ts: int) -> int:
    cursor = conn.execute("DELETE FROM observations WHERE data_ts < ?", (cutoff_ts,))
    return cursor.rowcount


def count_rows(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
