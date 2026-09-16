"""One collection tick: fetch, parse, validate, persist."""
import logging
import time
from dataclasses import dataclass

import requests

from parkcast import config, metadata, store
from parkcast.sources import http
# Re-exported: existing callers and tests import FeedError from here. It is
# defined in sources.http, which collector.fetch_json now delegates to --
# that import direction is what keeps this module and sources.http from
# forming a cycle.
from parkcast.sources.http import FeedError  # noqa: F401

log = logging.getLogger("parkcast.collector")


@dataclass(frozen=True, slots=True)
class TickResult:
    city: str
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
    source,
    capacities: dict[str, int | None],
    *,
    now: int | None = None,
) -> TickResult:
    """Fetch one source's tick and persist it.

    Fetch errors propagate: a failed tick must leave the store untouched rather
    than writing partial data. The caller decides whether to retry -- or, for
    `collect_all`, whether to isolate the failure to just this one city.

    `capacities` is the roster this source does *not* carry itself. Taipei
    publishes its lot list on a separate daily endpoint, so its capacities
    have to come from the caller (refreshed once a day -- see
    `scheduler.run_forever`'s `refresh_metadata`). The other five feeds answer
    their roster in the very same tick as their counts (`SourceTick.lots`), so
    for them the caller's `capacities` is ignored in favour of a map built
    fresh from this tick: capacities that can never be staler than the
    reading they bound, and no second request to get them.
    """
    observed_at = int(time.time()) if now is None else now
    previous = store.latest_data_ts(conn, source.city)

    tick = source.fetch(now=observed_at)
    if tick.lots is not None and not tick.lots and tick.snapshot.observations:
        # Every roster-carrying adapter appends the Observation before its own
        # coordinate/roster check, and the Lot only after -- so a payload
        # whose shape changed overnight (a renamed coordinate field, say) can
        # yield real observations with an empty roster alongside them, rather
        # than failing outright. Silently falling through to `{}` below would
        # flag every one of those observations NO_CAPACITY with nothing in
        # the log to explain why.
        log.warning(
            "%s reported %s observations but an empty roster (lots=()); every "
            "lot will be validated with no known capacity until the feed's "
            "roster reappears",
            source.city, len(tick.snapshot.observations),
        )
    tick_capacities = capacities if tick.lots is None else metadata.capacity_map(tick.lots)
    rows = store.insert_snapshot(conn, tick.snapshot, tick_capacities)

    return TickResult(
        city=source.city,
        data_ts=tick.snapshot.latest_data_ts,
        rows_written=rows,
        advanced=previous is None or tick.snapshot.latest_data_ts > previous,
    )


def collect_all(
    conn,
    sources,
    capacities: dict[str, int | None],
    *,
    now: int | None = None,
) -> list[TickResult]:
    """Collect every source, once each, isolating each one's failure.

    Taipei is the only corpus that cannot be re-fetched -- eleven days of
    readings with no way to backfill a gap. A stranger's feed misbehaving
    must be incapable of costing it a single tick, so each source's
    fetch-and-insert runs inside its own `try/except Exception`: not just
    network trouble, but a `KeyError` or a `TypeError` from a payload that
    changed shape overnight, too. Health is recorded either way -- a source
    the caller never hears from again is a source no one can tell has gone
    dark -- and this function itself never raises: one city's outage is a
    fact about that city, never a tick failure.

    All sources share one `observed_at`, computed once, so every row from
    this tick -- across every city -- carries the same fetch time rather than
    drifting by however long each source's own request took.
    """
    observed_at = int(time.time()) if now is None else now
    results: list[TickResult] = []
    for source in sources:
        # Every step below -- the fetch-and-insert, the follow-up health
        # query, and both `record_source_health` calls -- is inside this one
        # try/except, deliberately: a locked database or a disk error from
        # *any* of them must be contained exactly like a network failure, or
        # the isolation this function exists for is only conditional. Letting
        # a bookkeeping failure escape here would abort the loop early,
        # silently dropping every source not yet reached and discarding the
        # results already accumulated for the sources that came before it.
        try:
            result = collect_once(conn, source, capacities, now=observed_at)
        except Exception:
            log.exception(
                "collection failed for %s; other sources are unaffected", source.city
            )
            try:
                store.record_source_health(
                    conn, source.city, observed_at=observed_at,
                    rows=0, usable=0, newest_ts=None, ok=False,
                )
            except Exception:
                log.exception(
                    "recording failure health for %s also failed; continuing", source.city
                )
            continue

        try:
            # "Usable" is a fact about the reading, not about this write: a
            # tick whose data_ts repeats one already stored (rows_written ==
            # 0, the feed simply has not published yet) still has a roster
            # sitting in the store at that data_ts, and that is what
            # source_health should describe -- not that the source suddenly
            # produced nothing.
            rows, usable = conn.execute(
                "SELECT COUNT(*), SUM(CASE WHEN free_car IS NOT NULL THEN 1 ELSE 0 END) "
                "FROM observations WHERE city = ? AND data_ts = ?",
                (source.city, result.data_ts),
            ).fetchone()
            store.record_source_health(
                conn, source.city, observed_at=observed_at,
                rows=rows or 0, usable=usable or 0, newest_ts=result.data_ts, ok=True,
            )
        except Exception:
            # The tick itself already succeeded -- insert_snapshot committed
            # its own transaction inside collect_once -- so only the health
            # bookkeeping failed here. The data is real and must still be
            # reported to the caller as a genuine advance; losing `result`
            # over a health-recording hiccup would make run_forever think
            # this city stalled when it did not.
            log.exception(
                "recording health for %s failed after a successful collection; "
                "its rows are already committed and unaffected", source.city
            )
        results.append(result)
    return results
