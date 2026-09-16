from parkcast.sources.geo import in_taiwan


def test_taipei_itself_is_in_bounds():
    assert in_taiwan(25.0330, 121.5654)


def test_kinmen_far_west_of_the_main_island_is_in_bounds():
    # Kinmen sits at roughly 24.44N, 118.32E -- well outside Taipei's own
    # box (config.LON_MIN=121.0), which is exactly why this box is wider.
    assert in_taiwan(24.44, 118.32)


def test_a_point_off_the_coast_of_japan_is_out_of_bounds():
    assert not in_taiwan(35.0, 139.0)


def test_null_island_is_out_of_bounds():
    assert not in_taiwan(0.0, 0.0)
