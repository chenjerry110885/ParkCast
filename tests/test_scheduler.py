import json
import logging
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from parkcast import artifacts, config, ids, scheduler, store
from parkcast.collector import TickResult
from parkcast.compact import day_bounds
from parkcast.feed import TS_FEED, FeedSnapshot, Observation
from parkcast.forecast import Climatology, Persistence, by_city, load_history
from parkcast.grid import UNKNOWN
from parkcast.metadata import Lot, capacity_map, parse_metadata
from parkcast.quality import Q
from parkcast.scheduler import next_poll_ts, taipei_date
from parkcast.sources import taipei

# Almost every test below models exactly one city and asserts on how many
# times / how far apart its `collect` fake was called -- assertions that only
# hold if `run_forever` has exactly one source to retry-or-not. Since the
# per-city retry logic narrows its request list by city name each attempt,
# passing the real six-source default here would leave the other five
# "pending" forever (the fakes never mention them), so every one of those
# tests would burn all four attempts every slot regardless of what the fake
# under test actually does. `SimpleNamespace(city=...)` is all `run_forever`
# needs from a source for this: a `.city` to key by -- it is never fetched
# from, since `collect` itself is replaced.
_ONE_SOURCE = [SimpleNamespace(city="taipei")]


@pytest.fixture(autouse=True)
def _isolated_cold_store(tmp_path, monkeypatch):
    """Keep this module off the live Parquet corpus.

    `publish_artifacts` reads `config.PARQUET_DIR`, so without this the suite
    loads whatever the collector has archived on this machine -- slow,
    non-deterministic, and, now that cold owns every day it holds a file for,
    silently swallowing the hot observations these tests seed on 2026-09-04,
    which is a real collected day. The cold store has its own tests; these are
    about the scheduler.
    """
    monkeypatch.setattr(config, "PARQUET_DIR", tmp_path / "cold-isolated")


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

    def fake_collect(conn, sources, capacities):
        calls.append(clock.now)
        return [TickResult(city="taipei", data_ts=1788484080, rows_written=5, advanced=True)]

    def fake_prune(conn, cutoff_ts):
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sources=_ONE_SOURCE, sleep=clock.sleep, now_fn=clock.now_fn
        )

    assert len(calls) == 1


def test_run_forever_retries_with_configured_backoff_when_feed_stalls(monkeypatch):
    """A feed that never advances must be retried at exactly RETRY_DELAYS_SEC."""
    clock = _VirtualClock(1788484080)
    call_times = []

    def fake_collect(conn, sources, capacities):
        call_times.append(clock.now)
        return [TickResult(city="taipei", data_ts=1788484080, rows_written=0, advanced=False)]

    def fake_prune(conn, cutoff_ts):
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sources=_ONE_SOURCE, sleep=clock.sleep, now_fn=clock.now_fn
        )

    assert len(call_times) == 4
    gaps = [b - a for a, b in zip(call_times, call_times[1:])]
    assert gaps == list(config.RETRY_DELAYS_SEC)


def test_run_forever_survives_one_bad_tick_and_succeeds_on_retry(monkeypatch):
    """A single exception from collect must not kill the process."""
    clock = _VirtualClock(1788484080)
    attempts = []

    def fake_collect(conn, sources, capacities):
        attempts.append(clock.now)
        if len(attempts) == 1:
            raise ConnectionError("feed unreachable")
        return [TickResult(city="taipei", data_ts=1788484080, rows_written=3, advanced=True)]

    def fake_prune(conn, cutoff_ts):
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sources=_ONE_SOURCE, sleep=clock.sleep, now_fn=clock.now_fn
        )

    assert len(attempts) == 2, "loop should retry after the exception and succeed"


def test_run_forever_prunes_even_when_every_attempt_in_the_slot_fails(monkeypatch):
    """Pruning the hot window must run whether or not the slot got fresh data."""
    clock = _VirtualClock(1788484080)
    attempts = []

    def fake_collect(conn, sources, capacities):
        attempts.append(clock.now)
        raise RuntimeError("boom")

    prune_calls = []

    def fake_prune(conn, cutoff_ts):
        prune_calls.append(cutoff_ts)
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sources=_ONE_SOURCE, sleep=clock.sleep, now_fn=clock.now_fn
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

    def fake_collect(conn, sources, capacities):
        # First slot never advances (burns all retries); later slots advance
        # on the first attempt.
        if len(prune_calls) == 0:
            return [TickResult(city="taipei", data_ts=0, rows_written=0, advanced=False)]
        return [TickResult(city="taipei", data_ts=len(prune_calls), rows_written=1, advanced=True)]

    def fake_prune(conn, cutoff_ts):
        prune_calls.append(cutoff_ts)
        if len(prune_calls) >= 3:
            raise _StopLoop()
        return 0

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(
            None, {}, collect=fake_collect, sources=_ONE_SOURCE, sleep=clock.sleep, now_fn=clock.now_fn
        )

    assert len(targets) == 3
    assert targets[1] - targets[0] == 300
    assert targets[2] - targets[1] == 300


def _spy_next_poll_ts(monkeypatch) -> list[int]:
    """Record every slot target `run_forever` computes. Returns the list."""
    targets: list[int] = []
    real = scheduler.next_poll_ts

    def spy(now):
        target = real(now)
        targets.append(target)
        return target

    monkeypatch.setattr(scheduler, "next_poll_ts", spy)
    return targets


def test_two_hanging_feeds_never_cost_taipei_the_following_slot(monkeypatch):
    """The retry budget was tuned for one source; six is a different budget.

    An attempt costs `len(pending) x HTTP_TIMEOUT_SEC` of socket timeouts, so
    with two feeds hanging the four attempts plus 45+45+60s of delays run the
    slot to ~390s. `next_poll_ts` is evaluated AFTER the loop, so it then
    returns the slot after next and the following slot is never collected --
    Taipei, which succeeded on attempt 1 and has nothing to retry, silently
    polls 12 times in 24 slots, permanently, and its readings cannot be
    re-fetched.

    The assertion is on the slot targets rather than on the retry count,
    because the damage is to the cities that were never in trouble.
    """
    clock = _VirtualClock(1788484080)
    hanging = {"newtaipei", "hsinchu"}
    sources = [SimpleNamespace(city=city) for city in
               ("taipei", "newtaipei", "kaohsiung", "tainan", "taoyuan", "hsinchu")]
    targets = _spy_next_poll_ts(monkeypatch)
    polls = []

    def collect(conn, to_try, capacities):
        results = []
        for source in to_try:
            if source.city in hanging:
                # A hung socket, charged to the clock exactly as the real one
                # would be: `collect_all` asks each source in turn.
                clock.sleep(config.HTTP_TIMEOUT_SEC)
                results.append(TickResult(city=source.city, data_ts=0,
                                          rows_written=0, advanced=False))
            else:
                polls.append((source.city, clock.now))
                results.append(TickResult(city=source.city, data_ts=clock.now,
                                          rows_written=1, advanced=True))
        return results

    slots = []

    def fake_prune(conn, cutoff_ts):
        slots.append(clock.now)
        if len(slots) >= 3:
            raise _StopLoop()
        return 0

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=sources,
                              sleep=clock.sleep, now_fn=clock.now_fn, archive=_no_archive)

    assert [b - a for a, b in zip(targets, targets[1:])] == [300, 300], (
        "a slot that overruns its own 300s makes next_poll_ts skip the "
        "following slot, and every healthy city loses that reading with it"
    )
    assert sum(1 for city, _ in polls if city == "taipei") == 3, (
        "Taipei must be polled once per slot, not once per two"
    )


def test_a_slot_that_ends_early_still_spends_its_whole_retry_budget(monkeypatch):
    """The deadline must not cost a healthy feed its retries.

    A Taipei publication landing late is the case RETRY_DELAYS_SEC exists for,
    and a feed that answers quickly -- even one that answers quickly with
    nothing new -- must still be asked all four times.
    """
    clock = _VirtualClock(1788484080)
    attempts = []

    def collect(conn, to_try, capacities):
        attempts.append(clock.now)
        # Answers immediately, but with a data_ts that has not moved.
        return [TickResult(city="taipei", data_ts=1788484080, rows_written=0, advanced=False)]

    def fake_prune(conn, cutoff_ts):
        raise _StopLoop()

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE,
                              sleep=clock.sleep, now_fn=clock.now_fn)

    assert [b - a for a, b in zip(attempts, attempts[1:])] == list(config.RETRY_DELAYS_SEC)


def test_a_roster_survives_the_tick_its_city_failed(monkeypatch):
    """A city absent from a slot's results must keep its last good roster.

    `collect_all` omits a city whose fetch raised, so publishing would
    otherwise see no roster for it and take the whole city off the map for a
    single failed request -- the opposite of the per-city isolation every other
    part of this loop is built for.
    """
    clock = _VirtualClock(1788484080)
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)
    sources = [SimpleNamespace(city="taipei"), SimpleNamespace(city="tainan")]
    tainan_lots = (_make_lot("1", city="tainan", lat=22.99, lon=120.21),)
    seen = []

    def collect(conn, to_try, capacities):
        if len(seen) == 0:
            return [
                TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True),
                TickResult(city="tainan", data_ts=clock.now, rows_written=1,
                           advanced=True, lots=tainan_lots),
            ]
        if len(seen) == 1:
            # Tainan's fetch raised this slot: collect_all simply omits it.
            return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]
        raise _StopLoop()

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=sources,
                              sleep=clock.sleep, now_fn=clock.now_fn, archive=_no_archive,
                              publish=lambda conn, rosters: seen.append(dict(rosters)))

    assert seen[0] == {"tainan": tainan_lots}
    assert seen[1] == {"tainan": tainan_lots}, (
        "one failed fetch must not remove a city from the published map"
    )


def test_an_empty_roster_does_not_replace_a_good_one(monkeypatch):
    """`lots=()` is the reshaped-payload case collect_once warns about -- real
    observations with a roster the parser could no longer read. Accepting it
    would take the city off the map on the strength of a renamed field."""
    clock = _VirtualClock(1788484080)
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)
    sources = [SimpleNamespace(city="tainan")]
    tainan_lots = (_make_lot("1", city="tainan", lat=22.99, lon=120.21),)
    seen = []

    def collect(conn, to_try, capacities):
        if len(seen) >= 2:
            raise _StopLoop()
        lots = tainan_lots if not seen else ()
        return [TickResult(city="tainan", data_ts=clock.now, rows_written=1,
                           advanced=True, lots=lots)]

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=sources,
                              sleep=clock.sleep, now_fn=clock.now_fn, archive=_no_archive,
                              publish=lambda conn, rosters: seen.append(dict(rosters)))

    assert seen[1] == {"tainan": tainan_lots}


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

    def collect(conn, sources, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 3:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"A": 1}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
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

    def collect(conn, sources, capacities):
        seen.append(dict(capacities))
        if len(seen) >= 4:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    def refresh(day):
        return {"NEW": 42}

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"OLD": 1}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
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

    def collect(conn, sources, capacities):
        seen.append(dict(capacities))
        if len(seen) >= 4:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    def refresh(day):
        refresh_calls.append(day)
        if len(refresh_calls) == 1:
            raise ConnectionError("metadata endpoint down")
        return {"NEW": 42}

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"OLD": 1}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
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

    def collect(conn, sources, capacities):
        seen.append(dict(capacities))
        if len(seen) >= 4:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    def boom(day):
        raise ConnectionError("metadata endpoint down")

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"OLD": 1}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
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

    def collect(conn, sources, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 4:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    def refresh(day):
        refresh_calls.append(day)
        return {"NEW": 42}

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {"OLD": 1}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
                               now_fn=clock.now_fn, archive=_no_archive, refresh_metadata=refresh)

    assert refresh_calls == [date(2026, 9, 5)], f"expected exactly one refresh call for the day, got {refresh_calls}"


# --- daily compaction into the cold store ------------------------------------
#
# Without this hook nothing ever calls compact_day, so `data/cold/` stays empty
# and prune -- which runs every slot against a 48h window -- silently makes the
# whole system a rolling two-day buffer that throws the training corpus away.


def _seed(conn, day, lot="A", free=10, motor=None, city="taipei", at=None):
    """One observation, namespaced the way the real adapters namespace theirs.

    `lot` is the feed's own id -- the bare form every assertion below reads back
    out of the published artifacts -- and `ids.qualify` puts it in the store the
    way `sources.<city>.parse` does. Seeding bare ids here and pairing them with
    a bare `_make_lot` would agree with itself and with nothing else: it is the
    blind spot that let `Lot.id` and `Observation.lot_id` drift apart once
    already (see the end-to-end test at the bottom of this file).
    """
    start, _ = day_bounds(day)
    ts = start if at is None else at
    lot_id = ids.qualify(city, lot)
    store.insert_snapshot(
        conn,
        FeedSnapshot(city, ts + 200, (Observation(lot_id, free, motor, ts, TS_FEED),)),
        {lot_id: 50},
    )


def _seed_legacy(conn, day, lot="A", free=10, at=None):
    """One observation with a BARE lot id, straight into the table.

    What the collector wrote before ids were namespaced. Compacted, this is what
    the live cold corpus actually holds -- and Parquet is never rewritten, so it
    holds it for good. A cold fixture built through `_seed` produces *namespaced*
    Parquet, which is a file shape the live corpus does not contain, and is
    blind to everything `ids.as_stored` exists for.
    """
    start, _ = day_bounds(day)
    ts = start if at is None else at
    conn.execute(
        "INSERT INTO observations (lot_id, city, data_ts, observed_at, free_car,"
        " free_motor, quality) VALUES (?, '', ?, ?, ?, NULL, 0)",
        (lot, ts, ts + 200, free),
    )


def test_previous_day_is_compacted_when_the_taipei_day_rolls_over(monkeypatch):
    """The rollover is the only moment the finished day is both complete and unpruned."""
    archived = []
    ticks = []
    # 23:59:30 Taipei: the first slot lands at 00:01:30 the next day.
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, sources, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 3:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
                              now_fn=clock.now_fn,
                              archive=lambda conn, day: archived.append(day))

    assert archived == [date(2026, 9, 4)], "exactly the day that just ended, exactly once"


def test_no_compaction_while_the_day_is_still_running(monkeypatch):
    """Compacting a day in progress would write a file that can never be completed."""
    archived = []
    ticks = []
    clock = _VirtualClock(int(datetime(2026, 9, 4, 2, 0, tzinfo=timezone.utc).timestamp()))
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, sources, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 4:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
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

    def collect(conn, sources, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 3:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
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

    def collect(conn, sources, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 4:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=flaky_archive)

    assert attempts == [date(2026, 9, 4), date(2026, 9, 4)], (
        "the same day must be retried, then archived exactly once more"
    )
    assert len(ticks) == 4, "collection must continue through a compaction failure"


def test_prune_keeps_a_day_whose_compaction_keeps_failing(monkeypatch):
    """Prune must never delete rows no Parquet file holds.

    Compaction stops at its first failure, but prune used to run regardless with
    a cutoff of now - 48h. A day whose compaction failed for about a day was
    therefore deleted from the hot store with no cold copy -- gone for good.
    Found by the 2026-09-14 security review.
    """
    cutoffs = []
    ticks = []
    # 23:59:30 Taipei on 2026-09-04; compaction of 09-04 is due at the rollover.
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))

    def fake_prune(conn, cutoff_ts):
        cutoffs.append(cutoff_ts)
        return 0

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    def always_fails(conn, day):
        raise OSError("disk full")

    def collect(conn, sources, capacities):
        ticks.append(clock.now)
        # Three days of slots: well past the point where now - 48h passes the
        # start of 2026-09-04.
        if len(ticks) > 3 * 288:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=always_fails)

    unarchived_start, _ = day_bounds(date(2026, 9, 4))
    assert clock.now - config.HOT_RETENTION_SEC > unarchived_start, "scenario must reach the old failure"
    assert max(cutoffs) <= unarchived_start, "prune reached into a day that was never archived"


def test_prune_uses_the_normal_window_once_days_are_archived(monkeypatch):
    seen = []  # (now at the prune, cutoff it used)
    clock = _VirtualClock(int(datetime(2026, 9, 4, 15, 59, 30, tzinfo=timezone.utc).timestamp()))

    def fake_prune(conn, cutoff_ts):
        seen.append((clock.now, cutoff_ts))
        if len(seen) > 3 * 288:
            raise _StopLoop()
        return 0

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    def collect(conn, sources, capacities):
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=_no_archive)

    now_at_prune, cutoff = seen[-1]
    assert cutoff == now_at_prune - config.HOT_RETENTION_SEC


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

    def collect(c, sources, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 2:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    try:
        with pytest.raises(_StopLoop):
            scheduler.run_forever(conn, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
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

    def stalled(conn, sources, capacities):
        attempts.append(clock.now)
        # Safety net: a loop that never exits must fail this test, not hang it.
        if len(attempts) > 2 * expected:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=1788484080, rows_written=0, advanced=False)]

    with pytest.raises(SystemExit) as exc:
        scheduler.run_forever(None, {}, collect=stalled, sources=_ONE_SOURCE, sleep=clock.sleep,
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

    def collect(conn, sources, capacities):
        slot = len(slots)
        if slot == limit - 1:
            return [TickResult(city="taipei", data_ts=slot, rows_written=1, advanced=True)]
        if slot >= 2 * limit - 1:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=0, rows_written=0, advanced=False)]

    # Reaching _StopLoop at all proves SystemExit never fired: without the
    # reset, a run of 11 exhausted slots either side of one good tick would
    # trip the threshold.
    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=_no_archive)


# --- multi-city retry and per-city stall tracking ----------------------------
#
# Every test above models exactly one city (`_ONE_SOURCE`), so none of them
# could ever exercise "advanced if ANY source advanced" against a genuine
# mix of results -- the exact gap a review found: Kaohsiung and Taoyuan stamp
# every observation `data_ts=now`, so they report `advanced=True` on every
# successful fetch and can never themselves need (or show) a retry. With a
# single source in every existing test, "retry only the sources that did not
# advance" and "break once nothing is left pending" both degenerate to the
# old single-global-counter behaviour -- which is exactly why it took a
# multi-source result list to surface the bug in the first place.


def test_only_the_staller_is_retried_once_another_city_has_advanced(monkeypatch):
    """A city that already produced a fresh reading this slot must not be
    re-asked, and a stalling city must not cost the others a retry either."""
    clock = _VirtualClock(1788484080)
    # Mocked even though this test expects to reach _StopLoop before either is
    # ever called for real: under the pre-fix "any advance breaks the loop"
    # behaviour, the second `collect()` call below happens one slot later
    # (not as a same-slot retry), so this slot's archive/prune would run
    # first with a bare `None` connection -- this keeps the test's failure
    # mode a clean assertion, not an unrelated `None.execute()` crash.
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)
    sources = [SimpleNamespace(city="taipei"), SimpleNamespace(city="tainan")]
    calls = []

    def collect(conn, sources, capacities):
        calls.append(sorted(s.city for s in sources))
        if len(calls) == 1:
            return [
                TickResult(city="taipei", data_ts=1, rows_written=1, advanced=True),
                TickResult(city="tainan", data_ts=0, rows_written=0, advanced=False),
            ]
        raise _StopLoop()

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=sources,
                              sleep=clock.sleep, now_fn=clock.now_fn, archive=_no_archive)

    assert calls[0] == ["tainan", "taipei"], "every source is asked on the first attempt"
    assert calls[1] == ["tainan"], "taipei already advanced this slot; only the staller is retried"


def test_taipei_alone_stalling_trips_the_exit_even_if_another_city_advances(monkeypatch):
    """Taipei's corpus cannot be re-fetched, so its own stall must be able to
    exit the process on its own -- a healthy second city must not mask it."""
    clock = _VirtualClock(1788484080)
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)
    sources = [SimpleNamespace(city="taipei"), SimpleNamespace(city="tainan")]
    attempts = []

    def collect(conn, sources, capacities):
        attempts.append(clock.now)
        # tainan advances every attempt of every slot; taipei never does.
        return [
            TickResult(city="taipei", data_ts=0, rows_written=0, advanced=False),
            TickResult(city="tainan", data_ts=len(attempts), rows_written=1, advanced=True),
        ]

    with pytest.raises(SystemExit) as exc:
        scheduler.run_forever(None, {}, collect=collect, sources=sources,
                              sleep=clock.sleep, now_fn=clock.now_fn, archive=_no_archive)

    assert exc.value.code, "must exit non-zero, or Docker will not restart it"
    assert "taipei" in str(exc.value)
    assert "every tracked source" not in str(exc.value), (
        "tainan never stalled; this must be the taipei-alone branch, not the all-stalled one"
    )
    assert len(attempts) == config.MAX_EXHAUSTED_SLOTS * (1 + len(config.RETRY_DELAYS_SEC)), (
        "taipei alone is retried every attempt of every slot until the threshold trips"
    )


def test_a_non_taipei_city_stalling_alone_does_not_trip_the_exit(monkeypatch):
    """Every city besides Taipei is, in principle, replaceable -- one of them
    stalling in isolation must not be able to cost the process a restart the
    way Taipei's own stall does."""
    clock = _VirtualClock(1788484080)
    sources = [SimpleNamespace(city="taipei"), SimpleNamespace(city="tainan")]
    slots = []

    def collect(conn, sources, capacities):
        # taipei advances every attempt of every slot; tainan never does.
        return [
            TickResult(city="taipei", data_ts=len(slots), rows_written=1, advanced=True),
            TickResult(city="tainan", data_ts=0, rows_written=0, advanced=False),
        ]

    def fake_prune(conn, cutoff_ts):
        slots.append(cutoff_ts)
        # Reaching this proves SystemExit never fired: with the old single
        # global counter this many consecutive non-advancing slots for one
        # source would have tripped the threshold twice over.
        if len(slots) > 2 * config.MAX_EXHAUSTED_SLOTS:
            raise _StopLoop()
        return 0

    monkeypatch.setattr(scheduler.store, "prune", fake_prune)

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=sources,
                              sleep=clock.sleep, now_fn=clock.now_fn, archive=_no_archive)


def test_every_tracked_city_stalling_together_trips_the_exit(monkeypatch):
    """The direct generalisation of the old single global counter: every
    source stalling for the same window at once must still exit."""
    clock = _VirtualClock(1788484080)
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)
    sources = [SimpleNamespace(city="taipei"), SimpleNamespace(city="tainan")]
    attempts = []

    def collect(conn, sources, capacities):
        attempts.append(clock.now)
        return [
            TickResult(city="taipei", data_ts=0, rows_written=0, advanced=False),
            TickResult(city="tainan", data_ts=0, rows_written=0, advanced=False),
        ]

    with pytest.raises(SystemExit) as exc:
        scheduler.run_forever(None, {}, collect=collect, sources=sources,
                              sleep=clock.sleep, now_fn=clock.now_fn, archive=_no_archive)

    assert exc.value.code, "must exit non-zero, or Docker will not restart it"
    assert "every tracked source" in str(exc.value)
    assert len(attempts) == config.MAX_EXHAUSTED_SLOTS * (1 + len(config.RETRY_DELAYS_SEC))


# --- publishing forecast artifacts -------------------------------------------


def test_publish_runs_after_an_advancing_tick(monkeypatch):
    """publish is None by default (every test above passes none), so wiring it
    in must not disturb any existing behaviour -- it must only fire once per
    tick that actually advanced."""
    published = []
    clock = _VirtualClock(1788537600)
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, sources, capacities):
        if len(published) >= 2:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=_no_archive,
                              publish=lambda conn, rosters: published.append(clock.now))

    assert len(published) == 2


def test_publish_failure_does_not_stop_collection(monkeypatch):
    """Collection is irreplaceable; a failed publish just means the artifacts
    are stale for one more tick. It must never be able to take collection down."""
    ticks = []
    clock = _VirtualClock(1788537600)
    monkeypatch.setattr(scheduler.store, "prune", lambda *a, **k: 0)

    def collect(conn, sources, capacities):
        ticks.append(clock.now)
        if len(ticks) >= 3:
            raise _StopLoop()
        return [TickResult(city="taipei", data_ts=clock.now, rows_written=1, advanced=True)]

    def boom(conn, rosters):
        raise RuntimeError("artifact write failed")

    with pytest.raises(_StopLoop):
        scheduler.run_forever(None, {}, collect=collect, sources=_ONE_SOURCE, sleep=clock.sleep,
                              now_fn=clock.now_fn, archive=_no_archive, publish=boom)

    assert len(ticks) == 3, "collection must survive a publishing failure"


# --- publish_artifacts must never blank good artifacts -----------------------


def _make_lot(lot_id: str, *, serves_cars: bool = True,
              capacity_car: int | None = 50, city: str = "taipei",
              lat: float = 25.05, lon: float = 121.52) -> Lot:
    """A Lot with a namespaced id, as `metadata.parse_metadata` produces.

    `lot_id` is the bare feed id, matching `_seed`'s: the two have to agree,
    because `publish_city` filters lots with `lot.id in history.counts.lot`.
    """
    return Lot(id=ids.qualify(city, lot_id), name=f"lot {lot_id}", area="中正區",
               lot_type="立體", capacity_car=capacity_car, lat=lat, lon=lon,
               service_time="00:00:00-23:59:59", fare_text="每小時30元",
               serves_cars=serves_cars)


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


def test_publish_artifacts_refuses_an_all_null_hot_window(tmp_path, monkeypatch, caplog):
    """Every reading in the hot window NULL, beside an intact cold corpus.

    Two ways in: the feed returns -9 for the whole city, or a fresh hot store is
    restored next to a cold one that survived. Either way `recent` -- which is
    hot-only on the serving path -- is empty, so `latest_ts` is 0. The row filter
    reads `counts.lot`, which is full from cold, so the roster looks healthy and
    neither existing guard fires. `build_grid` would then evaluate every horizon
    against Thursday 08:05 Taipei 1970 and publish it stamped `base_data_ts: 0`.
    """
    from parkcast.compact import compact_day

    cold = tmp_path / "cold"
    monkeypatch.setattr(config, "PARQUET_DIR", cold)
    src = store.connect(tmp_path / "src.sqlite")
    for lot_id in ("A", "B"):
        _seed(src, date(2026, 9, 3), lot=lot_id)
    compact_day(src, date(2026, 9, 3), cold)
    src.close()

    conn = store.connect(tmp_path / "t.sqlite")
    for lot_id in ("A", "B"):                       # the feed said -9 for everything
        _seed(conn, date(2026, 9, 4), lot=lot_id, free=None)

    out_dir = tmp_path / "artifacts"
    out_dir.mkdir()
    # Deliberately not a real grid header, so `read_header` returns None and the
    # collapsed-lot-count guard cannot be what saves us here.
    (out_dir / "grid.bin").write_bytes(b"OLD-GRID-BYTES-18")
    (out_dir / "lots.json").write_text('{"lots":[{"i":0,"id":"OLD"}]}', encoding="utf-8")

    with caplog.at_level(logging.ERROR, logger="parkcast.scheduler"):
        scheduler.publish_artifacts(conn, [_make_lot("A"), _make_lot("B")], out_dir)
    conn.close()

    assert (out_dir / "grid.bin").read_bytes() == b"OLD-GRID-BYTES-18"
    assert (out_dir / "lots.json").read_text(encoding="utf-8") == (
        '{"lots":[{"i":0,"id":"OLD"}]}'
    )
    assert list(out_dir.glob("*.tmp")) == []
    assert "no usable reading" in caplog.text


def test_publish_artifacts_stamps_the_real_data_ts_on_a_normal_publish(tmp_path):
    """The guard must not cost the happy path: a hot window with readings in it
    publishes, stamped with the newest data_ts and never with 0."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), lot="A")
    start, _ = day_bounds(date(2026, 9, 4))
    out_dir = tmp_path / "artifacts"
    out_dir.mkdir()

    scheduler.publish_artifacts(conn, [_make_lot("A")], out_dir)
    conn.close()

    header = artifacts.decode_header((out_dir / "grid.bin").read_bytes())
    assert header["base_data_ts"] == start
    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    assert doc["base_data_ts"] == start


def test_publish_artifacts_keeps_a_lot_whose_history_is_only_in_the_cold_store(
    tmp_path, monkeypatch
):
    """The row filter asks whether a lot has ever produced a usable observation,
    which is a question about the whole corpus, not about the retained tail.

    `History.recent` is a two-hour tail fed from the hot store, so filtering on
    it would silently drop every lot the hot store has pruned past -- lots that
    still get an honest climatology-only forecast and belong on the map.
    """
    from parkcast.compact import compact_day

    cold = tmp_path / "cold"
    monkeypatch.setattr(config, "PARQUET_DIR", cold)

    src = store.connect(tmp_path / "src.sqlite")
    # Bare, as a day compacted before namespacing holds it. `publish_city`
    # keeps a lot with `lot.id in counts.lot`, and `Lot.id` is namespaced, so
    # this lot is on the map only because the cold read normalises its id.
    _seed_legacy(src, date(2026, 9, 3), lot="COLDONLY")
    compact_day(src, date(2026, 9, 3), cold)
    src.close()

    conn = store.connect(tmp_path / "t.sqlite")   # hot holds only lot A
    _seed(conn, date(2026, 9, 4), lot="A")
    out_dir = tmp_path / "artifacts"
    out_dir.mkdir()

    scheduler.publish_artifacts(conn, [_make_lot("A"), _make_lot("COLDONLY")], out_dir)
    conn.close()

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    assert [l["id"] for l in doc["lots"]] == ["A", "COLDONLY"]


def test_publish_artifacts_drops_a_lot_with_no_car_capacity(tmp_path):
    """A motorcycle park is not a car park, however much history it has.

    Measured 2026-09-07: 14 lots in the published roster declare totalcar 0, and
    eight publish a 98-100% chance of a car space. The feed's free_car for them
    is not a small error -- TPE1697 has 14 motorcycle bays and reports 25-31 free
    cars -- so the answer is not merely imprecise, it is about a different
    vehicle. `serves_cars` is the only thing that keeps them out; history alone
    would let every one of them through.
    """
    conn = store.connect(tmp_path / "t.sqlite")
    for lot_id in ("A", "MOTORCYCLE", "Z"):
        _seed(conn, date(2026, 9, 4), lot=lot_id)
    out_dir = tmp_path / "artifacts"

    scheduler.publish_artifacts(
        conn,
        [_make_lot("A"),
         _make_lot("MOTORCYCLE", serves_cars=False, capacity_car=None),
         _make_lot("Z")],
        out_dir,
    )
    conn.close()

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    header = artifacts.decode_header((out_dir / "grid.bin").read_bytes())
    ids = [l["id"] for l in doc["lots"]]

    assert ids == ["A", "Z"], "the zero-car lot must not be published"
    # The roster has to stay internally consistent, which is what roster_id is
    # for: grid rows, header and lots.json must all describe the same two lots.
    assert header["n_lots"] == doc["n_lots"] == len(ids) == 2
    assert header["roster_id"] == doc["roster_id"] == artifacts.roster_id(ids)
    grid_bytes = (out_dir / "grid.bin").stat().st_size
    assert grid_bytes == artifacts.HEADER_SIZE + 2 * config.HORIZON_COUNT


def test_publish_artifacts_keeps_a_lot_whose_car_capacity_is_unknown(tmp_path):
    """-9 or a missing totalcar means unknown, and an unknown car park is still
    a car park. Dropping it would trade one wrong answer for a missing one."""
    conn = store.connect(tmp_path / "t.sqlite")
    for lot_id in ("A", "UNKNOWNCAP"):
        _seed(conn, date(2026, 9, 4), lot=lot_id)
    out_dir = tmp_path / "artifacts"

    scheduler.publish_artifacts(
        conn,
        [_make_lot("A"), _make_lot("UNKNOWNCAP", serves_cars=True, capacity_car=None)],
        out_dir,
    )
    conn.close()

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    assert [l["id"] for l in doc["lots"]] == ["A", "UNKNOWNCAP"]
    assert doc["lots"][1]["c"] is None


def test_publish_artifacts_withholds_a_lot_that_is_not_updating(tmp_path):
    """Measured 2026-09-14: 120 of 1,090 published lots had not changed their
    reading in over 24 hours, and the app gave them a confident 0% or 100%.
    They stay on the roster -- a missing car park is invisible -- with no
    forecast in any column, and lots.json says when they last updated."""
    conn = store.connect(tmp_path / "t.sqlite")
    conn.execute("PRAGMA synchronous=OFF")    # 313 ticks; durability is not under test
    start, _ = day_bounds(date(2026, 9, 4))
    for i in range(26 * 12 + 1):
        ts = start + i * 300
        store.insert_snapshot(
            conn,
            FeedSnapshot("taipei", ts + 200,
                         (Observation("taipei:FROZEN", 34, None, ts, TS_FEED),
                          Observation("taipei:LIVE", i % 7, None, ts, TS_FEED))),
            {"taipei:FROZEN": 50, "taipei:LIVE": 50},
        )
    out_dir = tmp_path / "artifacts"

    scheduler.publish_artifacts(conn, [_make_lot("FROZEN"), _make_lot("LIVE")], out_dir)
    conn.close()

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    body = (out_dir / "grid.bin").read_bytes()[artifacts.HEADER_SIZE:]
    n = config.HORIZON_COUNT
    row = {l["id"]: body[l["i"] * n:(l["i"] + 1) * n] for l in doc["lots"]}

    assert [l["id"] for l in doc["lots"]] == ["FROZEN", "LIVE"], "withheld, not dropped"
    assert set(row["FROZEN"]) == {UNKNOWN}, "every horizon must say 'no forecast', never a number"
    assert UNKNOWN not in row["LIVE"], "a live lot keeps its forecast"
    assert doc["lots"][0]["u"] == start
    assert "u" not in doc["lots"][1]
    assert doc["base_data_ts"] == start + 26 * 12 * 300


class _RecordingUploader:
    def __init__(self):
        self.offers = []

    def offer(self, grid, lots, *, base_data_ts, roster_id):
        self.offers.append((grid, lots, base_data_ts, roster_id))


def test_publish_artifacts_hands_the_published_bytes_to_the_uploader(tmp_path):
    """What goes to the site must be byte-identical to what was published here."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), lot="A")
    out_dir = tmp_path / "artifacts"
    up = _RecordingUploader()

    scheduler.publish_artifacts(conn, [_make_lot("A")], out_dir, uploader=up)
    conn.close()

    assert len(up.offers) == 1
    grid, lots, base_data_ts, roster = up.offers[0]
    assert grid == (out_dir / "grid.bin").read_bytes()
    assert lots == (out_dir / "lots.json").read_bytes()
    header = artifacts.decode_header(grid)
    assert (base_data_ts, roster) == (header["base_data_ts"], header["roster_id"])


def test_publish_artifacts_offers_nothing_when_it_refuses_to_publish(tmp_path):
    conn = store.connect(tmp_path / "t.sqlite")  # no observations: publishing refuses
    up = _RecordingUploader()

    scheduler.publish_artifacts(conn, [_make_lot("A")], tmp_path / "artifacts", uploader=up)
    conn.close()

    assert up.offers == []


def test_publish_artifacts_stamps_each_lots_free_count_at_the_reading(tmp_path):
    """The count on the card is the one behind the forecast -- the reading at base_data_ts."""
    conn = store.connect(tmp_path / "t.sqlite")
    _seed(conn, date(2026, 9, 4), lot="A", free=12)
    out_dir = tmp_path / "artifacts"
    out_dir.mkdir()

    scheduler.publish_artifacts(conn, [_make_lot("A")], out_dir)
    conn.close()

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    assert doc["lots"][0]["f"] == 12


# --- end-to-end: real adapters and real metadata through publish_artifacts --
#
# Every test above builds both sides -- the seeded observations and the Lot
# list -- from the same hand-written bare id (`_seed(conn, ..., lot="A")`
# paired with `_make_lot("A")`). That is internally consistent and therefore
# structurally blind to an id-*convention* split between the two: it cannot
# distinguish "ids agree because they're both right" from "ids agree because
# the test typed the same string twice." `sources.taipei.parse` has namespaced
# `Observation.lot_id` since Task 4 (`ids.qualify("taipei", raw_id)`);
# `metadata.parse_metadata` produced bare `Lot.id` until this fix, so
# `publish_artifacts`'s `lot.id in history.counts.lot` filter (scheduler.py:108)
# matched nothing, `ordered` came back empty, the "no lots survived" guard
# fired, and publishing silently stopped on every real tick -- while the
# collector process kept running and looked perfectly healthy. This test
# drives both sides through the real production code paths instead.

AVAIL_FIXTURE = Path(__file__).parent / "fixtures" / "avail_sample.json"
DESC_FIXTURE = Path(__file__).parent / "fixtures" / "desc_sample.json"


def test_publish_artifacts_end_to_end_with_the_real_taipei_adapters(tmp_path):
    """Observations from the real availability parser, lots from the real
    metadata parser -- not the same hand-typed id on both sides."""
    avail_payload = json.loads(AVAIL_FIXTURE.read_text(encoding="utf-8"))
    tick = taipei.parse(avail_payload, now=1788485010)

    desc_payload = json.loads(DESC_FIXTURE.read_text(encoding="utf-8"))
    lots = parse_metadata(desc_payload)
    caps = capacity_map(lots)

    # The capacity map must actually resolve a known lot, not silently default
    # every one of them to NO_CAPACITY the way a bare/namespaced mismatch
    # would (every lookup below would miss and this would read None). TPE0001
    # is a real lot present in both fixtures, with a real, non-null capacity.
    assert caps["taipei:TPE0001"] == 17, "a known lot's capacity must be found, not defaulted"

    conn = store.connect(tmp_path / "hot.sqlite")
    written = store.insert_snapshot(conn, tick.snapshot, caps)
    assert written == len(tick.snapshot.observations) == 1174

    # Confirms the capacity actually joined during the insert, not just that
    # the dict has the right key: TPE0001 reports 9 free against a capacity
    # of 17 (comfortably inside bounds), so its stored quality must be plain
    # OK -- neither NO_CAPACITY (the map missed it) nor CLAMPED (it would take
    # a coincidence to produce that from an unrelated mismatch).
    quality = conn.execute(
        "SELECT quality FROM observations WHERE lot_id = 'taipei:TPE0001'"
    ).fetchone()[0]
    assert Q(quality) == Q.OK

    out_dir = tmp_path / "artifacts"
    scheduler.publish_artifacts(conn, lots, out_dir)
    conn.close()

    # Before the fix this returned with nothing written at all -- the "no
    # lots survived the history filter" guard refuses silently rather than
    # publishing an empty grid, so the failure mode is a missing file, not a
    # wrong one. 1069 is every lot from this tick that reported a real
    # free_car, is present in the metadata roster, and serves cars -- computed
    # by running this exact path once against the fixtures and pinned here so
    # a future regression shows up as a row-count change, not just "empty".
    grid_path = out_dir / "grid.bin"
    assert grid_path.exists(), "publishing must not have refused"
    header = artifacts.decode_header(grid_path.read_bytes())
    assert header["n_lots"] == 1069

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    assert doc["n_lots"] == len(doc["lots"]) == 1069
    assert doc["roster_id"] == header["roster_id"]


# --- six cities in one store: one shard each, and Taipei's bytes unmoved -----
#
# Every test above this line models one city, and a single-city fixture is
# structurally blind to the defect this section exists to pin. Publishing used
# to read the store unscoped: `forecast.load_history` takes `latest_ts` as a
# global maximum over every lot in the store, and Kaohsiung and Taoyuan stamp
# `data_ts = now` (TS_FETCH -- their feeds carry no per-record timestamp), which
# is always later than Taipei's feed timestamp. So with either of them
# collecting, *no Taipei lot is ever at `latest_ts`*:
#
#   * `History.current` holds only their lots, so `Persistence.predict` returns
#     None for all ~1,082 of Taipei's and `Blend` degrades to climatology-only
#     at every horizon -- silently, because climatology produces entirely
#     plausible bytes. The short-horizon signal the app exists to provide is
#     simply gone.
#   * `store.free_at(conn, latest_ts)` matches no Taipei row, so the observed
#     count `f` disappears from all ~1,069 published lots.
#   * `base_data_ts` is stamped with another city's clock, telling clients the
#     reading is fresher than it is.
#
# None of that is visible with one city in the store, which is why it survived
# review. Every fixture below therefore seeds a second, fetch-stamped city.

PINNED_GENERATED_AT = 1_788_600_000
SEED_DAY = date(2026, 9, 4)


@pytest.fixture
def pinned_clock(monkeypatch):
    """Freeze `generated_at`.

    It is the one published field that is not a function of the input, so two
    publishes of identical data differ only here. Pinning it is what lets a
    byte-for-byte comparison mean anything.
    """
    monkeypatch.setattr(scheduler.time, "time", lambda: PINNED_GENERATED_AT)
    return PINNED_GENERATED_AT


def _seed_taipei(conn) -> int:
    """Two hours of Taipei's feed, ending on the tick where lot A fills up.

    Feed-stamped, so every `data_ts` is the reading's own moment -- which is
    exactly what makes Taipei lag the fetch-stamped cities below. A ends mostly
    free and then hits 0, so its persistence answer (0.0) and its climatology
    answer (nearly 1) are far apart: a grid that quietly lost persistence looks
    different from one that did not.
    """
    start, _ = day_bounds(SEED_DAY)
    for i in range(24):
        _seed(conn, SEED_DAY, lot="A", free=9, at=start + i * 300)
        _seed(conn, SEED_DAY, lot="B", free=4, at=start + i * 300)
    latest = start + 24 * 300
    _seed(conn, SEED_DAY, lot="A", free=0, at=latest)
    _seed(conn, SEED_DAY, lot="B", free=6, at=latest)
    return latest


def _seed_kaohsiung(conn, *, after: int) -> int:
    """Kaohsiung, stamped `data_ts = now`, strictly after Taipei's last reading."""
    latest = after
    for i in range(3):
        latest = after + 600 + i * 300
        _seed(conn, SEED_DAY, lot="K1", free=5, city="kaohsiung", at=latest)
        _seed(conn, SEED_DAY, lot="K2", free=0, city="kaohsiung", at=latest)
    return latest


TAIPEI_LOTS = [_make_lot("A"), _make_lot("B")]
KAOHSIUNG_LOTS = [_make_lot("K1", city="kaohsiung", lat=22.63, lon=120.30),
                  _make_lot("K2", city="kaohsiung", lat=22.61, lon=120.35)]


def test_taipei_shard_is_byte_identical_to_the_pre_change_artifacts(tmp_path, pinned_clock):
    """The live site must not notice this refactor. Same lots, same history,
    same generated_at -- the bytes must match what the single-city path wrote.

    The multi-city store is the point: it is the only fixture in which a global
    `latest_ts` diverges from Taipei's own, so it is the only one that can tell
    a correctly scoped publish from a climatology-only one. If these bytes
    differ, the refactor is wrong -- do not adjust the expectation.
    """
    multi = store.connect(tmp_path / "multi.sqlite")
    taipei_latest = _seed_taipei(multi)
    _seed_kaohsiung(multi, after=taipei_latest)
    multi_dir = tmp_path / "multi"
    scheduler.publish_artifacts(multi, TAIPEI_LOTS + KAOHSIUNG_LOTS, multi_dir)
    multi.close()

    solo = store.connect(tmp_path / "solo.sqlite")       # Taipei alone, as before
    assert _seed_taipei(solo) == taipei_latest
    solo_dir = tmp_path / "solo"
    scheduler.publish_artifacts(solo, TAIPEI_LOTS, solo_dir)
    solo.close()

    assert (multi_dir / "grid.bin").read_bytes() == (solo_dir / "grid.bin").read_bytes()
    assert (multi_dir / "lots.json").read_bytes() == (solo_dir / "lots.json").read_bytes()
    # Not vacuously equal: both really published.
    assert artifacts.decode_header((multi_dir / "grid.bin").read_bytes())["n_lots"] == 2


def _publish_multi_city(tmp_path):
    conn = store.connect(tmp_path / "multi.sqlite")
    taipei_latest = _seed_taipei(conn)
    kaohsiung_latest = _seed_kaohsiung(conn, after=taipei_latest)
    out_dir = tmp_path / "artifacts"
    scheduler.publish_artifacts(conn, TAIPEI_LOTS + KAOHSIUNG_LOTS, out_dir)
    conn.close()
    return out_dir, taipei_latest, kaohsiung_latest


def test_each_city_is_stamped_with_its_own_reading(tmp_path, pinned_clock):
    """`base_data_ts` says how stale the reading behind the forecast is. Stamped
    from a global maximum it would carry whichever city fetched last."""
    out_dir, taipei_latest, kaohsiung_latest = _publish_multi_city(tmp_path)

    assert taipei_latest < kaohsiung_latest, "the fixture must reproduce the skew"
    for grid, lots, expected in (("grid.bin", "lots.json", taipei_latest),
                                 ("grid-kaohsiung.bin", "lots-kaohsiung.json",
                                  kaohsiung_latest)):
        header = artifacts.decode_header((out_dir / grid).read_bytes())
        doc = json.loads((out_dir / lots).read_text(encoding="utf-8"))
        assert header["base_data_ts"] == expected
        assert doc["base_data_ts"] == expected, "the pair must agree"


def test_the_observed_count_survives_a_second_citys_later_clock(tmp_path, pinned_clock):
    """`f` is read at `base_data_ts`. Against a global maximum, `store.free_at`
    matched no Taipei row at all and the count vanished from every card."""
    out_dir, _, _ = _publish_multi_city(tmp_path)

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    rows = {row["id"]: row for row in doc["lots"]}
    assert rows["A"]["f"] == 0, "A reported zero free at the published reading"
    assert rows["B"]["f"] == 6


def test_taipeis_grid_is_not_silently_climatology_only(tmp_path, pinned_clock):
    """The failure this whole section is about produces a perfectly plausible
    grid -- every byte in range, no exception, no empty file. The only way to
    see it is to ask whether persistence contributed anything at all."""
    conn = store.connect(tmp_path / "multi.sqlite")
    taipei_latest = _seed_taipei(conn)
    _seed_kaohsiung(conn, after=taipei_latest)
    out_dir = tmp_path / "artifacts"
    scheduler.publish_artifacts(conn, TAIPEI_LOTS + KAOHSIUNG_LOTS, out_dir)

    history = by_city(load_history(conn, cold_dir=config.PARQUET_DIR))["taipei"]
    conn.close()

    assert history.latest_ts == taipei_latest
    for lot in TAIPEI_LOTS:
        assert Persistence(history).predict(lot.id, taipei_latest, 5) is not None, (
            f"{lot.id} must still have a current reading of its own"
        )

    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    body = (out_dir / "grid.bin").read_bytes()[artifacts.HEADER_SIZE:]
    row = {r["id"]: body[r["i"] * config.HORIZON_COUNT:(r["i"] + 1) * config.HORIZON_COUNT]
           for r in doc["lots"]}

    # A is 96% free across its history and full at the published reading, so
    # climatology alone and the blend cannot agree at the nearest horizon.
    climatology_only = Climatology(history).predict(
        ids.qualify("taipei", "A"), taipei_latest + 300, 5
    )
    assert row["A"][0] != round(climatology_only * 100), (
        "the +5 min byte is climatology alone -- persistence contributed nothing"
    )
    assert row["A"][0] < row["A"][-1], (
        "a lot that just filled up must recover toward climatology across the horizon"
    )


def test_each_city_gets_its_own_shard_and_taipei_keeps_the_original_names(tmp_path, pinned_clock):
    out_dir, _, _ = _publish_multi_city(tmp_path)

    assert {p.name for p in out_dir.glob("*") if p.is_file()} == {
        "grid.bin", "lots.json", "grid-kaohsiung.bin", "lots-kaohsiung.json",
        artifacts.CITIES_NAME,
    }
    taipei = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    kaohsiung = json.loads((out_dir / "lots-kaohsiung.json").read_text(encoding="utf-8"))
    assert [l["id"] for l in taipei["lots"]] == ["A", "B"], "published ids are bare"
    assert [l["id"] for l in kaohsiung["lots"]] == ["K1", "K2"]
    assert taipei["roster_id"] != kaohsiung["roster_id"]


def test_cities_json_indexes_every_shard_with_its_own_box(tmp_path, pinned_clock):
    out_dir, taipei_latest, kaohsiung_latest = _publish_multi_city(tmp_path)

    doc = json.loads((out_dir / artifacts.CITIES_NAME).read_text(encoding="utf-8"))
    assert doc["generated_at"] == PINNED_GENERATED_AT
    entries = {c["city"]: c for c in doc["cities"]}
    assert set(entries) == {"taipei", "kaohsiung"}
    assert entries["taipei"]["lots"] == entries["kaohsiung"]["lots"] == 2
    assert entries["taipei"]["base_data_ts"] == taipei_latest
    assert entries["kaohsiung"]["base_data_ts"] == kaohsiung_latest
    # The south edge of Taipei's box is north of Kaohsiung's north edge: a
    # client picking a shard by location must not be handed both.
    assert entries["taipei"]["bbox"][1] > entries["kaohsiung"]["bbox"][3]


def test_only_taipeis_bytes_are_offered_to_the_uploader(tmp_path, pinned_clock):
    """`upload.UPLOAD_PATH` is a single `/artifacts/latest`, and the deployed
    site serves Taipei. Six pairs would overwrite each other and spend the
    daily cap doing it."""
    conn = store.connect(tmp_path / "multi.sqlite")
    taipei_latest = _seed_taipei(conn)
    _seed_kaohsiung(conn, after=taipei_latest)
    out_dir = tmp_path / "artifacts"
    up = _RecordingUploader()

    scheduler.publish_artifacts(conn, TAIPEI_LOTS + KAOHSIUNG_LOTS, out_dir, uploader=up)
    conn.close()

    assert len(up.offers) == 1
    grid, lots, base_data_ts, _ = up.offers[0]
    assert grid == (out_dir / "grid.bin").read_bytes()
    assert lots == (out_dir / "lots.json").read_bytes()
    assert base_data_ts == taipei_latest


# --- every refusal is judged per city ---------------------------------------


def test_one_citys_collapse_does_not_stop_another_publishing(tmp_path, pinned_clock, caplog):
    """A partial restore, or a feed that came back with a handful of lots, is a
    fact about one source. Refusing the whole tick would take every other city's
    fresh reading off the map with it."""
    start, _ = day_bounds(SEED_DAY)
    taipei_ids = [f"T{i:03d}" for i in range(10)]
    kaohsiung_ids = [f"K{i:03d}" for i in range(10)]

    healthy = store.connect(tmp_path / "healthy.sqlite")
    for lot_id in taipei_ids:
        _seed(healthy, SEED_DAY, lot=lot_id, at=start)
    for lot_id in kaohsiung_ids:
        _seed(healthy, SEED_DAY, lot=lot_id, city="kaohsiung", at=start + 600)
    out_dir = tmp_path / "artifacts"
    lots = ([_make_lot(i) for i in taipei_ids]
            + [_make_lot(i, city="kaohsiung") for i in kaohsiung_ids])
    scheduler.publish_artifacts(healthy, lots, out_dir)
    healthy.close()
    good_kaohsiung = (out_dir / "grid-kaohsiung.bin").read_bytes()

    # Kaohsiung collapses to 3 of 10; Taipei is fine and gains a lot.
    thin = store.connect(tmp_path / "thin.sqlite")
    for lot_id in [*taipei_ids, "T010"]:
        _seed(thin, SEED_DAY, lot=lot_id, at=start + 900)
    for lot_id in kaohsiung_ids[:3]:
        _seed(thin, SEED_DAY, lot=lot_id, city="kaohsiung", at=start + 1500)
    thin_lots = ([_make_lot(i) for i in [*taipei_ids, "T010"]]
                 + [_make_lot(i, city="kaohsiung") for i in kaohsiung_ids[:3]])
    with caplog.at_level(logging.ERROR, logger="parkcast.scheduler"):
        scheduler.publish_artifacts(thin, thin_lots, out_dir)
    thin.close()

    assert (out_dir / "grid-kaohsiung.bin").read_bytes() == good_kaohsiung, (
        "the collapsed city must keep its good shard"
    )
    assert "kaohsiung: refusing to publish 3 lots" in caplog.text
    assert artifacts.decode_header((out_dir / "grid.bin").read_bytes())["n_lots"] == 11, (
        "Taipei must publish regardless of what happened to Kaohsiung"
    )
    assert list(out_dir.glob("*.tmp")) == []


def test_a_small_citys_roster_is_measured_against_its_own_published_shard(tmp_path, pinned_clock):
    """The floor is a fraction of what THIS city already published. Read from
    the wrong header -- Taipei's, under the shared `grid.bin` name -- every
    small city would be refused forever for the crime of being small."""
    conn = store.connect(tmp_path / "t.sqlite")
    start, _ = day_bounds(SEED_DAY)
    taipei_ids = [f"T{i:03d}" for i in range(100)]
    tainan_ids = ("N1", "N2", "N3", "N4")
    for lot_id in taipei_ids:
        _seed(conn, SEED_DAY, lot=lot_id, at=start)
    for lot_id in tainan_ids:
        _seed(conn, SEED_DAY, lot=lot_id, city="tainan", at=start)
    lots = ([_make_lot(i) for i in taipei_ids]
            + [_make_lot(i, city="tainan") for i in tainan_ids])
    out_dir = tmp_path / "artifacts"
    scheduler.publish_artifacts(conn, lots, out_dir)

    for lot_id in tainan_ids:            # a later tick, the same four lots
        _seed(conn, SEED_DAY, lot=lot_id, city="tainan", at=start + 300)
    scheduler.publish_artifacts(conn, lots, out_dir)
    conn.close()

    header = artifacts.decode_header((out_dir / "grid-tainan.bin").read_bytes())
    assert header["n_lots"] == 4
    assert header["base_data_ts"] == start + 300, (
        "Tainan's four lots are 4% of Taipei's roster and 100% of their own"
    )


def test_a_city_with_no_usable_reading_refuses_alone(tmp_path, monkeypatch, caplog):
    """A citywide -9 leaves one city's hot window entirely NULL. Judged against
    a global `latest_ts`, that city would sail through on another city's clock
    and publish its roster stamped with a timestamp none of its lots was read
    at -- the 1970 failure, wearing a plausible date."""
    from parkcast.compact import compact_day

    cold = tmp_path / "cold"
    monkeypatch.setattr(config, "PARQUET_DIR", cold)
    src = store.connect(tmp_path / "src.sqlite")
    for lot_id in ("A", "B"):                     # Taipei's corpus survives in cold
        _seed(src, date(2026, 9, 3), lot=lot_id)
    compact_day(src, date(2026, 9, 3), cold)
    src.close()

    conn = store.connect(tmp_path / "t.sqlite")
    start, _ = day_bounds(SEED_DAY)
    for lot_id in ("A", "B"):                     # the feed said -9 for all of Taipei
        _seed(conn, SEED_DAY, lot=lot_id, free=None, at=start)
    _seed(conn, SEED_DAY, lot="K1", free=5, city="kaohsiung", at=start + 600)
    out_dir = tmp_path / "artifacts"

    with caplog.at_level(logging.ERROR, logger="parkcast.scheduler"):
        scheduler.publish_artifacts(
            conn, TAIPEI_LOTS + [_make_lot("K1", city="kaohsiung")], out_dir
        )
    conn.close()

    assert not (out_dir / "grid.bin").exists(), "Taipei must refuse, not publish 1970"
    assert "taipei: no usable reading" in caplog.text
    assert artifacts.decode_header(
        (out_dir / "grid-kaohsiung.bin").read_bytes()
    )["base_data_ts"] == start + 600, "Kaohsiung is fine and must publish"


def test_a_city_whose_lots_all_fail_the_history_filter_refuses_alone(
    tmp_path, pinned_clock, caplog
):
    conn = store.connect(tmp_path / "t.sqlite")
    taipei_latest = _seed_taipei(conn)
    out_dir = tmp_path / "artifacts"

    # Tainan is in the metadata roster but has never been collected.
    with caplog.at_level(logging.WARNING, logger="parkcast.scheduler"):
        scheduler.publish_artifacts(
            conn, TAIPEI_LOTS + [_make_lot("N1", city="tainan")], out_dir
        )
    conn.close()

    assert "tainan: no lots survived the history filter" in caplog.text
    assert not (out_dir / "grid-tainan.bin").exists()
    assert artifacts.decode_header(
        (out_dir / "grid.bin").read_bytes()
    )["base_data_ts"] == taipei_latest
    indexed = json.loads((out_dir / artifacts.CITIES_NAME).read_text(encoding="utf-8"))
    assert [c["city"] for c in indexed["cities"]] == ["taipei"]


def test_cities_json_keeps_the_entry_of_a_city_that_refused(tmp_path, pinned_clock):
    """The refusing city's shard is still on disk and still good. Dropping its
    entry would hide a file the client can perfectly well use."""
    conn = store.connect(tmp_path / "t.sqlite")
    taipei_latest = _seed_taipei(conn)
    kaohsiung_latest = _seed_kaohsiung(conn, after=taipei_latest)
    out_dir = tmp_path / "artifacts"
    scheduler.publish_artifacts(conn, TAIPEI_LOTS + KAOHSIUNG_LOTS, out_dir)
    conn.close()

    # Next tick: Kaohsiung's metadata is missing entirely, so it is not even a
    # candidate. Its shard has not moved.
    later = store.connect(tmp_path / "later.sqlite")
    _seed_taipei(later)
    _seed(later, SEED_DAY, lot="A", free=3, at=taipei_latest + 300)
    _seed(later, SEED_DAY, lot="B", free=3, at=taipei_latest + 300)
    scheduler.publish_artifacts(later, TAIPEI_LOTS, out_dir)
    later.close()

    doc = json.loads((out_dir / artifacts.CITIES_NAME).read_text(encoding="utf-8"))
    entries = {c["city"]: c for c in doc["cities"]}
    assert set(entries) == {"taipei", "kaohsiung"}
    assert entries["kaohsiung"]["base_data_ts"] == kaohsiung_latest, "carried forward"
    assert entries["taipei"]["base_data_ts"] == taipei_latest + 300, "republished"
    assert (out_dir / "grid-kaohsiung.bin").exists()


def test_a_lot_with_an_unnamespaced_id_does_not_take_every_city_down(
    tmp_path, monkeypatch, pinned_clock
):
    """`Lot.id` has been namespaced since the metadata parser was fixed, so a
    bare one is a bug in whichever parser produced it. Grouping with the strict
    `ids.city_of` would raise on it -- and `run_forever` catches that, logs it
    and carries on collecting, so the result is every city's artifacts frozen
    while the collector goes on looking perfectly healthy. Exactly the failure
    the per-city refusals above exist to prevent, one level up.

    The cold corpus is what makes this test mean anything. Without it the stray
    id matches no key in `counts.lot` and never gets far enough to be dangerous.
    With a pre-namespacing Parquet day holding that very id, an un-normalised
    cold read puts a BARE key in `counts.lot`, the stray `Lot` matches it,
    survives the roster filter, and reaches `ids.bare` -- which raises, taking
    Taipei's publish down with it. Normalising on read is what keeps the
    outcome quiet: the cold key is `taipei:TPE9999`, the bare `Lot.id` matches
    nothing, and the lot is filtered out like any other without history.
    """
    from parkcast.compact import compact_day

    cold = tmp_path / "cold"
    monkeypatch.setattr(config, "PARQUET_DIR", cold)
    src = store.connect(tmp_path / "src.sqlite")
    _seed_legacy(src, date(2026, 9, 3), lot="TPE9999")
    compact_day(src, date(2026, 9, 3), cold)
    src.close()

    conn = store.connect(tmp_path / "t.sqlite")
    taipei_latest = _seed_taipei(conn)
    _seed_kaohsiung(conn, after=taipei_latest)
    stray = Lot(id="TPE9999", name="bare", area="", lot_type="", capacity_car=10,
                lat=25.05, lon=121.52, service_time="", fare_text="")
    out_dir = tmp_path / "artifacts"

    scheduler.publish_artifacts(conn, [*TAIPEI_LOTS, *KAOHSIUNG_LOTS, stray], out_dir)
    conn.close()

    assert artifacts.decode_header((out_dir / "grid.bin").read_bytes())["n_lots"] == 2
    assert artifacts.decode_header(
        (out_dir / "grid-kaohsiung.bin").read_bytes()
    )["n_lots"] == 2
    doc = json.loads((out_dir / "lots.json").read_text(encoding="utf-8"))
    assert [l["id"] for l in doc["lots"]] == ["A", "B"], (
        "the stray lot has no namespaced history, so it is filtered out, not published"
    )


def test_one_citys_unexpected_failure_does_not_cost_the_others_their_tick(
    tmp_path, pinned_clock, caplog
):
    """The per-city guards cover the ways a city is *expected* to decline. This
    is the net for the other kind -- and it has to be per city for the same
    reason `run_forever` nets the whole publish: a fresh reading missed is not
    recoverable, and one city's bug is no reason to spend five others' ticks."""
    real = scheduler.publish_city

    def explode(conn, city, *args, **kwargs):
        if city == "kaohsiung":
            raise RuntimeError("something nothing anticipated")
        return real(conn, city, *args, **kwargs)

    conn = store.connect(tmp_path / "t.sqlite")
    taipei_latest = _seed_taipei(conn)
    _seed_kaohsiung(conn, after=taipei_latest)
    out_dir = tmp_path / "artifacts"

    with caplog.at_level(logging.ERROR, logger="parkcast.scheduler"):
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(scheduler, "publish_city", explode)
            scheduler.publish_artifacts(conn, TAIPEI_LOTS + KAOHSIUNG_LOTS, out_dir)
    conn.close()

    assert "kaohsiung: publishing failed" in caplog.text
    assert not (out_dir / "grid-kaohsiung.bin").exists()
    assert artifacts.decode_header(
        (out_dir / "grid.bin").read_bytes()
    )["base_data_ts"] == taipei_latest, "Taipei must still have published"
    indexed = json.loads((out_dir / artifacts.CITIES_NAME).read_text(encoding="utf-8"))
    assert [c["city"] for c in indexed["cities"]] == ["taipei"]


def test_nothing_publishable_leaves_the_index_unwritten(tmp_path, pinned_clock):
    """An index listing no cities tells a client there is no coverage anywhere,
    which is worse than the missing file it already has to handle."""
    conn = store.connect(tmp_path / "t.sqlite")        # no observations at all
    out_dir = tmp_path / "artifacts"

    scheduler.publish_artifacts(conn, TAIPEI_LOTS, out_dir)
    conn.close()

    assert not (out_dir / artifacts.CITIES_NAME).exists()


def test_a_citys_liveness_window_is_its_own(tmp_path, monkeypatch, pinned_clock):
    """`window_start` is what a lot with NO reading in the window is dated to --
    "the latest it could have been". Taken globally it is the oldest moment in
    the STORE, so a city collecting for twenty minutes beside Taipei's 26 hours
    would have its silent lots dated 26 hours back and withheld on its very
    first tick, on the strength of another city's history.

    N2 is the lot that reaches the branch: it has corpus history, so it is on
    the roster, and its feed has returned -9 since Tainan was switched on, so
    `unchanged_run` has nothing to measure and `last_update` falls through to
    the window.
    """
    from parkcast.compact import compact_day

    cold = tmp_path / "cold"
    monkeypatch.setattr(config, "PARQUET_DIR", cold)
    src = store.connect(tmp_path / "src.sqlite")
    _seed(src, date(2026, 9, 3), lot="N2", free=5, city="tainan")
    compact_day(src, date(2026, 9, 3), cold)
    src.close()

    conn = store.connect(tmp_path / "t.sqlite")
    conn.execute("PRAGMA synchronous=OFF")    # 313 ticks; durability is not under test
    start, _ = day_bounds(SEED_DAY)
    for i in range(26 * 12 + 1):              # Taipei: 26 hours of hot window
        _seed(conn, SEED_DAY, lot="A", free=i % 7, at=start + i * 300)
    taipei_latest = start + 26 * 12 * 300
    assert taipei_latest - start > config.NOT_UPDATING_AFTER_SEC, (
        "Taipei's window must be old enough to withhold on, or this proves nothing"
    )
    # Tainan is switched on twenty minutes before the publish. N1 reports; N2's
    # feed has said -9 every tick since.
    for i in range(4):
        at = taipei_latest + 600 + i * 300
        _seed(conn, SEED_DAY, lot="N1", free=2 + i, city="tainan", at=at)
        _seed(conn, SEED_DAY, lot="N2", free=None, city="tainan", at=at)
    out_dir = tmp_path / "artifacts"

    scheduler.publish_artifacts(
        conn,
        [_make_lot("A"), _make_lot("N1", city="tainan"), _make_lot("N2", city="tainan")],
        out_dir,
    )
    conn.close()

    doc = json.loads((out_dir / "lots-tainan.json").read_text(encoding="utf-8"))
    rows = {row["id"]: row for row in doc["lots"]}
    assert set(rows) == {"N1", "N2"}, "N2 has cold history, so it belongs on the map"
    body = (out_dir / "grid-tainan.bin").read_bytes()[artifacts.HEADER_SIZE:]
    n = config.HORIZON_COUNT
    assert "u" not in rows["N2"], (
        "a lot from a city collecting for twenty minutes cannot be 26 hours stale"
    )
    assert UNKNOWN not in body[rows["N2"]["i"] * n:(rows["N2"]["i"] + 1) * n], (
        "withheld on another city's window, N2 would have no forecast at all"
    )
