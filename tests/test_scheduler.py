import pytest

from parkcast import config, scheduler
from parkcast.collector import TickResult
from parkcast.scheduler import next_poll_ts


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
