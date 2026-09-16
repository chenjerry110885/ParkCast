"""Shared feed types: one observation, one tick's worth of them.

Per-city parsing lives in `sources.<city>` -- `parse_updatetime` stays here
because it is Taipei-specific date-format logic that `sources.taipei` and
(for now) nothing else needs, and moving it would just be another import
for no gain.
"""
from dataclasses import dataclass
from datetime import datetime

from parkcast import config

_UPDATETIME_FORMAT = "%a %b %d %H:%M:%S CST %Y"

TS_RECORD = "record"   # the feed stamped this lot
TS_FEED = "feed"       # the feed stamped the whole payload
TS_FETCH = "fetch"     # the feed stamped nothing; this is when we asked


@dataclass(frozen=True, slots=True)
class Observation:
    lot_id: str
    free_car: int | None
    free_motor: int | None
    data_ts: int
    # Which of the three above produced `data_ts`. A fetch-time stamp is an
    # assumption, not a reading, and a backtest must be able to exclude it.
    ts_kind: str


@dataclass(frozen=True, slots=True)
class FeedSnapshot:
    city: str
    observed_at: int
    observations: tuple[Observation, ...]

    @property
    def latest_data_ts(self) -> int:
        return max((o.data_ts for o in self.observations), default=0)


def parse_updatetime(text: str) -> int:
    """'Fri Sep 04 09:08:00 CST 2026' -> epoch seconds.

    CST in this feed is Taipei (UTC+8), not US Central. Taiwan has no DST,
    so a fixed offset is correct year-round.
    """
    naive = datetime.strptime(text.strip(), _UPDATETIME_FORMAT)
    return int(naive.replace(tzinfo=config.TAIPEI_TZ).timestamp())
