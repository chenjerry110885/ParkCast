"""Collect Tainan's availability feed.

Like New Taipei and Kaohsiung, Tainan answers one GET with its whole roster
and every lot's live count in the same records, so `SourceTick.lots` is
never `None` here. Tainan is one of the four cities that report a real live
motorcycle count -- `moto` is a reading, not a capacity field -- and, as
with Kaohsiung, the two count fields report independently: a lot's `moto`
must never suppress a real `car`, or vice versa.

This feed documents no sentinel value at all. Every one of the 268 live
records checked 2026-09-16 held a plain non-negative int on both `car` and
`moto`, with no missing keys and no negatives anywhere -- so there is
nothing to enumerate. `clean_count` is used anyway, unchanged from every
other adapter: it already treats a missing key or a non-integer as "not
reporting" (None) while leaving a real 0 alone, which is exactly the rule
the brief asks for, and it is the same rule that caught Kaohsiung's
undocumented -3 without any adapter change.

Each record stamps itself with `update_time` ("%Y-%m-%d %H:%M:%S", Taipei
local time), so `ts_kind` is per-record.

`lnglat` is a single "lat,lng" string despite its name. Every one of the
268 live records checked 2026-09-16 puts a valid Taiwan latitude first and
a valid longitude second; swapping the pair never lands inside the Taiwan
box for any record seen. This adapter does not trust that observation
either: it parses both numbers and asks `geo.in_taiwan` which ordering (if
either) is valid, dropping the lot only if neither is.
"""
from datetime import datetime

from parkcast import config, ids
from parkcast.feed import TS_FETCH, TS_RECORD, FeedSnapshot, Observation
from parkcast.metadata import Lot
from parkcast.quality import clean_count
from parkcast.sources import SourceTick, geo, http

CITY = "tainan"
URL = "https://parkweb.tainan.gov.tw/api/parking.php"

_UPDATE_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def _parse_update_time(raw: object) -> int | None:
    """'2026-09-16 08:54:02' (Taipei local) -> epoch seconds, or None."""
    if not isinstance(raw, str):
        return None
    try:
        naive = datetime.strptime(raw, _UPDATE_TIME_FORMAT)
    except ValueError:
        return None
    return int(naive.replace(tzinfo=config.TAIPEI_TZ).timestamp())


def _parse_lnglat(raw: object) -> tuple[float, float] | None:
    """'22.99,120.19' -> (lat, lon), choosing whichever order lands in Taiwan.

    The field name claims "lng,lat"; the content observed in the live feed
    is "lat,lng". Neither the name nor that observation is trusted here --
    both orderings are tried against `geo.in_taiwan`, and the lot is dropped
    if neither lands in Taiwan.
    """
    if not isinstance(raw, str):
        return None
    parts = raw.split(",")
    if len(parts) != 2:
        return None
    try:
        a, b = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    if geo.in_taiwan(a, b):
        return a, b
    if geo.in_taiwan(b, a):
        return b, a
    return None


def _serves_cars(raw: object) -> bool:
    """Does this lot have car spaces at all?

    Same convention every other adapter uses: `0` means "not a car park";
    a missing or unparseable capacity means "not reported", a different
    fact that must not be read as zero.
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
        raw_id = entry.get("id")
        if not raw_id or raw_id in seen:
            continue
        seen.add(raw_id)
        lot_id = ids.qualify(CITY, raw_id)

        data_ts = _parse_update_time(entry.get("update_time"))
        if data_ts is None:
            data_ts, ts_kind = now, TS_FETCH
        else:
            ts_kind = TS_RECORD

        observations.append(
            Observation(
                lot_id=lot_id,
                free_car=clean_count(entry.get("car")),
                # Tainan is one of the four cities that report a real live
                # motorcycle count, unlike New Taipei's capacity-only field.
                # It reports independently of free_car -- one field's
                # missing/unparseable value must never suppress the other.
                free_motor=clean_count(entry.get("moto")),
                data_ts=data_ts,
                ts_kind=ts_kind,
            )
        )

        position = _parse_lnglat(entry.get("lnglat"))
        if position is None:
            continue
        lat, lon = position

        raw_capacity = entry.get("car_total")
        capacity = clean_count(raw_capacity)
        lots.append(
            Lot(
                id=lot_id,
                name=entry.get("name", ""),
                area=entry.get("zone", ""),
                lot_type=entry.get("typeName", ""),
                # 0 means "not a car park", which is different from "full".
                capacity_car=capacity or None,
                lat=lat,
                lon=lon,
                service_time="",
                fare_text=entry.get("chargeFee", ""),
                serves_cars=_serves_cars(raw_capacity),
            )
        )

    snapshot = FeedSnapshot(city=CITY, observed_at=now, observations=tuple(observations))
    return SourceTick(snapshot=snapshot, lots=tuple(lots))


class Source:
    city = CITY

    def fetch(self, *, now: int) -> SourceTick:
        return parse(http.get_json(URL), now=now)
