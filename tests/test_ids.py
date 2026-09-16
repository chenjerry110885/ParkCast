import pytest

from parkcast.ids import (LEGACY_CITY, bare, city_of, city_of_stored,
                          prefix_range, qualify)


def test_round_trips_and_keeps_colons_in_the_feed_id():
    assert qualify("taipei", "TPE0001") == "taipei:TPE0001"
    assert bare("taipei:TPE0001") == "TPE0001"
    assert city_of("taipei:TPE0001") == "taipei"
    # Kaohsiung ids contain no colon today, but a feed id that did must survive.
    assert bare("kaohsiung:PL:0001") == "PL:0001"


def test_rejects_an_unqualified_id():
    with pytest.raises(ValueError):
        city_of("TPE0001")


def test_city_of_stored_is_total_where_city_of_is_strict():
    """Ids read back out of the corpus, not out of a feed.

    Every day compacted before namespacing still holds bare `TPE0001` ids, and
    the cold Parquet corpus is never rewritten. Raising on those would take
    publishing down for every city at once -- a site that silently stops
    updating while the collector looks healthy -- so they are attributed to the
    only city that was being collected when they were written.
    """
    assert city_of_stored("taipei:TPE0001") == "taipei"
    assert city_of_stored("kaohsiung:PL:0001") == "kaohsiung"
    assert city_of_stored("TPE0001") == LEGACY_CITY == "taipei"
    with pytest.raises(ValueError):
        city_of("TPE0001")


def test_prefix_range_bounds_exactly_one_citys_ids():
    lo, hi = prefix_range("taipei")
    assert lo == "taipei:"
    for inside in ("taipei:TPE0001", "taipei:", "taipei:zzzz", "taipei:PL:1"):
        assert lo <= inside < hi
    # The bound is the code point after the separator, so nothing else fits.
    for outside in ("taipei", "taipeix:1", "taipei;1", "tainan:1", "taoyuan:1"):
        assert not (lo <= outside < hi)


def test_prefix_range_separates_cities_that_share_a_prefix():
    """`tai` is a prefix of taipei, tainan and taoyuan is not -- but taipei and
    a hypothetical `taipeicounty` would be, and a plain LIKE would confuse
    them."""
    lo, hi = prefix_range("taipei")
    assert not (lo <= "taipeicounty:1" < hi)
