from parkcast.quality import Q, clean_count, validate


def test_minus_nine_is_missing_not_zero():
    assert clean_count(-9) is None


def test_all_negatives_are_missing():
    for raw in (-1, -9, -99):
        assert clean_count(raw) is None, f"{raw} should be missing"


def test_zero_is_a_real_value_meaning_full():
    assert clean_count(0) == 0


def test_non_numeric_is_missing():
    assert clean_count(None) is None
    assert clean_count("") is None
    assert clean_count("abc") is None


def test_numeric_strings_are_accepted():
    assert clean_count("42") == 42


def test_validate_flags_missing():
    value, flags = validate(None, 50)
    assert value is None
    assert Q.MISSING in flags


def test_validate_clamps_impossible_overcount():
    value, flags = validate(80, 50)
    assert value == 50, "free spaces cannot exceed capacity"
    assert Q.CLAMPED in flags


def test_validate_flags_unknown_capacity_without_clamping():
    value, flags = validate(80, None)
    assert value == 80
    assert Q.NO_CAPACITY in flags
    assert Q.CLAMPED not in flags


def test_validate_clean_case_has_no_flags():
    value, flags = validate(16, 50)
    assert value == 16
    assert flags == Q.OK
