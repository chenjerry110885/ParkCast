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
