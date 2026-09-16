import pytest

from parkcast.ids import bare, city_of, qualify


def test_round_trips_and_keeps_colons_in_the_feed_id():
    assert qualify("taipei", "TPE0001") == "taipei:TPE0001"
    assert bare("taipei:TPE0001") == "TPE0001"
    assert city_of("taipei:TPE0001") == "taipei"
    # Kaohsiung ids contain no colon today, but a feed id that did must survive.
    assert bare("kaohsiung:PL:0001") == "PL:0001"


def test_rejects_an_unqualified_id():
    with pytest.raises(ValueError):
        city_of("TPE0001")
