"""One collection tick: fetch, parse, validate, persist."""
import time
from dataclasses import dataclass

import requests

from parkcast import config, store
from parkcast.feed import parse_availability


@dataclass(frozen=True, slots=True)
class TickResult:
    data_ts: int
    rows_written: int
    advanced: bool


def fetch_json(url: str, *, timeout: int = config.HTTP_TIMEOUT_SEC) -> dict:
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    return response.json()


def collect_once(
    conn,
    capacities: dict[str, int | None],
    *,
    now: int | None = None,
    fetch=fetch_json,
) -> TickResult:
    """Fetch one tick and persist it.

    Fetch errors propagate: a failed tick must leave the store untouched rather
    than writing partial data. The caller decides whether to retry.
    """
    observed_at = int(time.time()) if now is None else now
    previous = store.latest_data_ts(conn)

    snapshot = parse_availability(fetch(config.AVAILABILITY_URL), observed_at)
    rows = store.insert_snapshot(conn, snapshot, capacities)

    return TickResult(
        data_ts=snapshot.data_ts,
        rows_written=rows,
        advanced=previous is None or snapshot.data_ts > previous,
    )
