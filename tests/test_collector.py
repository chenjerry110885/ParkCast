import json
from pathlib import Path

import pytest

from parkcast import collector, store
from parkcast.feed import parse_updatetime

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


def test_tick_writes_rows_and_reports_advance(conn):
    result = collector.collect_once(conn, {}, now=fixture_observed_at(), fetch=fake_fetch)
    assert result.rows_written > 1000
    assert result.advanced is True
    assert store.count_rows(conn) == result.rows_written


def test_repeated_tick_writes_nothing_and_reports_no_advance(conn):
    first = collector.collect_once(conn, {}, now=fixture_observed_at(), fetch=fake_fetch)
    second = collector.collect_once(conn, {}, now=fixture_observed_at(520), fetch=fake_fetch)
    assert second.rows_written == 0
    assert second.advanced is False, "same data_ts means the feed has not published yet"
    assert store.count_rows(conn) == first.rows_written


def test_observed_at_uses_supplied_now_not_feed_time(conn):
    collector.collect_once(conn, {}, now=fixture_observed_at(), fetch=fake_fetch)
    data_ts, observed_at = conn.execute(
        "SELECT data_ts, observed_at FROM observations LIMIT 1"
    ).fetchone()
    assert observed_at == fixture_observed_at()
    assert data_ts != observed_at, "the two must never be collapsed"


def test_fetch_failure_propagates_rather_than_writing_partial_data(conn):
    def boom(_url, **_kwargs):
        raise ConnectionError("network down")

    with pytest.raises(ConnectionError):
        collector.collect_once(conn, {}, now=fixture_observed_at(), fetch=boom)
    assert store.count_rows(conn) == 0


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
