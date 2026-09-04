"""Phase-aligned polling loop.

Minute-of-hour is identical in UTC and UTC+8 because the offset is a whole
number of hours, so slot arithmetic needs no timezone conversion.
"""
import logging
import time

from parkcast import config, store
from parkcast.collector import collect_once

log = logging.getLogger("parkcast.scheduler")


def next_poll_ts(now: int) -> int:
    """The next instant with minute ≡ POLL_MINUTE_MOD (mod 5) at POLL_SECOND."""
    period = config.POLL_PERIOD_MIN * 60
    # Offset, in seconds past the hour, of the first slot in each 5-minute cycle.
    offset = config.POLL_MINUTE_MOD * 60 + config.POLL_SECOND
    elapsed = now - offset
    slots_done = elapsed // period
    return offset + (slots_done + 1) * period


def run_forever(
    conn,
    capacities: dict[str, int | None],
    *,
    collect=collect_once,
    sleep=time.sleep,
    now_fn=lambda: int(time.time()),
) -> None:
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
                break
            log.warning("feed has not advanced (data_ts=%s); retrying", result.data_ts)
        else:
            log.error("slot exhausted without a fresh tick")

        removed = store.prune(conn, now_fn() - config.HOT_RETENTION_SEC)
        if removed:
            log.info("pruned %s rows beyond the hot window", removed)
