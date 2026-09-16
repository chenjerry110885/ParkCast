"""One collection tick: fetch, parse, validate, persist."""
import logging
import time
from dataclasses import dataclass, replace

import requests

from parkcast import config, metadata, quality, store
from parkcast.feed import FeedSnapshot, Observation
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
    # The roster this tick carried, straight from `SourceTick.lots`: the five
    # feeds that answer their own lot list do so in the same request as their
    # counts, and this is how it reaches publishing. `None` for Taipei, whose
    # roster comes from its separate daily metadata endpoint instead.
    #
    # It was previously consumed for capacities inside `collect_once` and then
    # dropped on the floor, which is why -- verified by running `main()` with a
    # stubbed `run_forever` -- six registered sources produced exactly one
    # published city. `publish_city`, `cities.json` and every `grid-{city}.bin`
    # were unreachable in production; only tests that called
    # `publish_artifacts` directly ever saw them.
    lots: tuple[metadata.Lot, ...] | None = None
    # Observations this tick whose `data_ts` could not be true and were
    # therefore not stored. Counted rather than merely logged so the number is
    # available to a caller; see `bound_data_ts`.
    rejected_ts: int = 0


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


def bound_data_ts(
    snapshot: FeedSnapshot,
) -> tuple[FeedSnapshot, tuple[Observation, ...]]:
    """Split one snapshot into the observations we can date and the ones we cannot.

    WHERE THIS LIVES, AND WHY NOT IN `store.insert_snapshot`. That is the one
    chokepoint every stored row passes, and it is the obvious home -- but the
    value that does the damage is `FeedSnapshot.latest_data_ts`, not the row.
    Filtering rows down there would leave the caller's snapshot still reporting
    the poisoned maximum, so `collect_once` would still call the tick advanced
    on a data_ts the store does not hold, `TickResult.data_ts` would still
    carry it, and `collect_all`'s health query would count rows at a `data_ts`
    with none. One filtered snapshot here fixes all of those at once.

    Nor in the adapters, which is where the stamps are parsed: six copies of
    one rule, and a seventh city could simply forget it. This is the last point
    at which a row is still an `Observation` -- i.e. the last point at which
    `ts_kind` still exists -- and `collect_once` is the only production path
    into `insert_snapshot`, so in practice it is a chokepoint too.
    `insert_snapshot` stays a faithful primitive that stores what it is handed,
    which is what lets the fixture-driven publish tests seed historic days
    directly.

    REJECTED, NOT REBASED. `feed.TS_FETCH` is available and would keep the row
    -- but rebasing a reading stamped 2.3 years ago to "now" does not record
    that we are unsure when it was taken; it asserts it was taken now. That
    count would then be published as the lot's current observed count, and fed
    to climatology in the wrong time-of-week bucket. Dropping the row leaves
    the lot with no reading for this tick, which `liveness` already handles
    honestly -- no forecast, "not updating" -- and which is a fact rather than
    a fabrication. The rows are lost either way: under the old behaviour an
    old-direction stamp inserted and pruned inside the same slot, silently.
    What changes is that the loss is now counted and said out loud.
    """
    kept: list[Observation] = []
    rejected: list[Observation] = []
    for obs in snapshot.observations:
        target = kept if quality.data_ts_plausible(obs.data_ts, snapshot.observed_at) else rejected
        target.append(obs)
    if not rejected:
        # The overwhelmingly common path: hand back the very same object, so a
        # healthy tick costs one comparison per observation and no allocation.
        return snapshot, ()
    return replace(snapshot, observations=tuple(kept)), tuple(rejected)


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

    That same roster is handed back on `TickResult.lots` rather than being
    consumed here and discarded, because publishing needs it too: it is the
    only place `lots-{city}.json`, `grid-{city}.bin` and `cities.json` can get
    their rosters from. See `TickResult.lots`.
    """
    observed_at = int(time.time()) if now is None else now
    previous = store.latest_data_ts(conn, source.city)

    tick = source.fetch(now=observed_at)
    # Before anything reads `latest_data_ts` off it, and before a single row
    # reaches the store. See `bound_data_ts`.
    snapshot, rejected = bound_data_ts(tick.snapshot)
    if rejected:
        worst = max(rejected, key=lambda obs: abs(obs.data_ts - observed_at))
        log.warning(
            "%s: %s of %s observation(s) carry a data_ts outside the "
            "plausibility window (-%s h to +%s min around the fetch time) and "
            "were not stored; the worst is %+d s from the fetch (lot %s). A "
            "count that cannot be placed in time cannot be stored without "
            "inventing the one fact the corpus is keyed on",
            source.city, len(rejected), len(tick.snapshot.observations),
            config.DATA_TS_MAX_AGE_SEC // 3600, config.DATA_TS_MAX_AHEAD_SEC // 60,
            worst.data_ts - observed_at, worst.lot_id,
        )
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
    rows = store.insert_snapshot(conn, snapshot, tick_capacities)

    return TickResult(
        city=source.city,
        data_ts=snapshot.latest_data_ts,
        rows_written=rows,
        advanced=previous is None or snapshot.latest_data_ts > previous,
        lots=tick.lots,
        rejected_ts=len(rejected),
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
