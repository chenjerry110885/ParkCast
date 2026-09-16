"""One collection tick: fetch, parse, validate, persist."""
import time
from dataclasses import dataclass

import requests

from parkcast import config, store
from parkcast.sources import http, taipei
# Re-exported: existing callers and tests import FeedError from here. It is
# defined in sources.http, which collector.fetch_json now delegates to --
# that import direction is what keeps this module and sources.http from
# forming a cycle.
from parkcast.sources.http import FeedError  # noqa: F401


@dataclass(frozen=True, slots=True)
class TickResult:
    data_ts: int
    rows_written: int
    advanced: bool


def fetch_json(url: str, *, timeout: int = config.HTTP_TIMEOUT_SEC,
               max_bytes: int = config.MAX_FEED_BYTES) -> dict:
    """GET one feed blob as JSON, refusing redirects and oversized bodies.

    A thin delegation to `sources.http.get_json`, which holds the actual
    redirect-refusal, declared-length and streaming-cap logic -- keeping it
    in one place rather than two copies that could silently drift apart.
    `requests` stays imported here (unused directly) so
    `monkeypatch.setattr(collector.requests, "get", ...)` in existing tests
    still patches the same `requests` module `get_json` calls into.
    """
    return http.get_json(url, timeout=timeout, max_bytes=max_bytes)


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

    snapshot = taipei.parse(fetch(config.AVAILABILITY_URL), now=observed_at).snapshot
    rows = store.insert_snapshot(conn, snapshot, capacities)

    return TickResult(
        data_ts=snapshot.latest_data_ts,
        rows_written=rows,
        advanced=previous is None or snapshot.latest_data_ts > previous,
    )
