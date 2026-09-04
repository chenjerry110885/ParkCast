"""Phase-aligned polling loop.

Minute-of-hour is identical in UTC and UTC+8 because the offset is a whole
number of hours, so slot arithmetic needs no timezone conversion. The
calendar *day*, however, is not - Taipei is UTC+8, so 16:00 UTC is already
the next day in Taipei, and both the day-rollover refresh and the daily
compaction must use that local date.
"""
import logging
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from pathlib import Path

from parkcast import artifacts, config, store
from parkcast.collector import collect_once
from parkcast.compact import compact_day
from parkcast.forecast import Blend, load_history
from parkcast.grid import build_grid
from parkcast.report import build_report, format_report

log = logging.getLogger("parkcast.scheduler")


def taipei_date(ts: int) -> date:
    """The calendar date in Taipei for an epoch timestamp."""
    return datetime.fromtimestamp(ts, config.TAIPEI_TZ).date()


def next_poll_ts(now: int) -> int:
    """The next instant with minute = POLL_MINUTE_MOD (mod 5) at POLL_SECOND."""
    period = config.POLL_PERIOD_MIN * 60
    # Offset, in seconds past the hour, of the first slot in each 5-minute cycle.
    offset = config.POLL_MINUTE_MOD * 60 + config.POLL_SECOND
    elapsed = now - offset
    slots_done = elapsed // period
    return offset + (slots_done + 1) * period


def archive_day(conn, day: date, out_dir: Path = config.PARQUET_DIR) -> None:
    """Roll one completed Taipei day into the cold store and log its report.

    Refuses to rewrite a day that already has a Parquet file. Compaction can
    only ever see what is still inside the 48-hour hot window, so re-running it
    for an older day would replace a complete file with a half-pruned one.
    """
    target = out_dir / f"{day.isoformat()}.parquet"
    if target.exists():
        log.info("%s is already compacted; leaving %s untouched", day, target)
        return

    path = compact_day(conn, day, out_dir)
    if path is None:
        log.warning("no rows to compact for %s", day)
    else:
        log.info("compacted %s to %s (%s bytes)", day, path, path.stat().st_size)
    log.info("%s", format_report(build_report(conn, day)))


def _first_day_to_archive(conn, today: date) -> date:
    """The earliest Taipei day still in the hot store, or today if it is empty.

    Without this, a restart landing between midnight and the first rollover
    would never compact the day that just ended, and prune would take it 48
    hours later. archive_day skips days that already have a file, so catching
    up costs one `exists()` per day.
    """
    try:
        oldest = store.oldest_data_ts(conn)
    except Exception:
        log.exception("could not read the hot store; assuming nothing to catch up")
        return today
    return today if oldest is None else min(taipei_date(oldest), today)


def publish_artifacts(conn, lots, out_dir: Path = config.ARTIFACT_DIR) -> None:
    """Rebuild and republish grid.bin and lots.json from current history.

    Lots are ordered by id and filtered to those with at least one usable
    observation, so grid rows and lots.json indices line up exactly.

    Refuses to publish a set that is empty, or that has collapsed to less than
    MIN_PUBLISH_LOT_FRACTION of what is already published: stale artifacts beat
    artifacts that have lost most of the city.
    """
    history = load_history(conn, cold_dir=config.PARQUET_DIR)
    forecaster = Blend(history)
    ordered = sorted(
        (lot for lot in lots if lot.id in history.by_lot), key=lambda lot: lot.id
    )
    if not ordered:
        # Reachable with a perfectly good `lots` argument too: an empty
        # `history` (e.g. right after a metadata-blob outage left `_lots`
        # empty at startup, or a fresh store with no observations yet) makes
        # every lot fail the `history.by_lot` filter. Writing a header-only
        # grid.bin and an empty lots.json would blank the whole site to zero
        # parking lots until the next day-rollover refresh. Stale artifacts
        # beat empty ones, so leave whatever is already published alone.
        log.warning(
            "no lots survived the history filter (%s candidate lots, %s with "
            "history); leaving existing artifacts untouched",
            len(lots), len(history.by_lot),
        )
        return

    published = artifacts.read_header(Path(out_dir) / "grid.bin")
    if published is not None:
        floor = published["n_lots"] * config.MIN_PUBLISH_LOT_FRACTION
        if len(ordered) < floor:
            # Emptiness is only the extreme of this failure. A store restored
            # from a partial backup, or one still filling after a rebuild, can
            # yield a plausible-looking handful of lots; publishing it would take
            # most of the city's parking off the map until it recovers.
            log.error(
                "refusing to publish %s lots over an existing %s-lot grid "
                "(floor is %.0f, %.0f%% of published); leaving artifacts untouched",
                len(ordered), published["n_lots"], floor,
                config.MIN_PUBLISH_LOT_FRACTION * 100,
            )
            return

    grid = build_grid(forecaster, [lot.id for lot in ordered], history.latest_ts)
    # One set of identity values for both files: the row order is recomputed
    # every tick, so a client pairing this grid with an older lots.json must be
    # able to tell. Computed once here rather than twice, so they cannot drift.
    generated_at = int(time.time())
    identity = {
        "generated_at": generated_at,
        "base_data_ts": history.latest_ts,
        "n_lots": len(ordered),
    }
    artifacts.publish(
        out_dir,
        grid_blob=artifacts.encode_grid(grid, **identity),
        lots_blob=artifacts.build_lots_json(ordered, **identity),
    )
    log.info("published %s lots x %s horizons", len(ordered), config.HORIZON_COUNT)


def run_forever(
    conn,
    capacities: dict[str, int | None],
    *,
    collect=collect_once,
    sleep=time.sleep,
    now_fn=lambda: int(time.time()),
    refresh_metadata: Callable[[date], dict[str, int | None]] | None = None,
    archive: Callable[..., None] = archive_day,
    publish: Callable[..., None] | None = None,
) -> None:
    today = taipei_date(now_fn())
    current_day = today
    archived_day = _first_day_to_archive(conn, today)
    exhausted_slots = 0

    while True:
        target = next_poll_ts(now_fn())
        sleep(max(0, target - now_fn()))

        for delay in (0, *config.RETRY_DELAYS_SEC):
            if delay:
                sleep(delay)
            try:
                result = collect(conn, capacities)
            except Exception:
                log.exception("tick failed; will retry within this slot")
                continue
            if result.advanced:
                log.info("tick data_ts=%s rows=%s", result.data_ts, result.rows_written)
                exhausted_slots = 0
                if publish is not None:
                    try:
                        publish(conn)
                    except Exception:
                        # Publishing is downstream of collection: a tick missed is
                        # data that can never be re-fetched, while a stale artifact
                        # is fixed by the very next tick. It must never be able to
                        # take collection down with it.
                        log.exception("publishing artifacts failed; will retry next tick")
                break
            log.warning("feed has not advanced (data_ts=%s); retrying", result.data_ts)
        else:
            exhausted_slots += 1
            log.error(
                "slot exhausted without a fresh tick (%s consecutive)", exhausted_slots
            )
            if exhausted_slots >= config.MAX_EXHAUSTED_SLOTS:
                # Looping forever on a feed that changed shape logs an error
                # every five minutes while collecting nothing, and the process
                # never exits, so `restart: unless-stopped` never fires and the
                # container keeps reporting itself healthy. Exiting non-zero
                # turns a silent stall into a rising restart count.
                raise SystemExit(
                    f"no fresh tick for {exhausted_slots} consecutive slots "
                    f"({exhausted_slots * config.POLL_PERIOD_MIN} min); exiting so "
                    "the restart policy fires"
                )

        day = taipei_date(now_fn())

        # Compact completed days before prune can touch them. Retention is 48h
        # against a 24h day, so a day that has just ended is still whole here -
        # but only for another 24 hours, and prune is what takes it away.
        # A failure must not skip the day permanently, so the watermark only
        # advances once the day is actually archived. The bound is computed
        # once, so no bug in here can turn into an infinite loop that silently
        # stops collection.
        for _ in range((day - archived_day).days):
            try:
                archive(conn, archived_day)
            except Exception:
                log.exception(
                    "compaction failed for %s; retrying on the next slot", archived_day
                )
                break
            archived_day += timedelta(days=1)

        removed = store.prune(conn, now_fn() - config.HOT_RETENTION_SEC)
        if removed:
            log.info("pruned %s rows beyond the hot window", removed)

        if refresh_metadata is not None and day != current_day:
            try:
                capacities = refresh_metadata(day)
                current_day = day
                log.info("metadata refreshed for %s (%s lots)", day, len(capacities))
            except Exception:
                # Stale capacities beat no capacities; try again next slot.
                log.exception("metadata refresh failed; keeping previous capacities")
