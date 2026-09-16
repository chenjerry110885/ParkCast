"""Collect New Taipei's availability feed.

Unlike Taipei, New Taipei answers one POST with its whole roster and every
lot's live count in the same records, so `SourceTick.lots` is never `None`
here -- there is no separate metadata endpoint to fetch. Each record stamps
*itself* with `recdate`/`rectime` (ROC calendar, Taipei local time), so
`ts_kind` is per-record rather than per-feed the way Taipei's is.

The endpoint answers 411 Length Required to a POST that omits
`Content-Length`, even for an empty body -- `sources.http.post_json` already
always sends that header, which is why this adapter can call it with no
`body` argument at all.
"""
import re
from datetime import datetime

from parkcast import config, ids
from parkcast.feed import TS_FETCH, TS_RECORD, FeedSnapshot, Observation
from parkcast.metadata import Lot
from parkcast.quality import clean_count
from parkcast.sources import SourceTick, geo, http

CITY = "newtaipei"
URL = "https://www.parkinginfo.ntpc.gov.tw/parkinginfo/public/getSpot.ashx"

_DISTRICT_RE = re.compile(r"市([^市區]*區)")


def _roc_timestamp(recdate: object, rectime: object) -> int | None:
    """'1150916' + '094529' -> epoch seconds, Taipei. None if unparseable.

    ROC year 115 = 1911 + 115 = 2026. Both fields arrive as fixed-width
    digit strings in the live feed, but a handful of records carry JSON
    `null` or the literal string `"string"` instead -- neither is a date,
    so both must come back as None rather than raise or silently misparse.
    """
    if not isinstance(recdate, str) or not isinstance(rectime, str):
        return None
    if len(recdate) != 7 or len(rectime) != 6 or not (recdate + rectime).isdigit():
        return None
    year = int(recdate[:3]) + 1911
    try:
        stamp = datetime(
            year, int(recdate[3:5]), int(recdate[5:7]),
            int(rectime[:2]), int(rectime[2:4]), int(rectime[4:6]),
            tzinfo=config.TAIPEI_TZ,
        )
    except ValueError:
        return None
    return int(stamp.timestamp())


def _district(address: object) -> str:
    """The address substring ending in '區', anchored after the city name.

    A few lots' addresses lead with an unrelated '區' before the city name
    ever appears -- e.g. "B區：新北市板橋區板城路..." labels a section "B
    區", and the real district, 板橋區, only starts after "新北市". Searching
    from the very first '區' would misread the address as being in "B區".
    Anchoring the search on the first '市' instead skips straight past that.
    """
    if not isinstance(address, str):
        return ""
    match = _DISTRICT_RE.search(address)
    return match.group(1) if match else ""


def _serves_cars(raw: object) -> bool:
    """Does this lot have car spaces at all?

    Same convention `metadata._serves_cars` uses: `0` means "not a car
    park" (here, usually a motorcycle-only lot); a missing or unparseable
    `carNum` means "not reported", which is a different fact and must not
    be read as zero.
    """
    try:
        return int(raw) != 0  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return True


def parse(payload: list, *, now: int) -> SourceTick:
    seen: set[str] = set()
    observations: list[Observation] = []
    lots: list[Lot] = []

    for entry in payload:
        raw_id = entry.get("parkingLotId")
        if not raw_id or raw_id in seen:
            continue
        seen.add(raw_id)
        lot_id = ids.qualify(CITY, raw_id)

        data_ts = _roc_timestamp(entry.get("recdate"), entry.get("rectime"))
        if data_ts is None:
            data_ts, ts_kind = now, TS_FETCH
        else:
            ts_kind = TS_RECORD

        observations.append(
            Observation(
                lot_id=lot_id,
                # NowCarSpace's null/-1/-2 all mean "not reporting" and
                # clean_count already maps every negative value (and any
                # non-numeric one) to None, exactly what all three sentinels
                # need; 0 is a real reading and clean_count leaves it alone.
                free_car=clean_count(entry.get("NowCarSpace")),
                # New Taipei publishes motorcycle *capacity* (motoNum) but
                # never a live motorcycle count -- there is no field here to
                # read one from.
                free_motor=None,
                data_ts=data_ts,
                ts_kind=ts_kind,
            )
        )

        try:
            lat, lon = float(entry.get("Lat")), float(entry.get("Lng"))
        except (TypeError, ValueError):
            continue
        if not geo.in_taiwan(lat, lon):
            continue

        raw_capacity = entry.get("carNum")
        capacity = clean_count(raw_capacity)
        lots.append(
            Lot(
                id=lot_id,
                name=entry.get("parkingLotName", ""),
                area=_district(entry.get("parkinglotAddress")),
                lot_type=entry.get("operationType", ""),
                # 0 means "not a car park", which is different from "full".
                capacity_car=capacity or None,
                lat=lat,
                lon=lon,
                service_time=entry.get("businessHours", ""),
                fare_text=entry.get("chargingstandard", ""),
                serves_cars=_serves_cars(raw_capacity),
            )
        )

    snapshot = FeedSnapshot(city=CITY, observed_at=now, observations=tuple(observations))
    return SourceTick(snapshot=snapshot, lots=tuple(lots))


class Source:
    city = CITY

    def fetch(self, *, now: int) -> SourceTick:
        return parse(http.post_json(URL), now=now)
