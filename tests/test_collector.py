import json
import logging
from pathlib import Path

import pytest

from parkcast import collector, store
from parkcast.feed import TS_FETCH, FeedSnapshot, Observation, parse_updatetime
from parkcast.ids import qualify
from parkcast.quality import Q
from parkcast.sources import SourceTick, taipei

FIXTURE = Path(__file__).parent / "fixtures" / "avail_sample.json"


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def fake_fetch(_url, **_kwargs):
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def fixture_observed_at(offset: int = 200) -> int:
    """A fetch time consistent with the fixture's own stamp; never hardcode this."""
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return parse_updatetime(payload["data"]["UPDATETIME"]) + offset


class _FixtureTaipeiSource:
    """Taipei's real `parse`, fed the fixture instead of a live HTTP call."""

    city = taipei.CITY

    def fetch(self, *, now):
        return taipei.parse(fake_fetch(taipei.URL), now=now)


def test_tick_writes_rows_and_reports_advance(conn):
    result = collector.collect_once(conn, _FixtureTaipeiSource(), {}, now=fixture_observed_at())
    assert result.city == "taipei"
    assert result.rows_written > 1000
    assert result.advanced is True
    assert store.count_rows(conn) == result.rows_written


def test_repeated_tick_writes_nothing_and_reports_no_advance(conn):
    source = _FixtureTaipeiSource()
    first = collector.collect_once(conn, source, {}, now=fixture_observed_at())
    second = collector.collect_once(conn, source, {}, now=fixture_observed_at(520))
    assert second.rows_written == 0
    assert second.advanced is False, "same data_ts means the feed has not published yet"
    assert store.count_rows(conn) == first.rows_written


def test_observed_at_uses_supplied_now_not_feed_time(conn):
    collector.collect_once(conn, _FixtureTaipeiSource(), {}, now=fixture_observed_at())
    data_ts, observed_at = conn.execute(
        "SELECT data_ts, observed_at FROM observations LIMIT 1"
    ).fetchone()
    assert observed_at == fixture_observed_at()
    assert data_ts != observed_at, "the two must never be collapsed"


def test_fetch_failure_propagates_rather_than_writing_partial_data(conn):
    class _BoomSource:
        city = "taipei"

        def fetch(self, *, now):
            raise ConnectionError("network down")

    with pytest.raises(ConnectionError):
        collector.collect_once(conn, _BoomSource(), {}, now=fixture_observed_at())
    assert store.count_rows(conn) == 0


# --- collect_all: every source collected, each one's failure isolated ------


class _StubSource:
    """A minimal `Source`: fakes one adapter's tick without touching the
    network. `lots=None`, like Taipei, so `collect_once` falls back to
    whatever `capacities` map `collect_all` was given -- irrelevant to the
    tests below, which only care about isolation."""

    def __init__(self, city, rows):
        self.city = city
        self._rows = rows

    def fetch(self, *, now):
        observations = tuple(
            Observation(qualify(self.city, raw_id), free_car, None, now, TS_FETCH)
            for raw_id, free_car in self._rows
        )
        snapshot = FeedSnapshot(city=self.city, observed_at=now, observations=observations)
        return SourceTick(snapshot=snapshot, lots=None)


def test_one_failing_city_does_not_stop_the_others(conn):
    good = _StubSource("tainan", rows=[("1", 5)])

    class Broken:
        city = "taoyuan"

        def fetch(self, *, now):
            raise collector.FeedError("boom")

    results = collector.collect_all(conn, [Broken(), good], {}, now=1000)

    assert [r.city for r in results] == ["tainan"]
    assert store.source_health(conn)["taoyuan"]["ok"] is False
    assert store.source_health(conn)["tainan"]["ok"] is True
    # Taipei is the only corpus that exists; a stranger's failure cannot touch it.
    assert conn.execute("SELECT COUNT(*) FROM observations WHERE city='tainan'").fetchone()[0] == 1


def test_collect_all_isolates_a_keyerror_from_a_reshaped_payload(conn):
    """Not just network trouble: a source whose parser blows up on a payload
    that changed shape overnight must be contained exactly the same way."""
    good = _StubSource("hsinchu", rows=[("A", 1)])

    class Reshaped:
        city = "newtaipei"

        def fetch(self, *, now):
            raise KeyError("data")

    results = collector.collect_all(conn, [Reshaped(), good], {}, now=1000)

    assert [r.city for r in results] == ["hsinchu"]
    assert store.source_health(conn)["newtaipei"]["ok"] is False
    assert conn.execute("SELECT COUNT(*) FROM observations WHERE city='hsinchu'").fetchone()[0] == 1


def test_collect_all_keeps_going_when_health_recording_fails_after_a_success(conn, monkeypatch):
    """A DB hiccup while recording health must not undo an already-committed
    tick, and must not abort collection of the sources still to come.

    Previously the post-success `SELECT COUNT(*)` and `record_source_health`
    call sat outside `collect_once`'s try/except entirely, so an exception
    from either of them would propagate straight out of `collect_all`,
    silently dropping every source not yet reached and discarding the
    results already accumulated -- the isolation guarantee was conditional,
    not absolute.
    """
    real_record = store.record_source_health
    calls = []

    def flaky_record(conn, city, **kwargs):
        calls.append(city)
        if city == "tainan":
            raise store.sqlite3.OperationalError("database is locked")
        return real_record(conn, city, **kwargs)

    monkeypatch.setattr(store, "record_source_health", flaky_record)

    results = collector.collect_all(
        conn,
        [_StubSource("tainan", rows=[("1", 5)]), _StubSource("hsinchu", rows=[("2", 3)])],
        {}, now=1000,
    )

    assert [r.city for r in results] == ["tainan", "hsinchu"], (
        "tainan's row is real and already committed -- a health-recording "
        "failure must not drop it from the results, and must not stop "
        "hsinchu from being collected right after it"
    )
    assert calls == ["tainan", "hsinchu"], "hsinchu must still be reached after tainan's failure"
    assert conn.execute("SELECT COUNT(*) FROM observations WHERE city='tainan'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM observations WHERE city='hsinchu'").fetchone()[0] == 1


def test_collect_all_never_raises_even_when_every_source_fails(conn):
    class Broken:
        city = "taoyuan"

        def fetch(self, *, now):
            raise RuntimeError("boom")

    results = collector.collect_all(conn, [Broken()], {}, now=1000)

    assert results == []
    assert store.source_health(conn)["taoyuan"]["ok"] is False


def test_collect_all_records_health_for_a_successful_source(conn):
    source = _StubSource("tainan", rows=[("1", 5), ("2", None)])

    collector.collect_all(conn, [source], {}, now=1000)

    health = store.source_health(conn)["tainan"]
    assert health["ok"] is True
    assert health["rows"] == 2
    assert health["usable"] == 1, "one of the two readings was a real count, the other None"
    assert health["last_ts"] == 1000


def test_collect_all_derives_each_citys_own_capacities_from_its_tick(conn):
    """The five roster-carrying cities must never be validated against
    Taipei's capacity map (or each other's) -- each supplies its own, fresh
    every tick, from `SourceTick.lots`."""
    from parkcast.metadata import Lot

    class WithRoster:
        city = "kaohsiung"

        def fetch(self, *, now):
            lot_id = qualify(self.city, "1")
            snapshot = FeedSnapshot(
                city=self.city, observed_at=now,
                observations=(Observation(lot_id, 8, None, now, TS_FETCH),),
            )
            lot = Lot(id=lot_id, name="x", area="", lot_type="", capacity_car=5,
                      lat=22.6, lon=120.3, service_time="", fare_text="")
            return SourceTick(snapshot=snapshot, lots=(lot,))

    # A capacities map for an unrelated city must not leak in and must not be
    # needed: capacity 5 comes from the tick's own roster and clamps free_car
    # from 8 down to 5.
    collector.collect_all(conn, [WithRoster()], {"taipei:1": 999}, now=1000)

    free_car, quality = conn.execute(
        "SELECT free_car, quality FROM observations WHERE city='kaohsiung'"
    ).fetchone()
    assert free_car == 5, "clamped against the roster carried in this tick, not the caller's map"
    assert Q.CLAMPED in Q(quality), "proves *why* free_car became 5, not just that it did"


def test_collect_once_warns_when_a_roster_carrying_source_has_no_lots(conn, caplog):
    """Adapters append the Observation before their own coordinate/roster
    check and the Lot only after, so a reshaped payload can yield real
    observations with `lots=()` alongside them -- silently falling back to an
    empty capacity map (every lot NO_CAPACITY) would say nothing about why."""
    class EmptyRoster:
        city = "kaohsiung"

        def fetch(self, *, now):
            lot_id = qualify(self.city, "1")
            snapshot = FeedSnapshot(
                city=self.city, observed_at=now,
                observations=(Observation(lot_id, 8, None, now, TS_FETCH),),
            )
            return SourceTick(snapshot=snapshot, lots=())

    with caplog.at_level(logging.WARNING, logger="parkcast.collector"):
        result = collector.collect_once(conn, EmptyRoster(), {}, now=1000)

    assert result.rows_written == 1, "the observation is still stored; this is a capacity warning, not a refusal"
    assert "kaohsiung" in caplog.text and "empty roster" in caplog.text

    free_car, quality = conn.execute(
        "SELECT free_car, quality FROM observations WHERE city='kaohsiung'"
    ).fetchone()
    assert free_car == 8, "unclamped: no capacity is known, not that one was found and exceeded"
    assert Q.NO_CAPACITY in Q(quality)


import requests as _requests


class _FakeResponse:
    def __init__(self, status=200, headers=None, chunks=(b'{"ok": true}',)):
        self.status_code = status
        self.headers = headers or {}
        self._chunks = chunks
        self.is_redirect = 300 <= status < 400 and "Location" in self.headers

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise _requests.HTTPError(str(self.status_code))

    def iter_content(self, chunk_size):
        yield from self._chunks


def _patch_get(monkeypatch, response, calls):
    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return response

    monkeypatch.setattr(collector.requests, "get", fake_get)


def test_fetch_json_streams_without_following_redirects(monkeypatch):
    calls = []
    _patch_get(monkeypatch, _FakeResponse(chunks=(b'{"a":', b" 1}")), calls)
    assert collector.fetch_json("https://example.test/x.json") == {"a": 1}
    _, kwargs = calls[0]
    assert kwargs["allow_redirects"] is False
    assert kwargs["stream"] is True
    assert kwargs["timeout"] == collector.config.HTTP_TIMEOUT_SEC


def test_fetch_json_refuses_a_redirect(monkeypatch):
    _patch_get(monkeypatch, _FakeResponse(302, {"Location": "http://10.0.0.1/"}), [])
    with pytest.raises(collector.FeedError):
        collector.fetch_json("https://example.test/x.json")


def test_fetch_json_refuses_a_declared_oversize_body(monkeypatch):
    _patch_get(monkeypatch, _FakeResponse(headers={"Content-Length": "2000"}), [])
    with pytest.raises(collector.FeedError):
        collector.fetch_json("https://example.test/x.json", max_bytes=1000)


def test_fetch_json_refuses_an_oversize_stream_without_a_length(monkeypatch):
    _patch_get(monkeypatch, _FakeResponse(chunks=(b"x" * 600, b"x" * 600)), [])
    with pytest.raises(collector.FeedError):
        collector.fetch_json("https://example.test/x.json", max_bytes=1000)


def test_fetch_json_still_raises_on_http_errors(monkeypatch):
    _patch_get(monkeypatch, _FakeResponse(503), [])
    with pytest.raises(_requests.HTTPError):
        collector.fetch_json("https://example.test/x.json")
