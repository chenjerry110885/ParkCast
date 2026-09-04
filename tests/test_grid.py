from parkcast import config
from parkcast.grid import UNKNOWN, build_grid, horizons


class Fixed:
    """A forecaster returning a preset value per lot, or None."""
    def __init__(self, values):
        self.values = values
        self.calls = []

    def predict(self, lot_id, target_ts, horizon_min):
        self.calls.append((lot_id, target_ts, horizon_min))
        return self.values.get(lot_id)


def test_horizons_are_24_steps_of_5_minutes():
    h = horizons()
    assert len(h) == config.HORIZON_COUNT == 24
    assert h[0] == 5 and h[-1] == 120
    assert all(b - a == config.HORIZON_STEP_MIN for a, b in zip(h, h[1:]))


def test_grid_is_row_major_one_row_per_lot():
    grid = build_grid(Fixed({"A": 1.0, "B": 0.0}), ["A", "B"], 1000)
    assert len(grid) == 2 * 24
    assert set(grid[:24]) == {100}, "lot A's row is all 100"
    assert set(grid[24:]) == {0}, "lot B's row is all 0"


def test_probabilities_encode_as_percent():
    grid = build_grid(Fixed({"A": 0.375}), ["A"], 1000)
    assert set(grid) == {38}, "0.375 rounds to 38"


def test_none_encodes_as_unknown_not_zero():
    grid = build_grid(Fixed({}), ["GHOST"], 1000)
    assert set(grid) == {UNKNOWN}
    assert UNKNOWN != 0, "unknown must be distinguishable from 'certainly full'"


def test_target_timestamp_advances_with_the_horizon():
    f = Fixed({"A": 0.5})
    build_grid(f, ["A"], 1000)
    assert f.calls[0] == ("A", 1000 + 5 * 60, 5)
    assert f.calls[-1] == ("A", 1000 + 120 * 60, 120)


def test_out_of_range_probability_is_clamped_not_wrapped():
    """A future forecaster returning 1.2 must not encode as byte 120-ish nonsense."""
    grid = build_grid(Fixed({"A": 1.4}), ["A"], 1000)
    assert set(grid) == {100}
    grid = build_grid(Fixed({"A": -0.3}), ["A"], 1000)
    assert set(grid) == {0}


def test_lot_order_is_preserved_exactly():
    grid = build_grid(Fixed({"B": 1.0, "A": 0.0}), ["B", "A"], 1000)
    assert grid[0] == 100 and grid[24] == 0, "rows follow the given order, not sorted"
