"""One collection tick: fetch, parse, validate, persist."""
import json
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


class FeedError(RuntimeError):
    """The feed answered with something we refuse to read."""


def fetch_json(url: str, *, timeout: int = config.HTTP_TIMEOUT_SEC,
               max_bytes: int = config.MAX_FEED_BYTES) -> dict:
    """GET one feed blob as JSON, refusing redirects and oversized bodies.

    Both feed URLs answer 200 directly (checked 2026-09-14), so a redirect is
    never legitimate: following one would let a hijacked endpoint send this
    container's requests anywhere, including the local network. The size cap
    bounds memory against a body that never ends.
    """
    with requests.get(url, timeout=timeout, allow_redirects=False, stream=True) as response:
        if response.is_redirect or 300 <= response.status_code < 400:
            raise FeedError(f"refusing a redirect from the feed (HTTP {response.status_code})")
        response.raise_for_status()
        declared = response.headers.get("Content-Length")
        if declared is not None and declared.isdigit() and int(declared) > max_bytes:
            raise FeedError(f"feed body of {declared} bytes exceeds {max_bytes}")
        body = bytearray()
        for chunk in response.iter_content(chunk_size=64 * 1024):
            body += chunk
            if len(body) > max_bytes:
                raise FeedError(f"feed body exceeds {max_bytes} bytes")
    return json.loads(bytes(body))


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
        data_ts=snapshot.latest_data_ts,
        rows_written=rows,
        advanced=previous is None or snapshot.latest_data_ts > previous,
    )
