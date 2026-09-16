"""Parse the Taipei availability endpoint into typed records."""
from dataclasses import dataclass
from datetime import datetime

from parkcast import config
from parkcast.quality import clean_count

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


def parse_availability(payload: dict, observed_at: int) -> FeedSnapshot:
    data = payload["data"]
    data_ts = parse_updatetime(data["UPDATETIME"])

    seen: set[str] = set()
    observations: list[Observation] = []
    for entry in data["park"]:
        lot_id = entry["id"]
        if lot_id in seen:
            continue
        seen.add(lot_id)
        observations.append(
            Observation(
                lot_id=lot_id,
                free_car=clean_count(entry.get("availablecar")),
                free_motor=clean_count(entry.get("availablemotor")),
                data_ts=data_ts,
                ts_kind=TS_FEED,
            )
        )

    return FeedSnapshot(city="taipei", observed_at=observed_at, observations=tuple(observations))
