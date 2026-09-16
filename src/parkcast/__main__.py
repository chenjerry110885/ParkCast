"""Entry point: python -m parkcast"""
import logging
from datetime import date, datetime

from parkcast import config, sources, store, upload
from parkcast.collector import fetch_json
from parkcast.metadata import Lot, capacity_map, parse_metadata, snapshot_metadata
from parkcast.scheduler import publish_artifacts, run_forever

# Taipei's lot list. `build_capacities` refreshes it alongside the capacity map
# on every day-rollover, so it is never frozen at whatever the feed looked like
# on day one - a bug this codebase has already had to fix once for capacities
# themselves. Only Taipei: the other five cities answer their roster in the
# same request as their counts, and theirs arrives per tick through
# `run_forever`'s `rosters` instead (see `_roster` below).
_lots: tuple[Lot, ...] = ()


def build_capacities(day: date) -> dict[str, int | None]:
    """Fetch metadata, snapshot it for `day`, and return the capacity map."""
    global _lots
    raw = fetch_json(config.METADATA_URL)
    snapshot_metadata(raw, config.PARQUET_DIR / "meta", day)
    _lots = parse_metadata(raw)
    return capacity_map(_lots)


def _roster(rosters: dict[str, tuple[Lot, ...]]) -> list[Lot]:
    """Every lot to publish this tick: Taipei's, plus each tick-carried roster.

    The two halves arrive on completely different clocks -- Taipei's once a day
    from `METADATA_URL`, the rest every five minutes from the same request as
    their counts -- and `publish_artifacts` regroups the whole list by city id
    anyway, so joining them here is the entire wiring. The lists are not copied
    per city: this rebinds references to rosters the adapters already parsed
    for capacities.
    """
    lots = list(_lots)
    for city_lots in rosters.values():
        lots.extend(city_lots)
    return lots


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("parkcast")

    # Before the store is even opened. Spec section 9 and the runbook both
    # require Taipei alone first, then New Taipei, then the rest; with the
    # registry hard-coded that meant editing source and rebuilding the image
    # three times, and a first boot as merged turning all six on at once --
    # exactly when an untested feed costs the most. An operator who sets
    # nothing gets all six, so this changes nothing by default.
    #
    # A typo is fatal on purpose. Every other startup failure here degrades
    # (stale capacities beat none; a failed migration still collects) because
    # the alternative costs ticks that cannot be re-fetched. This one is the
    # opposite: continuing would mean collecting a set of cities the operator
    # did not ask for and believes is running, and the gap that leaves in the
    # corpus is just as unrecoverable -- while the fix is one environment
    # variable and an immediate restart.
    try:
        enabled = sources.from_environment()
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    log.info(
        "collecting %s of %s cities: %s (set %s to change)",
        len(enabled), len(sources.SOURCES),
        ", ".join(source.city for source in enabled), sources.CITIES_ENV,
    )

    conn = store.connect(config.DB_PATH)

    # Before anything reads the store. The first tick below writes namespaced
    # ids, so any row still carrying a pre-namespacing one would sit in the same
    # hot window as the namespaced rows for the same physical car park -- and
    # `forecast.load_history` keys `current` and `counts` on that string, so the
    # lot's history splits in two. That is the half feeding `Persistence` and
    # `store.free_at`: the short-horizon forecast and the observed count on
    # every card, wrong for as long as the split lasts and entirely plausible
    # throughout. Waiting for prune to age the old rows out would mean two days
    # of it on the only corpus this project has.
    #
    # Logged at INFO every boot, including the zeroes: the first run after the
    # migration lands reports a large one-off number worth seeing, and every
    # later run reporting 0 is the signal that it is idempotent and has nothing
    # left to do.
    #
    # Survivable, because collection is the irreplaceable half and this is not.
    # The migration runs in one transaction that rolls itself back, so a failure
    # leaves the store exactly as it was -- two id conventions in one window.
    # Dying here instead would cost every tick, on every restart, until someone
    # ran SQL by hand: a strictly worse outcome than the one the migration
    # exists to prevent. Same reasoning as the metadata fetch below, and as
    # `run_forever`'s net around publishing.
    #
    # WHAT IT ACTUALLY COSTS, which is more than precision. Every per-city read
    # is scoped either by the `city` column (`store.oldest_data_ts`) or by the
    # namespaced-id key range (`ids.prefix_range`, which `liveness` and
    # `forecast` use), and a legacy row satisfies neither -- its city is '' and
    # its id has no prefix. So the legacy half is not merely split off from the
    # namespaced half, it is invisible to those reads entirely:
    #
    #   * Precision, as before: `forecast.load_history` keys `current` and
    #     `counts` on the id, so `Persistence` and `store.free_at` see only the
    #     post-boot half -- the short-horizon forecast and the observed count on
    #     every card.
    #   * Not precision: `liveness.not_updating` sees only post-boot readings,
    #     so a Taipei lot frozen for 48 h has an unchanged run that appears to
    #     start at boot, and no lot can reach NOT_UPDATING_AFTER_SEC (24 h) of
    #     it until the collector has been up that long. Measured: `{}` withheld
    #     where the migrated store withholds the frozen lot. For about a day
    #     the app publishes stuck sensors as a 0 or 100 per cent certainty
    #     again -- the exact failure `liveness.py`'s docstring opens with, and
    #     the one Plan 3e shipped to fix.
    try:
        migration = store.migrate_to_namespaced_ids(conn)
    except Exception:
        log.exception(
            "id migration failed and was rolled back; collecting anyway. Until "
            "this succeeds every pre-namespacing row is invisible to every "
            "per-city read: Taipei's history splits, so the short-horizon "
            "forecast and the observed count on each card degrade -- AND "
            "liveness.not_updating sees only post-boot readings, so no lot can "
            "be judged not-updating for the first 24 h and stuck sensors are "
            "published as certainties again. Fix this before trusting a "
            "published forecast"
        )
    else:
        log.info(
            "id migration rewrote %s pre-namespacing row(s) and dropped %s "
            "already superseded by a namespaced twin",
            migration.rewritten, migration.dropped,
        )

    # The metadata blob is 2.85 MB and separate from the availability blob, so
    # it can be unavailable while collection would be perfectly fine. Dying
    # here costs ticks that cannot be re-fetched; starting with no capacities
    # costs nothing but a NO_CAPACITY flag on every lot, and the day-rollover
    # refresh fills them in. This mirrors the rollover path, which already
    # treats a metadata failure as survivable.
    try:
        capacities = build_capacities(datetime.now(config.TAIPEI_TZ).date())
        log.info("loaded capacities for %s lots", len(capacities))
    except Exception:
        capacities = {}
        log.exception(
            "metadata unavailable at startup; collecting with no capacities "
            "(every lot flags NO_CAPACITY) until the next day-rollover refresh"
        )

    # None unless the upload URL and the secret file are both valid; logs why once.
    uploader = upload.from_environment()

    run_forever(
        conn,
        capacities,
        sources=enabled,
        refresh_metadata=build_capacities,
        publish=lambda conn, rosters: publish_artifacts(
            conn, _roster(rosters), uploader=uploader
        ),
    )


if __name__ == "__main__":
    main()
