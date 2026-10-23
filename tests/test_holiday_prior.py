"""Which day a public holiday most resembles, measured rather than assumed.

The holiday cell of the climatology shrinks toward one day of the clock week
(`config.HOLIDAY_PRIOR_SLOT`). Sunday is the obvious guess and exactly the
kind of guess this project measures before relying on. The scoring is tested
here on a corpus with the answer planted; the real run is a script.
"""
import importlib.util
import pathlib
import sys
from datetime import datetime

from parkcast import config
from parkcast.forecast import Climatology, Counts, History

_PATH = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "holiday-prior.py"
_spec = importlib.util.spec_from_file_location("holiday_prior", _PATH)
holiday_prior = importlib.util.module_from_spec(_spec)
sys.modules["holiday_prior"] = holiday_prior
_spec.loader.exec_module(holiday_prior)


def taipei(y, m, d, h, mi=10) -> int:
    return int(datetime(y, m, d, h, mi, tzinfo=config.TAIPEI_TZ).timestamp())


def _corpus_where_saturdays_fill() -> Climatology:
    """Every weekday afternoon has a space; every Saturday afternoon is full.
    Saturday, not Sunday, so a scorer that defaulted to the configured prior
    would be caught out."""
    counts = Counts()
    for week in range(6):
        for day in range(7):           # 2026-07-02 is a Thursday: slot 0
            ts = taipei(2026, 7, 2 + day, 14) + week * 7 * 86400
            full = day == 2            # Thursday + 2 = Saturday
            counts.add("A", ts, 0 if full else 5)
    return Climatology(History(latest_ts=0, current={}, recent={}, counts=counts))


def test_the_slot_that_predicts_the_holiday_best_scores_lowest():
    clim = _corpus_where_saturdays_fill()
    # A holiday afternoon on which the lot was full: a Saturday-shaped day.
    holiday_obs = [("A", taipei(2026, 9, 25, 14), 0), ("A", taipei(2026, 9, 25, 14, 20), 0)]

    scores = holiday_prior.score_slots(clim, holiday_obs)

    assert set(scores) == set(range(7))
    assert min(scores, key=lambda s: scores[s][0] / scores[s][1]) == 2   # Saturday
    assert all(n == 2 for _, n in scores.values())


def test_scores_read_the_observation_s_own_half_hour():
    """A slot is compared at the holiday observation's half-hour, never at a
    fixed one: 09:10 and 14:10 must read different cells."""
    counts = Counts()
    for week in range(6):
        counts.add("A", taipei(2026, 7, 4, 9) + week * 7 * 86400, 5)    # Saturday morning free
        counts.add("A", taipei(2026, 7, 4, 14) + week * 7 * 86400, 0)   # Saturday afternoon full
    clim = Climatology(History(latest_ts=0, current={}, recent={}, counts=counts))

    morning = holiday_prior.score_slots(clim, [("A", taipei(2026, 9, 25, 9), 5)])[2]
    afternoon = holiday_prior.score_slots(clim, [("A", taipei(2026, 9, 25, 14), 5)])[2]

    assert morning[0] < afternoon[0]


def test_pooling_weights_each_holiday_by_its_observations():
    per_holiday = {
        "a": {0: (10.0, 100), 3: (5.0, 100)},
        "b": {0: (1.0, 10), 3: (2.0, 10)},
    }

    pooled = holiday_prior.pool(per_holiday)

    assert pooled[0] == (11.0, 110)
    assert pooled[3] == (7.0, 110)
    assert holiday_prior.winner(pooled) == 3
