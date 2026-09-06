import pytest

from parkcast.pricing import Price, parse_fare


def test_a_single_hourly_rate_is_exact():
    p = parse_fare("計時：小型車100元/時，停車全程以半小時計。月租：小型車全日10,000元/月。")
    assert p == Price("exact", 100, 100)


def test_monthly_rent_is_never_read_as_an_hourly_rate():
    """月租 figures are in the thousands; mistaking one would be catastrophic."""
    p = parse_fare("計時：小型車40元/時。月租：小型車全日5,500元/月，夜間3,000元/月。")
    assert p == Price("exact", 40, 40)


def test_motorcycle_rates_are_never_read_as_the_car_rate():
    """機車 is ~NT$20 against a car's ~NT$100 — the error is large and silent."""
    p = parse_fare("計時：小型車100元/時；機車20元/時，每日上限100元。")
    assert p == Price("exact", 100, 100)


def test_a_varying_rate_becomes_a_range_not_a_guess():
    """Rates conditioned on weekday/weekend/exhibition cannot be resolved from
    this text, so the honest answer is the span, not a picked value."""
    p = parse_fare("計時：小型車週一至週五50元/時(08-23)、10元/時(23-08)，"
                   "週六至週日60元/時(08-23)、10元/時(23-08)，停車全程以半小時計。")
    assert p.kind == "range"
    assert (p.low, p.high) == (10, 60)


def test_contradictory_tiers_for_the_same_hours_still_produce_a_range():
    """A real lot prices 08-22 at both 100 and 70 depending on exhibition period."""
    p = parse_fare("計時：小型車週一至週日、展覽期間100元/時(08-22)，非展覽期間70元/時(08-22)、40元/時(22-08)。")
    assert p.kind == "range"
    assert (p.low, p.high) == (40, 100)


def test_per_entry_only_is_its_own_kind():
    p = parse_fare("小型車： 計次 50元/次，隔日另計，本場未出售月票。")
    assert p == Price("entry", 50, 50)


def test_tiered_entry_fees_become_a_span_not_the_first_one():
    """Taking `_ENTRY`'s first match shipped the weekday fee on a Sunday --
    precisely the failure the range design rejected for hourly rates."""
    p = parse_fare("計次：平日20元/次，假日30元/次")
    assert p == Price("entry", 20, 30)


def test_a_single_entry_fee_stays_degenerate():
    assert parse_fare("小型車： 計次 50元/次，隔日另計。") == Price("entry", 50, 50)


def test_an_implausible_entry_tier_is_dropped_not_spanned():
    """A 6,000元 figure is a monthly rental that escaped the 月租 cut; it must
    not stretch the span, and the plausible tier it sits beside still stands."""
    p = parse_fare("計次：小型車50元/次，全年期6,000元/次。")
    assert p == Price("entry", 50, 50)


def test_an_hourly_rate_wins_over_a_per_entry_rate():
    p = parse_fare("計時：小型車60元/時(06-18)。計次：小型車週一至週五50元/次。")
    assert p.kind in ("exact", "range")


def test_unparseable_text_is_unknown_never_a_default():
    p = parse_fare("計時：洽公民眾30分鐘以下者免費，逾30分鐘至1小時，收費30元。")
    assert p.kind == "unknown"
    assert p.low is None and p.high is None


def test_empty_fare_is_unknown():
    assert parse_fare("").kind == "unknown"
    assert parse_fare(None).kind == "unknown"


def test_implausible_rates_are_rejected_as_unknown():
    """A parse that yields NT$5,500/hr has certainly grabbed a monthly figure."""
    assert parse_fare("計時：小型車5500元/時。").kind == "unknown"
    assert parse_fare("計時：小型車1元/時。").kind == "unknown"


def test_a_comma_grouped_rate_is_read_whole_not_from_the_comma_on():
    """The feed comma-groups four-digit figures. Reading `1,200元/時` from the
    comma yields 200 -- squarely inside the plausible band, so nothing
    downstream would catch it. The whole figure is implausible, hence unknown."""
    assert parse_fare("計時：小型車1,200元/時。").kind == "unknown"


def test_a_comma_grouped_entry_fee_is_read_whole():
    assert parse_fare("計次：小型車1,500元/次。").kind == "unknown"


def test_comma_grouping_does_not_disturb_an_ordinary_rate():
    assert parse_fare("計時：小型車30元/時。月租：小型車5,000元/月。") == Price("exact", 30, 30)


def test_range_is_ordered_low_then_high():
    p = parse_fare("計時：小型車100元/時(09-21)、60元/時(21-09)。")
    assert p.kind == "range" and p.low < p.high


def test_a_parenthetical_motorcycle_aside_does_not_destroy_the_car_rate():
    """`小型車(含大型重型機車)` is a car clause that merely mentions motorcycles.
    Stripping from the mention onward loses the rate entirely."""
    p = parse_fare("計時：小型車(含大型重型機車)：小型 30元/時，未滿半小時以半小時計費。")
    assert p == Price("exact", 30, 30)


def test_a_motorcycle_clause_after_an_ideographic_comma_is_still_stripped():
    """`、` separates clauses just as `，` does. Missing it lets a NT$10
    motorcycle rate become the low end of a range no driver can pay."""
    p = parse_fare("計時：小型車30元/時、機車10元/時(當日累計上限20元)，未滿半小時計費。")
    assert p == Price("exact", 30, 30)


def test_a_large_vehicle_rate_is_still_excluded():
    """The strip must keep doing its original job."""
    p = parse_fare("計時：小型車100元/時，大客車300元/時，停車全程以半小時計。")
    assert p == Price("exact", 100, 100)


def test_a_non_car_clause_ends_where_a_car_clause_begins():
    """Eating to the full stop would take the car rate with the truck's."""
    p = parse_fare("計時：大型車200元/小時，小型車100元/時，停車全程以半小時計。")
    assert p == Price("exact", 100, 100)


def test_a_shared_subject_list_keeps_the_rate_it_shares():
    """`小型車及大型重型機車` and `小型車、大型重型機車` name one rate's two
    subjects; neither may be read as a motorcycle-only clause."""
    assert parse_fare("小型車及大型重型機車：計時 50元/時，全程以半小時計。")         == Price("exact", 50, 50)
    assert parse_fare("小型車、大型重型機車：計時40元/時，全程以半小時計。")         == Price("exact", 40, 40)


TPE0007 = ("計時:40元(08-22)、20元(22-08)，停放於充電格位之車輛，加收10元/時，"
           "依設備自動判斷未充電者再加收10元/時（未充電者合計加收20元/時），全程半小時計。"
           "月租：全日6,000元，夜間3,000元/月(22-08)。")


def test_a_charging_bay_surcharge_is_never_read_as_the_tariff():
    """TPE0007, live in the published roster. Its real tariff is 40/hr by day
    and 20/hr overnight, written bare; the 10/10/20 figures are 加收 extras for
    occupying a charging bay and every one of them carries `元/時`, so they are
    all `_HOURLY` can see. Publishing NT$10-20 for a NT$40 lot is exactly the
    plausible-but-wrong number this parser exists to refuse, and no plausibility
    guard can catch it."""
    p = parse_fare(TPE0007)
    assert (p.low, p.high) != (10, 20)


def test_a_surcharge_clause_is_excluded_however_it_is_introduced():
    for marker in ("加收", "另收", "再加收", "加計"):
        text = f"計時：小型車30元/時，停放於充電格位之車輛{marker}10元/時。"
        assert parse_fare(text) == Price("exact", 30, 30), marker


def test_隔日另計_is_not_a_surcharge():
    """`另計` says the next day is counted separately, not that anything extra
    is charged. It ends nearly every per-entry clause in the feed; treating it
    as a surcharge would blank the rate itself."""
    assert parse_fare("小型車： 計次 50元/次，隔日另計。") == Price("entry", 50, 50)


def test_a_surcharge_does_not_swallow_the_rate_in_a_neighbouring_clause():
    """TPE0590's shape: the levy sits in its own clause after the fee."""
    p = parse_fare("計次：小型車30元/次，當日未於17時30分前離場加收30元。")
    assert p == Price("entry", 30, 30)


def test_a_word_between_the_rate_and_the_motorcycle_does_not_defeat_the_strip():
    """Testing only the character immediately before the noun was too narrow:
    `惟` and `其中` sit between the comma and the subject, and let a NT$10
    motorcycle rate become the low end of a range no driver can pay."""
    assert parse_fare("計時：小型車30元/時，惟機車10元/時。") == Price("exact", 30, 30)
    assert parse_fare("計時：小型車30元/時，其中機車10元/時。") == Price("exact", 30, 30)


def test_a_motorcycle_rate_after_an_unpriced_aside_is_not_the_car_rate():
    """`24小時營業` quotes no rate and names no car, so the only rate in the
    text belongs to motorcycles. There is no car price to report."""
    assert parse_fare("計時：24小時營業，機車10元/時。").kind == "unknown"


def test_a_motorcycle_rate_qualified_by_a_place_is_not_the_car_rate():
    """No car is named anywhere, so `地下一樓機車20元/時` is a bike rate with a
    floor attached -- not a car rate. TPE1300 carries this shape live."""
    assert parse_fare("計時：地下一樓機車20元/時。").kind == "unknown"


def test_a_truck_rate_qualified_by_its_customer_is_still_excluded():
    """TPE1300's `農產公司送貨大型車40元/時` is benign only because that truck
    rate happens to equal the car rate. It must be excluded on structure."""
    p = parse_fare("計時：小型車30元/時，農產公司送貨大型車40元/時。")
    assert p == Price("exact", 30, 30)


def test_a_car_written_as_汽車_is_recognised_as_a_car():
    """Ten fixture lots price in 汽車, five of which never write 小型車. Without
    it the strip cannot resume, so the weekend rate is dropped AND the result
    claims exactness -- the worst of both outcomes."""
    p = parse_fare("計時：汽車30元/時，機車10元/時，汽車假日50元/時。")
    assert p == Price("range", 30, 50)


def test_汽車_alone_is_enough_to_carry_a_lot():
    assert parse_fare("計時：汽車40元/時，全程以半小時計。") == Price("exact", 40, 40)


def test_a_motorcycle_only_lot_has_no_car_rate_to_report():
    """機車:10元/時 is the whole fare text; there is no car price to give."""
    assert parse_fare("機車：10元/時，當日當次停車最高收費上限30元/次，隔日另計。").kind == "unknown"
