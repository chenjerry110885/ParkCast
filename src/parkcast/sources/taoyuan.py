"""Collect Taoyuan's availability feed.

Taoyuan answers one GET with its whole roster and every lot's live count in
the same records, so `SourceTick.lots` is never `None` here, like New
Taipei, Kaohsiung and Tainan. Unlike those three, Taoyuan publishes no
motorcycle field of any kind -- every `free_motor` from this city is
`None`.

Every numeric value in this feed arrives as a JSON *string*
(`"surplusSpace": "207"`, not `207`). `clean_count`'s `int(raw)` call
already handles a numeric string with no changes needed, and it also
absorbs this feed's undocumented non-numeric status text -- some lots
report `"surplusSpace": "開放中"` ("open") instead of a count,
which `int()` rejects exactly like a missing key or an empty string,
turning all three into `None`.

This feed documents no sentinel value and carries no timestamp anywhere,
per-record or per-payload, so every observation takes `data_ts=now` with
`ts_kind=TS_FETCH`.

`wgsX` and `wgsY` are swapped relative to their names: WGS "X" usually
means longitude and "Y" latitude, but every one of the 246 live records
checked 2026-09-16 puts a valid Taiwan *latitude* (~24.84-25.09) in `wgsX`
and a valid *longitude* (~120.84-121.40) in `wgsY` -- confirmed by checking
that the reverse ordering (`wgsX` as longitude, `wgsY` as latitude) fails
`geo.in_taiwan` for all 246 records, while the swapped ordering passes for
all 246. This adapter does not trust that observation either: it parses
both fields and asks `geo.in_taiwan` which ordering (if either) is valid,
dropping the lot only if neither is.
"""
from parkcast import ids
from parkcast.feed import TS_FETCH, FeedSnapshot, Observation
from parkcast.metadata import Lot
from parkcast.quality import clean_count
from parkcast.sources import SourceTick, geo, http

CITY = "taoyuan"
URL = (
    "https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79"
    "/resource/0381e141-f7ee-450e-99da-2240208d1773/download"
)


def _parse_coords(raw_x: object, raw_y: object) -> tuple[float, float] | None:
    """wgsX/wgsY -> (lat, lon), choosing whichever order lands in Taiwan.

    The field names imply wgsX=longitude, wgsY=latitude; the live feed
    holds the opposite. Neither the names nor that observation is trusted
    here -- both orderings are tried against `geo.in_taiwan`, and the lot
    is dropped only if neither lands in Taiwan.
    """
    try:
        x, y = float(raw_x), float(raw_y)
    except (TypeError, ValueError):
        return None
    if geo.in_taiwan(x, y):
        return x, y
    if geo.in_taiwan(y, x):
        return y, x
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
        raw_id = entry.get("parkId")
        if not raw_id or raw_id in seen:
            continue
        seen.add(raw_id)
        lot_id = ids.qualify(CITY, raw_id)

        observations.append(
            Observation(
                lot_id=lot_id,
                free_car=clean_count(entry.get("surplusSpace")),
                # This feed publishes no motorcycle field at all.
                free_motor=None,
                # No timestamp anywhere in this feed, per-record or
                # per-payload, so every observation takes the fetch time.
                data_ts=now,
                ts_kind=TS_FETCH,
            )
        )

        position = _parse_coords(entry.get("wgsX"), entry.get("wgsY"))
        if position is None:
            continue
        lat, lon = position

        raw_capacity = entry.get("totalSpace")
        capacity = clean_count(raw_capacity)
        lots.append(
            Lot(
                id=lot_id,
                name=entry.get("parkName", ""),
                area=entry.get("areaName", ""),
                lot_type="",
                # 0 means "not a car park", which is different from "full".
                capacity_car=capacity or None,
                lat=lat,
                lon=lon,
                service_time="",
                fare_text=entry.get("payGuide", ""),
                serves_cars=_serves_cars(raw_capacity),
            )
        )

    snapshot = FeedSnapshot(city=CITY, observed_at=now, observations=tuple(observations))
    return SourceTick(snapshot=snapshot, lots=tuple(lots))


class Source:
    city = CITY

    def fetch(self, *, now: int) -> SourceTick:
        return parse(http.get_json(URL), now=now)
