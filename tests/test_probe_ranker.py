"""Guards `scripts/probe-ranker.py`'s money term against the ranker it audits.

The probe reimplemented `priceOf` from `rank.ts` in Python, and the time-aware
pricing work changed `priceOf` without changing the probe. For a while the
probe reported inversion counts for a ranker that did not exist -- the same
class of failure as training/serving skew, which
`test_features.py::test_training_and_serving_build_the_identical_row` exists to
prevent: both halves keep computing, nothing raises, and every number in
between stays plausible.

Two things are asserted here, and they fail for different reasons:

* the fee arithmetic, against hand-computed stays. A stay crossing a rate
  boundary must be *integrated*, not charged at the arrival rate and not taken
  from the midpoint of the range.
* `FEE_RULES`, the tripwire. It parses `priceOf`'s three fee branches out of
  the TypeScript and refuses to run when their shape changes -- the same
  arrangement `FLOOR_RULE` already has for the preference rule, and the one
  that would have caught the drift above on the day it happened.

Nothing here reads `data/`. The grid blobs are built by `grid_blob` below.
"""
import importlib.util
import struct
import sys
from datetime import datetime, time, timezone
from pathlib import Path

import pytest

from parkcast import config

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = ROOT / "scripts" / "probe-ranker.py"

#: 2026-09-16 19:20 Taipei, the moment `scripts/build-seam-fixture.py` pins.
#: Reused so a reader comparing the two suites sees the same wall clock.
BASE_TS = 1789557600
STEP_MIN = 5


def _load_probe():
    """Import the probe by file path.

    Its filename has a hyphen, which is not a legal module name, so a plain
    `import` cannot reach it. Registered in `sys.modules` before execution --
    the recipe importlib's own documentation gives, and the same one
    `test_seam_fixture.py` uses for `build-seam-fixture.py`.
    """
    spec = importlib.util.spec_from_file_location("probe_ranker", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


probe = _load_probe()


def grid_blob(*, base_data_ts=BASE_TS, n_lots=1, n_horizons=24, step=STEP_MIN):
    """A `PCG1` grid with every cell at 50% -- a header to read, nothing more."""
    header = struct.pack(probe.HEADER_FORMAT, b"PCG1", 1, base_data_ts + 47,
                         base_data_ts, n_lots, n_horizons, step, 0)
    return header + bytes([50] * (n_lots * n_horizons))


def taipei(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=config.TAIPEI_TZ)


def ranker_for(price, arrival):
    """A one-lot `Ranker` whose single lot carries `price`."""
    lot = {"i": 0, "id": "x", "n": "x", "y": 25.0, "x": 121.5, "p": price}
    doc = {"lots": [lot], "n_lots": 1}
    return probe.Ranker(doc, grid_blob(), probe.load_constants(), arrival)


# --------------------------------------------------------------------- #
# The header the arrival default is derived from
# --------------------------------------------------------------------- #

def test_header_carries_the_reading_time_and_the_horizon_step():
    header = probe.read_header(grid_blob())
    assert header.base_data_ts == BASE_TS
    assert header.horizon_step_min == STEP_MIN


def test_header_rejects_a_blob_that_is_not_a_grid():
    with pytest.raises(SystemExit):
        probe.read_header(b"NOPE" + bytes(probe.HEADER_SIZE))


# --------------------------------------------------------------------- #
# --arrival
# --------------------------------------------------------------------- #

def test_arrival_defaults_to_the_moment_the_scored_column_forecasts():
    """Column 2 at a 5-minute step is +15 min, so the fee is priced there.

    Not `now`: the probability and the price have to refer to the same
    instant, or the probe reports a fee for a moment it never scored.
    """
    header = probe.read_header(grid_blob())
    got = probe.resolve_arrival(None, header, column=2)
    assert got == datetime.fromtimestamp(BASE_TS + 15 * 60, config.TAIPEI_TZ)


def test_arrival_default_follows_the_headers_own_step():
    header = probe.read_header(grid_blob(step=15))
    got = probe.resolve_arrival(None, header, column=1)
    assert got == datetime.fromtimestamp(BASE_TS + 30 * 60, config.TAIPEI_TZ)


def test_arrival_accepts_an_hour_of_day_on_the_artifacts_own_date():
    """`--arrival 9` is 09:00 Taipei on the day the artifacts were read.

    Anchored to the artifacts rather than to today, so the same directory
    probed next week prices the same stay.
    """
    header = probe.read_header(grid_blob())
    day = datetime.fromtimestamp(BASE_TS, config.TAIPEI_TZ).date()
    assert probe.resolve_arrival("9", header, column=2) == datetime.combine(
        day, time(9), tzinfo=config.TAIPEI_TZ)


def test_arrival_accepts_an_iso_datetime_as_taipei_wall_clock():
    header = probe.read_header(grid_blob())
    got = probe.resolve_arrival("2026-09-16T21:30", header, column=2)
    assert got == taipei(2026, 9, 16, 21, 30)


def test_arrival_keeps_an_explicit_offset():
    header = probe.read_header(grid_blob())
    got = probe.resolve_arrival("2026-09-16T13:30+00:00", header, column=2)
    assert got == datetime(2026, 9, 16, 13, 30, tzinfo=timezone.utc)
    assert got == taipei(2026, 9, 16, 21, 30)


def test_arrival_refuses_an_hour_outside_the_day():
    header = probe.read_header(grid_blob())
    with pytest.raises(SystemExit):
        probe.resolve_arrival("24", header, column=2)


def test_arrival_refuses_text_that_is_neither():
    header = probe.read_header(grid_blob())
    with pytest.raises(SystemExit):
        probe.resolve_arrival("lunchtime", header, column=2)


# --------------------------------------------------------------------- #
# The fee: the stay, integrated
# --------------------------------------------------------------------- #

#: An overnight rate as `artifacts.py` puts it on the wire: 60/hour between
#: 08:00 and 22:00, 20/hour the rest of the night.
OVERNIGHT = {"k": "range", "lo": 20, "hi": 60,
             "t": [["all", 8, 22, 60], ["all", 22, 8, 20]]}


def test_fee_integrates_a_stay_that_crosses_a_rate_boundary():
    """The headline. A 2-hour stay from 21:30 spans three hour blocks:

        21:30-22:00   0.5h @ 60  =  30
        22:00-23:00   1.0h @ 20  =  20
        23:00-23:30   0.5h @ 20  =  10
                                 = NT$60

    The midpoint of the range is 40, so the formula this replaces would have
    said 2 x 40 = NT$80 -- half again too much, and wrong in the expensive
    direction. Charging the arrival rate for the whole stay would say 120.
    """
    got = probe.fee_for_stay(OVERNIGHT, taipei(2026, 9, 16, 21, 30), 2)
    assert got == 60.0
    assert got != probe.midpoint(OVERNIGHT) * 2


def test_fee_charges_the_one_rate_in_force_for_a_stay_inside_a_single_block():
    got = probe.fee_for_stay(OVERNIGHT, taipei(2026, 9, 16, 14, 0), 2)
    assert got == 120.0


def test_fee_resolves_a_weekend_rate_from_the_date():
    """Delegated to `pricing.rate_at`, which reads the weekday off `arrival`."""
    price = {"k": "range", "lo": 30, "hi": 80,
             "t": [["weekday", 0, 0, 30], ["weekend", 0, 0, 80]]}
    assert probe.fee_for_stay(price, taipei(2026, 9, 16, 14, 0), 2) == 60.0   # Wednesday
    assert probe.fee_for_stay(price, taipei(2026, 9, 19, 14, 0), 2) == 160.0  # Saturday


def test_fee_declines_a_stay_with_an_hour_that_states_no_rate():
    """`None`, not a partial sum. A fee missing an hour is a different
    quantity rather than a smaller one, exactly as `feeForStay` has it."""
    price = {"k": "range", "lo": 60, "hi": 60, "t": [["all", 10, 20, 60]]}
    assert probe.fee_for_stay(price, taipei(2026, 9, 16, 9, 0), 2) is None


def test_fee_declines_a_stay_priced_only_for_public_holidays():
    """Inherited from `pricing.rate_at`: Saturday is readable from the date,
    a public holiday is not, and this project has no holiday calendar."""
    price = {"k": "range", "lo": 30, "hi": 30, "t": [["holiday", 0, 0, 30]]}
    assert probe.fee_for_stay(price, taipei(2026, 9, 16, 14, 0), 2) is None


def test_fee_declines_a_lot_that_publishes_no_schedule():
    price = {"k": "range", "lo": 20, "hi": 60}
    assert probe.fee_for_stay(price, taipei(2026, 9, 16, 14, 0), 2) is None


# --------------------------------------------------------------------- #
# The midpoint, and the branches around it
# --------------------------------------------------------------------- #

def test_midpoint_reads_a_lot_that_states_only_an_upper_bound():
    """`lo ?? hi` in `rank.ts`. `lo` is nullable on the wire, and the probe
    used to require the key -- sending such a lot to the median fallback where
    the app prices it, and dividing `None` by 2 when the key was present."""
    assert probe.midpoint({"k": "range", "lo": None, "hi": 60}) == 60
    assert probe.midpoint({"k": "range", "hi": 60}) == 60
    assert probe.midpoint({"k": "range", "lo": 20}) == 20


def test_midpoint_refuses_a_fare_with_no_usable_number():
    assert probe.midpoint({"k": "unknown"}) is None
    assert probe.midpoint({"k": "range", "lo": None, "hi": None}) is None
    assert probe.midpoint({"k": "range", "lo": -5, "hi": 60}) is None
    assert probe.midpoint({"k": "range", "lo": 20, "hi": float("inf")}) is None


def test_ranker_charges_a_per_entry_fare_once():
    """Per-visit lots would sink to the bottom of every list if the probe
    multiplied their fare by `EXPECTED_HOURS`."""
    price = {"k": "entry", "lo": 50, "hi": 50}
    ranker = ranker_for(price, taipei(2026, 9, 16, 14, 0))
    assert ranker.fee(price) == 50


def test_ranker_falls_back_to_the_median_for_an_unreadable_fare():
    k = probe.load_constants()
    ranker = ranker_for({"k": "unknown"}, taipei(2026, 9, 16, 14, 0))
    expected = k["MEDIAN_PRICE_FALLBACK"] * k["EXPECTED_HOURS"]
    assert ranker.fee({"k": "unknown"}) == expected


def test_ranker_falls_back_to_the_midpoint_when_the_stay_cannot_be_priced():
    k = probe.load_constants()
    price = {"k": "range", "lo": 20, "hi": 60}
    ranker = ranker_for(price, taipei(2026, 9, 16, 14, 0))
    assert ranker.fee(price) == 40 * k["EXPECTED_HOURS"]


def test_ranker_prices_a_lot_that_states_only_an_upper_bound():
    """Through `Ranker.fee`, not just `midpoint`.

    The formula this replaces tested `"lo" not in price`, which a wire row
    carrying `"lo": null` satisfies -- so it reached `(None + 60) / 2` and
    raised `TypeError` mid-probe on a lot the app prices without trouble.
    """
    k = probe.load_constants()
    price = {"k": "range", "lo": None, "hi": 60}
    ranker = ranker_for(price, taipei(2026, 9, 16, 14, 0))
    assert ranker.fee(price) == 60 * k["EXPECTED_HOURS"]


def test_ranker_prices_the_stay_when_the_schedule_resolves():
    ranker = ranker_for(OVERNIGHT, taipei(2026, 9, 16, 21, 30))
    assert ranker.fee(OVERNIGHT) == 60.0


def test_ranker_scores_the_fee_it_was_given_an_arrival_for():
    """The fee reaches the score, so two arrivals rank differently. This is
    what makes the probe's output time-dependent."""
    evening = ranker_for(OVERNIGHT, taipei(2026, 9, 16, 21, 30))
    afternoon = ranker_for(OVERNIGHT, taipei(2026, 9, 16, 14, 0))
    assert evening.score((25.0, 121.5), 0)[0][0]["fee"] == 60.0
    assert afternoon.score((25.0, 121.5), 0)[0][0]["fee"] == 120.0


# --------------------------------------------------------------------- #
# The tripwire
# --------------------------------------------------------------------- #

def test_fee_rules_match_the_shipped_price_rule():
    """The guard is live: every branch the probe mirrors is still in rank.ts.

    This fails when `priceOf` changes shape -- which is the point. A reader
    whose change broke it should read the new `priceOf`, teach it to
    `FEE_RULES`, and make `Ranker.fee` agree.
    """
    probe.check_fee_rules(probe._rank_source())


def test_fee_rules_refuse_a_price_rule_that_went_back_to_the_midpoint():
    """The regression that prompted all of this, as a fixture: a `priceOf`
    that no longer integrates must stop the probe rather than be measured."""
    stale = """
      function priceOf(price) {
        if (price.k === "unknown") return { fee: MEDIAN_PRICE_FALLBACK * EXPECTED_HOURS };
        if (price.k === "entry") return { perEntry: mid, priceKnown: true, fee: mid };
        return { fee: mid * EXPECTED_HOURS };
      }
    """
    with pytest.raises(SystemExit, match="integrat"):
        probe.check_fee_rules(stale)
