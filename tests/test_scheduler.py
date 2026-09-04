import json
import logging
from datetime import date, datetime, timezone

import pytest

from parkcast import artifacts, config, scheduler, store
from parkcast.collector import TickResult
from parkcast.compact import day_bounds
from parkcast.feed import FeedSnapshot, Observation
from parkcast.metadata import Lot
from parkcast.scheduler import next_poll_ts, taipei_date


def minute_of(ts: int) -> int:
    return (ts // 60) % 60


def second_of(ts: int) -> int:
    return ts % 60


def test_next_slot_lands_on_the_publish_phase():
    """Publication is on minutes congruent to 1 (mod 5); we poll 30s after."""
    ts = next_poll_ts(1788484080)  # 09:08:00 +08:00
    assert minute_of(ts) % 5 == 1
    assert second_of(ts) == 30


def test_next_slot_is_strictly_in_the_future():
    for now in range(1788484080, 1788484080 + 600, 37):
        assert next_poll_ts(now) > now


def test_exact_slot_moment_rolls_to_the_following_slot():
    slot = next_poll_ts(1788484080)
    assert next_poll_ts(slot) == slot + 300


def test_gap_between_consecutive_slots_is_five_minutes():
    a = next_poll_ts(1788484080)
    b = next_poll_ts(a)
    assert b - a == 300


def test_slot_follows_the_feed_by_about_three_and_a_half_minutes():
    """Feed stamps minute ≡3 (mod 5); we should poll ~3.5 min later."""
    data_ts = 1788484080  # minute 8, which is ≡3 (mod 5)
    assert minute_of(data_ts) % 5 == 3
    lag = next_poll_ts(data_ts) - data_ts
    assert 180 <= lag <= 240, f"expected a 3-4 min lag, got {lag}s"


# --- run_forever ------------------------------------------------------------
#
# run_forever() is an infinite loop. To test it without hanging the suite we
# drive it with a virtual clock (a fake sleep/now_fn pair that never touches
# real time) and end each scenario by raising a BaseException subclass from
# an injected fake — one that `except Exception` in the loop's retry handler
# cannot swallow — once the scenario has played out.


class _StopLoop(BaseException):
    """Escapes run_forever's `except Exception` on purpose."""


class _VirtualClock:
    """A fake clock: sleep() advances it, now_fn() reads it. No real time passes."""

    def __init__(self, start: int):
        self.now = start

    def now_fn(self) -> int:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def test_run_forever_happy_path_makes_a_single_collect_call(monkeypatch):
    """A tick that advances immediately must not trigger any retries."""
    clock = _VirtualClock(1788484080)
    calls = []

    def fake_collect(conn, capacities):
        calls.append(clock.now)
        return TickResult(data_ts=1788484080, rows_written=5, advanced=True)

    def fake_prune(conn, cutoff_ts):
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sleep=clock.sleep, now_fn=clock.now_fn
        )

    assert len(calls) == 1


def test_run_forever_retries_with_configured_backoff_when_feed_stalls(monkeypatch):
    """A feed that never advances must be retried at exactly RETRY_DELAYS_SEC."""
    clock = _VirtualClock(1788484080)
    call_times = []

    def fake_collect(conn, capacities):
        call_times.append(clock.now)
        return TickResult(data_ts=1788484080, rows_written=0, advanced=False)

    def fake_prune(conn, cutoff_ts):
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sleep=clock.sleep, now_fn=clock.now_fn
        )

    assert len(call_times) == 4
    gaps = [b - a for a, b in zip(call_times, call_times[1:])]
    assert gaps == list(config.RETRY_DELAYS_SEC)


def test_run_forever_survives_one_bad_tick_and_succeeds_on_retry(monkeypatch):
    """A single exception from collect must not kill the process."""
    clock = _VirtualClock(1788484080)
    attempts = []

    def fake_collect(conn, capacities):
        attempts.append(clock.now)
        if len(attempts) == 1:
            raise ConnectionError("feed unreachable")
        return TickResult(data_ts=1788484080, rows_written=3, advanced=True)

    def fake_prune(conn, cutoff_ts):
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sleep=clock.sleep, now_fn=clock.now_fn
        )

    assert len(attempts) == 2, "loop should retry after the exception and succeed"


def test_run_forever_prunes_even_when_every_attempt_in_the_slot_fails(monkeypatch):
    """Pruning the hot window must run whether or not the slot got fresh data."""
    clock = _VirtualClock(1788484080)
    attempts = []

    def fake_collect(conn, capacities):
        attempts.append(clock.now)
        raise RuntimeError("boom")

    prune_calls = []

    def fake_prune(conn, cutoff_ts):
        prune_calls.append(cutoff_ts)
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sleep=clock.sleep, now_fn=clock.now_fn
        )

    assert len(attempts) == 4, "all retries should have been exhausted"
    assert len(prune_calls) == 1
    assert prune_calls[0] == clock.now - config.HOT_RETENTION_SEC


def test_run_forever_slot_targets_stay_300s_apart_despite_exhausted_retries(monkeypatch):
    """Retry time spent in one slot must not drift the phase of later slots."""
    clock = _VirtualClock(1788484080)
    targets = []
    real_next_poll_ts = scheduler.next_poll_ts

    def spy_next_poll_ts(now):
        target = real_next_poll_ts(now)
        targets.append(target)
        return target

    monkeypatch.setattr(scheduler, "next_poll_ts", spy_next_poll_ts)

    prune_calls = []

    def fake_collect(conn, capacities):
        # First slot never advances (burns all retries); later slots advance
        # on the first attempt.
        if len(prune_calls) == 0:
            return TickResult(data_ts=0, rows_written=0, advanced=False)
        return TickResult(data_ts=len(prune_calls), rows_written=1, advanced=True)

    def fake_prune(conn, cutoff_ts):
        prune_calls.append(cutoff_ts)
        if len(prune_calls) >= 3:
            raise _StopLoop()
        return 0

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sleep=clock.sleep, now_fn=clock.now_fn
        )

    assert len(targets) == 3
    assert targets[1] - targets[0] == 300
    assert targets[2] - targets[1] == 300


def _no_archive(conn, day):
    """A do-nothing archive hook.

    The default is the real archive_day, which writes under config.PARQUET_DIR
    -- the live cold store. Any test whose virtual clock crosses Taipei
    midnight must inject this (or a spy) so the suite never reaches it.
    Compaction itself is covered by the archive tests below.
    """


# --- daily metadata refresh --------------------------------------------------


def test_taipei_date_uses_taipei_not_utc():
    """16:30 UTC is already the next day in Taipei (UTC+8)."""
    ts = int(datetime(2026, 9, 4, 16, 30, tzinfo=timezone.utc).timestamp())
    assert taipei_date(ts) == date(2026, 9, 5)


def test_refresh_not_called_while_the_day_is_unchanged(monkeypatch):
    calls = []
    ticks = []
    clock = _VirtualClock(int(datetime(2026, 9, 4, 2, 0, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 3:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"A": 1}, collect=collect, sleep=clock.sleep,
                               now_fn=clock.now_fn, archive=_no_archive, refresh_metadata=lambda d: calls.append(d) or {})
    assert calls == [], "refresh must not fire within a single Taipei day"


def test_refresh_rebind_is_observable_at_the_call_site(monkeypatch):
    """The map collect() receives must become the refreshed one, not stay bound to the original.

    A mutation that assigns the refreshed map to an unused local (instead of
    rebinding `capacities`) would leave every observed map as the original —
    this must fail in that case.
    """
    seen = []
    # Start just before Taipei midnight (15:59:30 UTC == 23:59:30 Taipei).
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, capacities):
        seen.append(dict(capacities))
        if len(seen) >= 4:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    def refresh(day):
        return {"NEW": 42}

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"OLD": 1}, collect=collect, sleep=clock.sleep,
                               now_fn=clock.now_fn, archive=_no_archive, refresh_metadata=refresh)

    assert {"OLD": 1} in seen, "the slot(s) before the refresh landed should still see the original map"
    assert {"NEW": 42} in seen, "later slots must see the refreshed map, proving it was rebound"


def test_failed_refresh_is_retried_on_a_later_slot(monkeypatch):
    """current_day must stay stale on failure, or a single bad refresh kills all future retries.

    A mutation that advances `current_day` in a `finally` block (so it
    advances even when refresh_metadata raises) would permanently disable
    retries after the first failure — refresh_metadata would only ever be
    called once, and the successful map would never be observed.
    """
    seen = []
    refresh_calls = []
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, capacities):
        seen.append(dict(capacities))
        if len(seen) >= 4:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    def refresh(day):
        refresh_calls.append(day)
        if len(refresh_calls) == 1:
            raise ConnectionError("metadata endpoint down")
        return {"NEW": 42}

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"OLD": 1}, collect=collect, sleep=clock.sleep,
                               now_fn=clock.now_fn, archive=_no_archive, refresh_metadata=refresh)

    assert refresh_calls == [date(2026, 9, 5), date(2026, 9, 5)], (
        f"expected two refresh attempts, both for the new day, got {refresh_calls}"
    )
    assert {"NEW": 42} in seen, "collect must eventually observe the successfully refreshed map"


def test_persistently_failing_refresh_never_corrupts_capacities(monkeypatch):
    """A refresh that always raises must leave capacities exactly as they were, on every tick.

    The retry test above only fails once then recovers, so it never checks
    what `capacities` equals *during* a failed tick. A mutation that replaces
    the map on failure (e.g. `except Exception: capacities = {}`) would
    silently corrupt it during the failure window — this must fail in that
    case. "Stale capacities beat no capacities" is the whole point of the
    except branch.
    """
    seen = []
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, capacities):
        seen.append(dict(capacities))
        if len(seen) >= 4:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    def boom(day):
        raise ConnectionError("metadata endpoint down")

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"OLD": 1}, collect=collect, sleep=clock.sleep,
                               now_fn=clock.now_fn, archive=_no_archive, refresh_metadata=boom)

    assert all(c == {"OLD": 1} for c in seen), f"stale capacities beat no capacities, got {seen}"


def test_successful_refresh_fires_exactly_once_for_the_day(monkeypatch):
    """current_day must be updated on success, or every slot in the same day refires forever.

    A mutation that drops `current_day = day` from the success path would
    make refresh_metadata fire on every remaining slot of the day, not once.
    """
    refresh_calls = []
    ticks = []
    # Start just before Taipei midnight; 4 slots (20 min) stay well inside the new day.
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 4:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    def refresh(day):
        refresh_calls.append(day)
        return {"NEW": 42}

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"OLD": 1}, collect=collect, sleep=clock.sleep,
                               now_fn=clock.now_fn, archive=_no_archive, refresh_metadata=refresh)

    assert refresh_calls == [date(2026, 9, 5)], f"expected exactly one refresh call for the day, got {refresh_calls}"


# --- daily compaction into the cold store ------------------------------------
#
# Without this hook nothing ever calls compact_day, so `data/cold/` stays empty
# and prune -- which runs every slot against a 48h window -- silently makes the
# whole system a rolling two-day buffer that throws the training corpus away.


def _seed(conn, day, lot="A", free=10, motor=None):
    start, _ = day_bounds(day)
    store.insert_snapshot(
        conn, FeedSnapshot(start, start + 200, (Observation(lot, free, motor),)), {lot: 50}
    )


def test_previous_day_is_compacted_when_the_taipei_day_rolls_over(monkeypatch):
    """The rollover is the only moment the finished day is both complete and unpruned."""
    archived = []
    ticks = []
    # 23:59:30 Taipei: the first slot lands at 00:01:30 the next day.
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 3:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sleep=clock.sleep,
                              now_fn=clock.now_fn,
                              archive=lambda conn, day: archived.append(day))

    assert archived == [date(2026, 9, 4)], "exactly the day that just ended, exactly once"


def test_no_compaction_while_the_day_is_still_running(monkeypatch):
    """Compacting a day in progress would write a file that can never be completed."""
    archived = []
    ticks = []
    clock = _VirtualClock(int(datetime(2026, 9, 4, 2, 0, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 4:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sleep=clock.sleep,
                              now_fn=clock.now_fn,
                              archive=lambda conn, day: archived.append(day))

    assert archived == []


def test_compaction_runs_before_prune(monkeypatch):
    """Prune is the only thing that destroys rows; compaction must get them first.

    There is a full day of headroom today (48h retention, 24h day), but the
    order is what keeps that true if retention is ever tightened, and it is
    what lets a startup catch-up salvage a day near the 48h edge.
    """
    events = []
    ticks = []
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))

    def fake_prune(conn, cutoff_ts):
        events.append("prune")
        return 0

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    def collect(conn, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 3:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sleep=clock.sleep,
                              now_fn=clock.now_fn,
                              archive=lambda conn, day: events.append("archive"))

    assert events[:2] == ["archive", "prune"]


def test_failed_compaction_is_retried_for_the_same_day_and_collection_continues(monkeypatch):
    """A compaction failure must cost a retry, never the day itself.

    If the watermark advanced regardless of the outcome, one bad slot would
    lose a day permanently -- prune deletes it 24 hours later and the feed
    cannot be replayed.
    """
    attempts = []
    ticks = []
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def flaky_archive(conn, day):
        attempts.append(day)
        if len(attempts) == 1:
            raise OSError("no space left on device")

    def collect(conn, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 4:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=flaky_archive)

    assert attempts == [date(2026, 9, 4), date(2026, 9, 4)], (
        "the same day must be retried, then archived exactly once more"
    )
    assert len(ticks) == 4, "collection must continue through a compaction failure"


def test_startup_catches_up_days_a_restart_left_unarchived(tmp_path, monkeypatch):
    """A restart between midnight and the first rollover must not lose the day.

    run_forever only archives rollovers it witnesses, so a container that comes
    back at 00:05 would never compact the day that just ended -- and prune
    takes it 48 hours later. The watermark therefore starts at the oldest day
    still in the hot store, not at today.
    """
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 3))

    archived = []
    ticks = []
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)
    clock = _VirtualClock(int(datetime(2026, 9, 5, 2, 0, tzinfo=timezone.utc).timestamp()))

    def collect(c, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 2:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    try:
        with pytest.raises(_StopLoop):
            scheduler.run_forever(conn, {}, collect=collect, sleep=clock.sleep,
                                  now_fn=clock.now_fn,
                                  archive=lambda c, day: archived.append(day))
    finally:
        conn.close()

    assert archived == [date(2026, 9, 3), date(2026, 9, 4)], (
        "every completed day still in the hot store must be caught up, in order"
    )


def test_archive_day_writes_the_cold_file_and_logs_the_report(tmp_path, caplog):
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), motor=3)
    out_dir = tmp_path / "cold"

    with caplog.at_level(logging.INFO, logger="parkcast.scheduler"):
        scheduler.archive_day(conn, date(2026, 9, 4), out_dir)
    conn.close()

    assert (out_dir / "2026-09-04.parquet").exists()
    assert "data quality" in caplog.text, "the day's report must reach the log"


def test_archive_day_refuses_to_rewrite_an_existing_cold_file(tmp_path):
    """Compaction only ever sees the 48h hot window.

    Re-running it for an older day -- which the startup catch-up does after
    every restart -- would replace a complete Parquet file with whatever
    fraction of that day prune has not yet deleted.
    """
    out_dir = tmp_path / "cold"
    out_dir.mkdir()
    existing = out_dir / "2026-09-04.parquet"
    existing.write_bytes(b"the complete day, written yesterday")

    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4))
    scheduler.archive_day(conn, date(2026, 9, 4), out_dir)
    conn.close()

    assert existing.read_bytes() == b"the complete day, written yesterday"


# --- stalled-collection watchdog ---------------------------------------------


def test_exits_non_zero_after_an_hour_of_exhausted_slots(monkeypatch):
    """A feed that changed shape must not be logged about forever in silence.

    run_forever catches Exception per attempt and loops, so the process never
    exits and `restart: unless-stopped` never fires. Exiting turns an
    invisible stall into a rising restart count.
    """
    clock = _VirtualClock(1788484080)
    attempts = []
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    expected = config.MAX_EXHAUSTED_SLOTS * (1 + len(config.RETRY_DELAYS_SEC))

    def stalled(conn, capacities):
        attempts.append(clock.now)
        # Safety net: a loop that never exits must fail this test, not hang it.
        if len(attempts) > 2 * expected:
            raise _StopLoop()
        return TickResult(data_ts=1788484080, rows_written=0, advanced=False)

    with pytest.raises(SystemExit) as exc:
        scheduler.run_forever(None, {}, collect=stalled, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=_no_archive)

    assert exc.value.code, "must exit non-zero, or Docker will not restart it"
    assert len(attempts) == expected, (
        f"expected exactly {config.MAX_EXHAUSTED_SLOTS} exhausted slots before exit"
    )


def test_one_good_tick_resets_the_exhausted_slot_counter(monkeypatch):
    """The threshold counts CONSECUTIVE failures.

    A feed that drops one slot an hour is healthy; without the reset the
    counter would creep up over days and eventually kill a working collector.
    """
    clock = _VirtualClock(1788484080)
    slots = []
    monkeypatch.setattr(scheduler.store, "prune", lambda c, t: slots.append(t) or 0)

    limit = config.MAX_EXHAUSTED_SLOTS

    def collect(conn, capacities):
        slot = len(slots)
        if slot == limit - 1:
            return TickResult(data_ts=slot, rows_written=1, advanced=True)
        if slot >= 2 * limit - 1:
            raise _StopLoop()
        return TickResult(data_ts=0, rows_written=0, advanced=False)

    # Reaching _StopLoop at all proves SystemExit never fired: without the
    # reset, a run of 11 exhausted slots either side of one good tick would
    # trip the threshold.
    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=_no_archive)


# --- publishing forecast artifacts -------------------------------------------


def test_publish_runs_after_an_advancing_tick(monkeypatch):
    """publish is None by default (every test above passes none), so wiring it
    in must not disturb any existing behaviour -- it must only fire once per
    tick that actually advanced."""
    published = []
    clock = _VirtualClock(1788537600)
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, capacities):
        if len(published) >= 2:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=_no_archive,
                              publish=lambda conn: published.append(clock.now))

    assert len(published) == 2


def test_publish_failure_does_not_stop_collection(monkeypatch):
    """Collection is irreplaceable; a failed publish just means the artifacts
    are stale for one more tick. It must never be able to take collection down."""
    ticks = []
    clock = _VirtualClock(1788537600)
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 3:
            raise _StopLoop()
        return TickResult(data_ts=clock.now, rows_written=1, advanced=True)

    def boom(conn):
        raise RuntimeError("artifact write failed")

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=_no_archive, publish=boom)

    assert len(ticks) == 3, "collection must survive a publishing failure"


# --- publish_artifacts must never blank good artifacts -----------------------


def _make_lot(lot_id: str) -> Lot:
    return Lot(id=lot_id, name=f"lot {lot_id}", area="中正區", lot_type="立體",
               capacity_car=50, lat=25.05, lon=121.52,
               service_time="00:00:00-23:59:59", fare_text="每小時30元")


def test_publish_artifacts_with_no_lots_leaves_existing_files_untouched(tmp_path):
    """An empty `lots` argument (e.g. a metadata outage at startup left `_lots`
    empty) must not overwrite good artifacts with a header-only grid and an
    empty lots.json."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4))
    out_dir = tmp_path / "artifacts"
    out_dir.mkdir()
    (out_dir / "grid.bin").write_bytes(b"OLD-GRID-BYTES-18")
    (out_dir / "lots.json").write_text('{"lots":[{"i":0,"id":"OLD"}]}', encoding="utf-8")

    scheduler.publish_artifacts(conn, [], out_dir)
    conn.close()

    assert (out_dir / "grid.bin").read_bytes() == b"OLD-GRID-BYTES-18"
    assert (out_dir / "lots.json").read_text(encoding="utf-8") == (
        '{"lots":[{"i":0,"id":"OLD"}]}'
    )
    assert list(out_dir.glob("*.tmp")) == []


def test_publish_artifacts_with_empty_history_leaves_existing_files_untouched(tmp_path):
    """Same failure shape, different cause: a non-empty `lots` list where none
    of the lots have any observation (fresh store, or a store that has not
    seen these particular lots yet) must also leave existing artifacts alone."""
    conn = store.connect(tmp_path / "t.sqlite")  # no observations inserted
    out_dir = tmp_path / "artifacts"
    out_dir.mkdir()
    (out_dir / "grid.bin").write_bytes(b"OLD-GRID-BYTES-18")
    (out_dir / "lots.json").write_text('{"lots":[{"i":0,"id":"OLD"}]}', encoding="utf-8")

    scheduler.publish_artifacts(conn, [_make_lot("A"), _make_lot("B")], out_dir)
    conn.close()

    assert (out_dir / "grid.bin").read_bytes() == b"OLD-GRID-BYTES-18"
    assert (out_dir / "lots.json").read_text(encoding="utf-8") == (
        '{"lots":[{"i":0,"id":"OLD"}]}'
    )
    assert list(out_dir.glob("*.tmp")) == []


def test_publish_artifacts_still_overwrites_on_a_normal_publish(tmp_path):
    """The empty-history guard must not break the happy path."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), lot="A")
    out_dir = tmp_path / "artifacts"
    out_dir.mkdir()
    (out_dir / "grid.bin").write_bytes(b"OLD-GRID-BYTES-18")
    (out_dir / "lots.json").write_text('{"lots":[{"i":0,"id":"OLD"}]}', encoding="utf-8")

    scheduler.publish_artifacts(conn, [_make_lot("A")], out_dir)
    conn.close()

    assert (out_dir / "grid.bin").read_bytes() != b"OLD-GRID-BYTES-18"
    lots_doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    assert [l["id"] for l in lots_doc["lots"]] == ["A"]


def test_publish_artifacts_stamps_both_files_with_one_identity(tmp_path):
    """grid.bin and lots.json are two independent renames, and the row order is
    recomputed every tick. The client's only defence against pairing a fresh
    grid with stale metadata is that both carry the same generation stamp."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), lot="A")
    _seed(conn, date(2026, 9, 4), lot="B")
    out_dir = tmp_path / "artifacts"

    scheduler.publish_artifacts(conn, [_make_lot("A"), _make_lot("B")], out_dir)
    conn.close()

    header = artifacts.decode_header((out_dir / "grid.bin").read_bytes())
    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    for field in ("generated_at", "base_data_ts", "n_lots", "roster_id"):
        assert doc[field] == header[field], f"{field} disagrees across the pair"
    assert doc["n_lots"] == len(doc["lots"]) == 2
    assert doc["roster_id"] == artifacts.roster_id([l["id"] for l in doc["lots"]]), (
        "the roster must hash the rows actually published"
    )
    assert doc["v"] == artifacts.VERSION


def test_publish_artifacts_keeps_the_roster_id_across_ticks(tmp_path):
    """lots.json is cached for a week while grid.bin is republished every five
    minutes. If the roster stamp moved with generated_at, a client enforcing the
    pairing check would have to re-fetch it every tick or drop the check."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), lot="A")
    _seed(conn, date(2026, 9, 4), lot="B")
    out_dir = tmp_path / "artifacts"
    lots = [_make_lot("A"), _make_lot("B")]

    scheduler.publish_artifacts(conn, lots, out_dir)
    first = artifacts.decode_header((out_dir / "grid.bin").read_bytes())
    _seed(conn, date(2026, 9, 5), lot="A")   # a later tick, same two lots
    _seed(conn, date(2026, 9, 5), lot="B")
    scheduler.publish_artifacts(conn, lots, out_dir)
    second = artifacts.decode_header((out_dir / "grid.bin").read_bytes())
    conn.close()

    assert second["base_data_ts"] > first["base_data_ts"], "a genuinely newer publish"
    assert second["roster_id"] == first["roster_id"], "an unchanged roster keeps its id"


def test_publish_artifacts_changes_the_roster_id_when_the_rows_shift(tmp_path):
    """A lot joining at index 0 shifts every later row; n_lots would also catch
    this one, but the stamp that must move is the roster."""
    conn = store.connect(tmp_path / "t.sqlite")
    for lot_id in ("A", "B", "C"):
        _seed(conn, date(2026, 9, 4), lot=lot_id)
    out_dir = tmp_path / "artifacts"

    scheduler.publish_artifacts(conn, [_make_lot("B"), _make_lot("C")], out_dir)
    before = artifacts.decode_header((out_dir / "grid.bin").read_bytes())["roster_id"]
    scheduler.publish_artifacts(
        conn, [_make_lot("A"), _make_lot("B"), _make_lot("C")], out_dir
    )
    after = artifacts.decode_header((out_dir / "grid.bin").read_bytes())["roster_id"]
    conn.close()

    assert before != after


def _publish(conn, out_dir, lot_ids):
    scheduler.publish_artifacts(conn, [_make_lot(i) for i in lot_ids], out_dir)


def test_publish_artifacts_refuses_a_collapsed_lot_count(tmp_path, caplog):
    """A store restored from a partial backup yields a plausible handful of
    lots. Publishing it would take most of the city's parking off the map."""
    conn = store.connect(tmp_path / "t.sqlite")
    ids = [f"L{i:03d}" for i in range(10)]
    for lot_id in ids:
        _seed(conn, date(2026, 9, 4), lot=lot_id)
    out_dir = tmp_path / "artifacts"
    _publish(conn, out_dir, ids)                       # a healthy 10-lot grid
    good_grid = (out_dir / "grid.bin").read_bytes()
    good_lots = (out_dir / "lots.json").read_bytes()

    thin = store.connect(tmp_path / "thin.sqlite")     # only 4 of the 10 survive
    for lot_id in ids[:4]:
        _seed(thin, date(2026, 9, 4), lot=lot_id)
    with caplog.at_level(logging.ERROR, logger="parkcast.scheduler"):
        _publish(thin, out_dir, ids[:4])
    conn.close()
    thin.close()

    assert (out_dir / "grid.bin").read_bytes() == good_grid, "the good grid must survive"
    assert (out_dir / "lots.json").read_bytes() == good_lots
    assert "refusing to publish" in caplog.text
    assert list(out_dir.glob("*.tmp")) == []


def test_publish_artifacts_allows_a_lot_count_above_the_floor(tmp_path):
    """Lots do legitimately come and go -- the guard must only catch a collapse."""
    conn = store.connect(tmp_path / "t.sqlite")
    ids = [f"L{i:03d}" for i in range(10)]
    for lot_id in ids:
        _seed(conn, date(2026, 9, 4), lot=lot_id)
    out_dir = tmp_path / "artifacts"
    _publish(conn, out_dir, ids)

    fewer = store.connect(tmp_path / "fewer.sqlite")   # 6 of 10, above the 50% floor
    for lot_id in ids[:6]:
        _seed(fewer, date(2026, 9, 4), lot=lot_id)
    _publish(fewer, out_dir, ids[:6])
    conn.close()
    fewer.close()

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    assert doc["n_lots"] == 6
    assert artifacts.decode_header((out_dir / "grid.bin").read_bytes())["n_lots"] == 6


def test_publish_artifacts_publishes_when_there_is_no_readable_baseline(tmp_path):
    """No grid.bin yet, or bytes that are not a grid: nothing to compare, so the
    guard must not block the first publish or a recovery from a corrupt file."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), lot="A")
    out_dir = tmp_path / "artifacts"
    out_dir.mkdir()
    (out_dir / "grid.bin").write_bytes(b"not a grid header at all, truly")

    _publish(conn, out_dir, ["A"])
    conn.close()

    header = artifacts.decode_header((out_dir / "grid.bin").read_bytes())
    assert header["magic"] == artifacts.MAGIC and header["n_lots"] == 1
