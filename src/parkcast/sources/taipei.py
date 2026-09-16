"""Collect Taipei's availability feed.

Taipei stamps the whole feed once (`UPDATETIME`), not each record, so every
observation in a tick shares one `data_ts` with `ts_kind=TS_FEED`. Taipei's
roster still comes from its own separate daily `METADATA_URL` endpoint
(`metadata.parse_metadata`), so `SourceTick.lots` is always `None` here.
"""
from parkcast import config, ids
from parkcast.feed import TS_FEED, FeedSnapshot, Observation, parse_updatetime
from parkcast.quality import clean_count
from parkcast.sources import SourceTick, http

CITY = "taipei"
URL = config.AVAILABILITY_URL


def parse(payload: dict, *, now: int) -> SourceTick:
    data = payload["data"]
    data_ts = parse_updatetime(data["UPDATETIME"])

    seen: set[str] = set()
    observations: list[Observation] = []
    for entry in data["park"]:
        raw_id = entry["id"]
        if raw_id in seen:
            continue
        seen.add(raw_id)
        observations.append(
            Observation(
                lot_id=ids.qualify(CITY, raw_id),
                free_car=clean_count(entry.get("availablecar")),
                free_motor=clean_count(entry.get("availablemotor")),
                data_ts=data_ts,
                ts_kind=TS_FEED,
            )
        )

    snapshot = FeedSnapshot(city=CITY, observed_at=now, observations=tuple(observations))
    return SourceTick(snapshot=snapshot, lots=None)


class Source:
    city = CITY

    def fetch(self, *, now: int) -> SourceTick:
        return parse(http.get_json(URL), now=now)
