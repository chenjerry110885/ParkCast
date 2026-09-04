import pytest

from parkcast import store
from parkcast.feed import FeedSnapshot, Observation
from parkcast.forecast import Persistence, load_history


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def write(conn, ts, lot="A", free=5, capacity=50):
    store.insert_snapshot(conn, FeedSnapshot(ts, ts + 200, (Observation(lot, free, None),)), {lot: capacity})


def test_history_separates_current_from_past(conn):
    write(conn, 1000, free=5)
    write(conn, 1300, free=9)
    h = load_history(conn)
    assert h.latest_ts == 1300
    assert h.current == {"A": 9}, "current must be the newest tick only"
    assert h.by_lot["A"] == [(1000, 5), (1300, 9)], "by_lot keeps the full ordered series"


def test_history_excludes_missing_readings(conn):
    write(conn, 1000, free=5)
    write(conn, 1300, free=None)
    h = load_history(conn)
    assert h.by_lot["A"] == [(1000, 5)], "NULL readings are absent, never coerced to 0"
    assert "A" not in h.current, "a lot whose newest reading is NULL has no current value"


def test_persistence_is_one_when_a_space_exists(conn):
    write(conn, 1000, free=5)
    assert Persistence(load_history(conn)).predict("A", 1600, 10) == 1.0


def test_persistence_is_zero_when_full(conn):
    write(conn, 1000, free=0)
    assert Persistence(load_history(conn)).predict("A", 1600, 10) == 0.0


def test_persistence_is_none_for_an_unknown_lot(conn):
    write(conn, 1000, free=5)
    assert Persistence(load_history(conn)).predict("NOPE", 1600, 10) is None


def test_persistence_ignores_the_horizon(conn):
    """Naive by design: it is the bar the model must clear, not a good forecast."""
    write(conn, 1000, free=5)
    p = Persistence(load_history(conn))
    assert p.predict("A", 1600, 5) == p.predict("A", 8200, 120)
