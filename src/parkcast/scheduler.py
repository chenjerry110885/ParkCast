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

from parkcast import artifacts, config, ids, liveness, store
from parkcast.collector import TickResult, collect_all
from parkcast.compact import compact_day, day_bounds
from parkcast.forecast import Blend, by_city, empty_history, load_history
from parkcast.grid import build_grid
from parkcast.report import build_report, format_report
from parkcast.sources import SOURCES

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


def publish_city(
    conn,
    city: str,
    lots,
    out_dir: Path = config.ARTIFACT_DIR,
    *,
    history,
    generated_at: int,
    uploader=None,
) -> dict | None:
    """Rebuild and republish one city's shard. Returns its cities.json entry.

    Lots are ordered by id and filtered to those that take cars at all and have
    at least one usable observation, so grid rows and lots.json indices line up
    exactly.

    Refuses to publish a set that is empty, one that has collapsed to less than
    MIN_PUBLISH_LOT_FRACTION of what is already published, or one with no
    reading behind it to forecast from: stale artifacts beat artifacts that have
    lost most of the city, and beat artifacts dated 1970. Every one of those
    judgements is made against THIS city's own published shard and THIS city's
    own history -- a collapse in Tainan is not evidence about Taipei, and
    measuring Tainan's roster against Taipei's published `n_lots` would refuse
    every small city forever.

    Every refusal returns None rather than raising. Publishing sits downstream
    of collection and must never be able to stop it -- and, one level down, one
    city must never be able to stop another.

    `history` is this city's own, from `forecast.by_city`: its own `latest_ts`,
    its own `current`. See that function for what reading the store unscoped
    silently did to Taipei.

    `generated_at` is passed in rather than read here, so every shard in a tick
    carries the same stamp and cities.json agrees with all of them.

    `uploader`, when given, receives the exact published bytes and never blocks
    (see `upload.Uploader`).
    """
    # `counts.lot`, not `recent`: the filter asks "has this lot ever produced a
    # usable observation", which is a question about the whole corpus. `recent`
    # is a two-hour tail, so filtering on it would drop any lot whose history
    # lives only in the cold store -- lots that still get an honest
    # climatology-only forecast and belong on the map.
    #
    # `serves_cars` is a *publishing* rule and lives only here. A lot with no car
    # spaces is still parsed, still collected and still stored: pushing this
    # upstream into `validate` would clamp its free_car to 0 from that moment on
    # and manufacture a discontinuity inside the corpus Plan 4 trains on, which
    # is a far worse outcome than the display bug it fixes.
    ordered = sorted(
        (lot for lot in lots if lot.serves_cars and lot.id in history.counts.lot),
        key=lambda lot: lot.id,
    )
    if not ordered:
        # Reachable with a perfectly good `lots` argument too: an empty
        # `history` (e.g. right after a metadata-blob outage left `_lots`
        # empty at startup, a fresh store with no observations yet, or a city
        # whose feed has been down long enough to be pruned out of the hot
        # store) makes every lot fail the history filter. Writing a
        # header-only grid.bin and an empty lots.json would blank this city to
        # zero parking lots until the next day-rollover refresh. Stale
        # artifacts beat empty ones, so leave whatever is already published
        # alone.
        log.warning(
            "%s: no lots survived the history filter (%s candidate lots, %s with "
            "history); leaving its existing artifacts untouched",
            city, len(lots), len(history.counts.lot),
        )
        return None

    if history.latest_ts == 0:
        # A full roster with nothing to forecast from. `ordered` is filtered on
        # `counts.lot`, which spans the cold corpus, but `latest_ts` comes off
        # `recent`, which is hot-only on this path -- so a hot window in which
        # every free_car is NULL (a citywide -9 from the feed, or a fresh hot
        # store restored beside an intact cold one) passes both guards above
        # while leaving the base timestamp at 0. `build_grid` would then evaluate
        # every horizon against Thursday 1970-01-01 Taipei -- a real climatology
        # bucket, so the bytes look plausible -- and stamp `base_data_ts: 0` on
        # the result, telling every client the reading is 56 years stale.
        #
        # Per city, and it has to be: a global `latest_ts` is non-zero the
        # moment ANY city has a reading, so a citywide -9 in Taipei would sail
        # through this guard on the strength of Kaohsiung's clock and publish
        # Taipei's roster stamped with a timestamp no Taipei lot was read at.
        log.error(
            "%s: no usable reading behind %s lots (latest_ts is 0: its hot window "
            "is entirely NULL); leaving its existing artifacts untouched",
            city, len(ordered),
        )
        return None

    published = artifacts.read_header(Path(out_dir) / artifacts.grid_name(city))
    if published is not None:
        floor = published["n_lots"] * config.MIN_PUBLISH_LOT_FRACTION
        if len(ordered) < floor:
            # Emptiness is only the extreme of this failure. A store restored
            # from a partial backup, or one still filling after a rebuild, can
            # yield a plausible-looking handful of lots; publishing it would take
            # most of the city's parking off the map until it recovers.
            log.error(
                "%s: refusing to publish %s lots over an existing %s-lot grid "
                "(floor is %.0f, %.0f%% of published); leaving its artifacts untouched",
                city, len(ordered), published["n_lots"], floor,
                config.MIN_PUBLISH_LOT_FRACTION * 100,
            )
            return None

    # One ordered roster drives the grid's rows, the header's roster and
    # lots.json alike, so the three cannot describe different sets of lots. It
    # has two spellings, both derived from that one list and never assembled
    # separately: the stored namespaced id, which is what the store, `liveness`
    # and the forecaster are keyed by, and the bare published id, which is what
    # goes into the artifacts and into the roster hash (see `artifacts.roster_id`).
    lot_ids = [lot.id for lot in ordered]
    published_ids = [ids.bare(lot.id) for lot in ordered]
    # A lot whose feed has stopped updating keeps its row, with no forecast in
    # it: a frozen reading published as 0% or 100% was the app telling drivers
    # something the data could not support. Publishing-only -- see `liveness`.
    withheld = liveness.not_updating(conn, lot_ids, as_of=history.latest_ts, city=city)
    forecaster = liveness.Withholding(Blend(history), withheld)
    grid = build_grid(forecaster, lot_ids, history.latest_ts)
    # One set of generation values for both files: the row order is recomputed
    # every tick, so a client pairing this grid with an older lots.json must be
    # able to tell. `n_lots` and `roster_id` are derived inside each encoder
    # from the rows it is actually writing, so no stamp can outlive its rows.
    identity = {
        "generated_at": generated_at,
        "base_data_ts": history.latest_ts,
    }
    grid_blob = artifacts.encode_grid(grid, lot_ids=published_ids, **identity)
    # The observed count behind each forecast row, from the same reading the
    # grid was built from -- this city's reading. `store.free_at` is one indexed
    # query on (city, data_ts).
    free = store.free_at(conn, history.latest_ts, city)
    lots_blob = artifacts.build_lots_json(ordered, not_updating=withheld, free=free, **identity)
    artifacts.publish(out_dir, city, grid_blob=grid_blob, lots_blob=lots_blob)
    log.info(
        "published %s: %s lots x %s horizons, %s not updating",
        city, len(ordered), config.HORIZON_COUNT, len(withheld),
    )
    if uploader is not None:
        # The same bytes just written locally, handed to a thread that never
        # blocks this loop. Uploading is downstream of publishing, which is
        # downstream of collection.
        uploader.offer(grid_blob, lots_blob, base_data_ts=history.latest_ts,
                       roster_id=artifacts.roster_id(published_ids))
    return artifacts.city_entry(city, ordered, base_data_ts=history.latest_ts)


def publish_artifacts(conn, lots, out_dir: Path = config.ARTIFACT_DIR, uploader=None) -> None:
    """Republish every city's shard from current history, then the index.

    One `load_history` for the tick, split per city by `forecast.by_city`, then
    one `publish_city` per city present in `lots`. The split is the load-bearing
    part: read unscoped, `latest_ts` is a single maximum across every lot in the
    store, and the cities that stamp `data_ts = now` always hold it -- so every
    Taipei lot falls out of `current`, `Persistence` goes silent for all of
    them, and `Blend` quietly becomes climatology-only. See `forecast.by_city`.

    A city that refuses contributes nothing and stops nothing: the loop carries
    on, and its entry in cities.json is left as it was, matching the shard still
    sitting on disk. An entry is only ever replaced by a successful publish, so
    the index can never claim a city that has no shard, nor drop one that has.
    """
    history = load_history(conn, cold_dir=config.PARQUET_DIR)
    histories = by_city(history)

    # Grouped with the total `city_of_stored`, not the strict `city_of`. A
    # `Lot.id` without a namespace is a bug in whichever metadata parser
    # produced it, but raising here would take *every* city's publish down with
    # it -- for a tick, and for every tick after -- while the collector went on
    # looking healthy. That is the exact failure this loop's per-city refusals
    # exist to prevent. Filed under Taipei it simply fails the history filter
    # below (the store's ids are namespaced), so the broken city goes quiet and
    # says so in the log, and the other five publish.
    lots_by_city: dict[str, list] = {}
    for lot in lots:
        lots_by_city.setdefault(ids.city_of_stored(lot.id), []).append(lot)

    # One stamp for every shard and for the index, read once. Six shards each
    # calling `time.time()` would disagree by a second or two, and a client
    # comparing cities would see a difference that means nothing.
    generated_at = int(time.time())

    # Start from what is already indexed, so a city that refuses this tick --
    # or one missing from `lots` entirely, e.g. its metadata fetch failed --
    # keeps the entry describing the shard it still has on disk.
    entries = artifacts.read_cities(Path(out_dir) / artifacts.CITIES_NAME)
    for city in sorted(lots_by_city):
        try:
            entry = publish_city(
                conn, city, lots_by_city[city], out_dir,
                history=histories.get(city, empty_history()),
                generated_at=generated_at,
                # One pair, one endpoint: `upload.UPLOAD_PATH` is a single
                # `/artifacts/latest`, and the deployed site serves Taipei.
                # Offering six pairs to it would have five overwrite each other
                # and burn the daily cap doing it. Uploading the other shards
                # waits for the Worker to have somewhere to put them.
                uploader=uploader if city == artifacts.UNSUFFIXED_CITY else None,
            )
        except Exception:
            # `publish_city`'s guards are the expected ways a city declines, and
            # they return. This is the net for the unexpected one -- a malformed
            # id, a feed that produced something nothing anticipated. `run_forever`
            # already nets the whole publish so a failure here cannot cost a tick
            # of collection; this is the same reasoning one level finer, so a
            # failure in Tainan cannot cost Taipei its publish either. The city's
            # existing shard and its index entry both stay as they are.
            log.exception("%s: publishing failed; leaving its artifacts untouched", city)
            entry = None
        if entry is not None:
            entries[city] = entry

    if not entries:
        # Nothing published and nothing already indexed: the first tick of a
        # store with no usable history. An index listing no cities would tell a
        # client the service has no coverage anywhere, which is worse than no
        # index at all -- one is a fact, the other is a missing file it already
        # has to handle.
        log.warning("no city published and no existing index to keep; leaving %s unwritten",
                    artifacts.CITIES_NAME)
        return
    # `generated_at` here describes the index, not the readings: a carried-over
    # entry keeps its own `base_data_ts`, which is the freshness a client reads.
    artifacts.publish_cities(
        out_dir, artifacts.build_cities_json(entries.values(), generated_at=generated_at)
    )


def run_forever(
    conn,
    capacities: dict[str, int | None],
    *,
    sources=None,
    collect=collect_all,
    sleep=time.sleep,
    now_fn=lambda: int(time.time()),
    refresh_metadata: Callable[[date], dict[str, int | None]] | None = None,
    archive: Callable[..., None] = archive_day,
    publish: Callable[..., None] | None = None,
) -> None:
    # A live view of the registry, not a one-shot snapshot: every one of the
    # up-to-four attempts in a slot, across every slot for the life of the
    # process, iterates it again. `SOURCES.values()` is reusable exactly that
    # way; a generator would not be.
    if sources is None:
        sources = SOURCES.values()
    # Keyed once, up front: every attempt below narrows the retry set by city
    # name, and stall bookkeeping is per city too, so both need a stable
    # city -> Source lookup rather than re-deriving one from a shrinking set
    # each time. Iterated in this (insertion) order wherever a stable request
    # order matters, e.g. building the retry list below.
    sources_by_city = {s.city: s for s in sources}

    today = taipei_date(now_fn())
    current_day = today
    archived_day = _first_day_to_archive(conn, today)
    # Consecutive slots each city has ended without a fresh reading -- not one
    # global counter. Kaohsiung and Taoyuan stamp every observation
    # `data_ts=now` (TS_FETCH: their feeds carry no per-record timestamp at
    # all -- see their adapter modules), so a successful fetch always reports
    # `advanced=True` and their count here can *structurally never* leave 0,
    # whether the feed is genuinely healthy or merely echoing yesterday's
    # numbers under a fresh clock. That is not an oversight: for those two
    # cities this counter simply has nothing to say, and an outright failure
    # is already a different, real signal -- `ok=False` in
    # `store.record_source_health`, checked independently of this dict. See
    # the exit condition at the end of the loop for how the asymmetry is kept
    # from masking a real outage.
    stall_slots: dict[str, int] = dict.fromkeys(sources_by_city, 0)

    while True:
        target = next_poll_ts(now_fn())
        sleep(max(0, target - now_fn()))

        # Cities not yet accounted for with a fresh reading this slot. Every
        # attempt asks only these: retrying a city that already advanced this
        # slot would, for every source, ask a feed that has nothing new to
        # say, and for the five feeds that are already fine it would turn one
        # request into up to four for no reason -- exactly the load
        # RETRY_DELAYS_SEC's budget exists to spend on the source(s) that
        # actually need a second look.
        pending = set(sources_by_city)
        slot_results: dict[str, TickResult] = {}

        for delay in (0, *config.RETRY_DELAYS_SEC):
            if not pending:
                break
            if delay:
                sleep(delay)
            try:
                to_try = [sources_by_city[city] for city in sources_by_city if city in pending]
                results = collect(conn, to_try, capacities)
            except Exception:
                # collect_all isolates every source's own failure and never
                # raises; this stays as the outer net for an injected collect
                # that does not, and for anything collect_all itself cannot
                # anticipate. Nothing here advanced, so `pending` is
                # unchanged and every one of these cities is retried next
                # attempt.
                log.exception("tick failed; will retry within this slot")
                continue
            for result in results:
                slot_results[result.city] = result
                if result.advanced:
                    pending.discard(result.city)
            if pending:
                log.warning(
                    "%s source(s) still without a fresh reading this attempt "
                    "(%s); retrying", len(pending), ", ".join(sorted(pending)),
                )

        # Computed once, after retries for this slot are done, regardless of
        # whether the loop above broke early (every city caught up) or ran
        # out of attempts with some still pending -- unlike the single global
        # counter this replaced, a slot ending with *some* cities advanced
        # and others not is now the ordinary case, not a binary "all or
        # nothing" the old `for/else` could assume.
        advanced_cities = {city for city, r in slot_results.items() if r.advanced}
        for city in advanced_cities:
            r = slot_results[city]
            log.info("tick city=%s data_ts=%s rows=%s", r.city, r.data_ts, r.rows_written)
        for city in stall_slots:
            stall_slots[city] = 0 if city in advanced_cities else stall_slots[city] + 1

        if advanced_cities:
            if publish is not None:
                try:
                    publish(conn)
                except Exception:
                    # Publishing is downstream of collection: a tick missed is
                    # data that can never be re-fetched, while a stale artifact
                    # is fixed by the very next tick. It must never be able to
                    # take collection down with it.
                    log.exception("publishing artifacts failed; will retry next tick")
        else:
            log.error("slot ended with no source advancing at all")

        # Taipei's corpus cannot be re-fetched, so it alone stalling for the
        # full window is exit-worthy on its own, independent of every other
        # city's state -- the whole reason this moved from one counter to a
        # per-city dict. Every other city stalling in isolation is not, by
        # itself, cause to restart the process (a gap in a replaceable feed
        # is a worse outcome than a needless restart), so their stalls only
        # matter in aggregate: every tracked city stalled for the same
        # window at once is the direct generalisation of the old single
        # counter to six independent sources, and is what actually shows the
        # whole process -- not one feed -- has stopped making progress. A
        # city whose count can never move at all (see above) simply can
        # never be the one that makes this True on its own.
        taipei_stalled = stall_slots.get("taipei", 0) >= config.MAX_EXHAUSTED_SLOTS
        all_stalled = bool(stall_slots) and all(
            n >= config.MAX_EXHAUSTED_SLOTS for n in stall_slots.values()
        )
        if taipei_stalled or all_stalled:
            # Looping forever on a feed that changed shape logs an error
            # every five minutes while collecting nothing, and the process
            # never exits, so `restart: unless-stopped` never fires and the
            # container keeps reporting itself healthy. Exiting non-zero
            # turns a silent stall into a rising restart count.
            if all_stalled:
                culprit, streak = "every tracked source", max(stall_slots.values())
            else:
                culprit, streak = "taipei", stall_slots["taipei"]
            raise SystemExit(
                f"{culprit} produced no fresh tick for {streak} consecutive slots "
                f"({streak * config.POLL_PERIOD_MIN} min); exiting so the restart "
                "policy fires"
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

        # Prune is the only thing that destroys rows, and it must never take a
        # day compaction has not written out. Compaction stops at its first
        # failure and retries next slot; without this bound, a day whose
        # compaction kept failing for ~24 h fell out of the 48 h window and was
        # deleted with no cold copy. `archived_day` is the earliest day not yet
        # archived, so nothing from its first second onward may go.
        cutoff = min(now_fn() - config.HOT_RETENTION_SEC, day_bounds(archived_day)[0])
        removed = store.prune(conn, cutoff)
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
