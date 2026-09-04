"""Parse the Taipei availability endpoint into typed records."""
from dataclasses import dataclass
from datetime import datetime

from parkcast import config
from parkcast.quality import clean_count

_UPDATETIME_FORMAT = "%a %b %d %H:%M:%S CST %Y"


@dataclass(frozen=True, slots=True)
class Observation:
    lot_id: str
    free_car: int | None
    free_motor: int | None


@dataclass(frozen=True, slots=True)
class FeedSnapshot:
    data_ts: int
    observed_at: int
    observations: tuple[Observation, ...]


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
            )
        )

    return FeedSnapshot(data_ts, observed_at, tuple(observations))
