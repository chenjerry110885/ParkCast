import pytest

from parkcast.ids import (LEGACY_CITY, as_stored, bare, city_of,
                          city_of_stored, prefix_range, qualify)


def test_round_trips_and_keeps_colons_in_the_feed_id():
    assert qualify("taipei", "TPE0001") == "taipei:TPE0001"
    assert bare("taipei:TPE0001") == "TPE0001"
    assert city_of("taipei:TPE0001") == "taipei"
    # Kaohsiung ids contain no colon today, but a feed id that did must survive.
    assert bare("kaohsiung:PL:0001") == "PL:0001"


def test_rejects_an_unqualified_id():
    with pytest.raises(ValueError):
        city_of("TPE0001")


def test_as_stored_rewrites_a_legacy_id_and_leaves_a_namespaced_one_alone():
    """The cold Parquet corpus is never rewritten, so a day compacted before
    namespacing still says `TPE0001` where everything else says
    `taipei:TPE0001`. Those are one car park, and every join between the two
    halves of its history is a string comparison."""
    assert as_stored("TPE0001") == "taipei:TPE0001"
    assert as_stored("TPE0001") == qualify(LEGACY_CITY, "TPE0001")
    # A no-op for every file written since namespacing, including a feed id
    # that contains a colon of its own.
    assert as_stored("kaohsiung:PL:0001") == "kaohsiung:PL:0001"
    assert as_stored("taipei:TPE0001") == "taipei:TPE0001"


def test_as_stored_is_idempotent():
    """It runs on every cold row read; applying it twice must not double the
    prefix, or a re-read would invent a `taipei:taipei:` lot."""
    once = as_stored("TPE0001")
    assert as_stored(once) == once


def test_as_stored_agrees_with_the_id_the_roster_looks_up():
    """`publish_city` keeps a lot with `lot.id in counts.lot`, and `Lot.id`
    comes from `parse_metadata`, which qualifies with the same city."""
    assert as_stored("TPE0001") == qualify("taipei", "TPE0001")
    assert bare(as_stored("TPE0001")) == "TPE0001"
    assert city_of(as_stored("TPE0001")) == "taipei"


def test_city_of_stored_is_total_where_city_of_is_strict():
    """A backstop, not the fix. `as_stored` resolves a legacy id where the
    corpus is read; this only answers whose an id is, for wherever a bare one
    might still turn up, because raising there would stop publishing for every
    city at once while the collector went on looking healthy.
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
