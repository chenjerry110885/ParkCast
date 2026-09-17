"""Collect Hsinchu City's availability feed.

Like Kaohsiung and Tainan, Hsinchu answers one GET with its whole roster and
every lot's live count in the same records, so `SourceTick.lots` is never
`None` here. Hsinchu is one of the four cities that report a real live
motorcycle count -- `FREEQUANTITYMOT` is a reading, not a capacity field --
and, as with Kaohsiung and Tainan, the two count fields report
independently: a lot's `FREEQUANTITYMOT` must never suppress a real
`FREEQUANTITY`, or vice versa. Lot 079 in the fixture pins this: a real
`FREEQUANTITY` of 0 (the car side reports no capacity at all -- it is a
motorcycle-only lot) alongside a real, non-zero `FREEQUANTITYMOT` of 889.

This feed documents no sentinel value at all. Every one of the 55 live
records checked 2026-09-16 held a plain non-negative int on both
`FREEQUANTITY` and `FREEQUANTITYMOT`, with no missing keys and no negatives
anywhere -- so there is nothing to enumerate. `clean_count` is used anyway,
unchanged from every other adapter: it already treats a missing key or a
non-integer as "not reporting" (None) while leaving a real 0 alone, exactly
the rule the brief asks for. (Oddity, not a trap: lots 029 and 046 each
report a real, non-zero `FREEQUANTITYMOT` -- 67 and 60 -- while their own
`TOTALQUANTITYMOT` is 0. That field is not read anywhere in this adapter --
`Lot` has no motorcycle-capacity column -- so it cannot affect parsing, but
it means "capacity 0" and "a live count" can coexist in this feed.)

Each record stamps itself with `UPDATETIME`, an ISO-ish string in Taipei
local time (e.g. "2026-09-16T09:01:45.08"), so `ts_kind` is per-record.
The fractional-second part varies in width -- 1, 2 and 3 digits all appear
across the 55 live records checked 2026-09-16 (e.g. ".4", ".85", ".207").
`datetime.fromisoformat` accepts all three on this project's Python
(>=3.13, tested on 3.14): CPython relaxed `fromisoformat` in 3.11 to accept
any fractional width from 1 to 6 digits, so this is not the trap it would
have been on 3.10 or earlier. The parse is still wrapped in `try/except
ValueError` rather than assumed safe, so a payload change or a downgrade
degrades to `TS_FETCH` per record instead of crashing the whole tick.

`LATITUDE`/`LONGITUDE` are not trusted by name either, on the same
principle as `tainan.py`'s `lnglat` and `taoyuan.py`'s `wgsX`/`wgsY`: both
orderings are tried against `geo.in_taiwan` and the lot is dropped only if
neither lands in Taiwan. Measured 2026-09-16: `LATITUDE` as latitude and
`LONGITUDE` as longitude lands inside the Taiwan box for all 55 live
records, and the swapped ordering lands inside it for none -- so, unlike
two of the other five cities, these field names are exactly what they
claim to be. The runtime check is kept anyway; it costs nothing and does
not depend on that continuing to hold.
"""
from datetime import datetime

from parkcast import config, ids
from parkcast.feed import TS_FETCH, TS_RECORD, FeedSnapshot, Observation
from parkcast.metadata import Lot
from parkcast.quality import clean_count
from parkcast.sources import SourceTick, geo, http

CITY = "hsinchu"
URL = "https://hispark.hccg.gov.tw/OpenData/GetParkInfo"

# Measured in-container 2026-09-17 (python 3.13.15, OpenSSL 3.5.7, certifi
# 2026.07.22): a default-context fetch of this URL fails with "certificate
# verify failed: Missing Subject Key Identifier", and clearing
# `ssl.VERIFY_X509_STRICT` -- and nothing else -- makes it verify. Same cause
# as Kaohsiung: both chains end at certifi's `TWCA Global Root CA`, and it is
# that root, not either server's own certificates, that carries no Subject Key
# Identifier. Both certificates hispark.hccg.gov.tw sends have one. Hostname
# checking, CERT_REQUIRED and the path to that trusted root all stay in force.
# See `http.TlsPolicy`.
TLS = http.TlsPolicy(x509_strict=False)


def _parse_update_time(raw: object) -> int | None:
    """'2026-09-16T09:01:45.08' (Taipei local) -> epoch seconds, or None."""
    if not isinstance(raw, str):
        return None
    try:
        naive = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return int(naive.replace(tzinfo=config.TAIPEI_TZ).timestamp())


def _parse_coords(raw_lat: object, raw_lon: object) -> tuple[float, float] | None:
    """LATITUDE/LONGITUDE -> (lat, lon), choosing whichever order lands in Taiwan.

    The field names claim LATITUDE=lat, LONGITUDE=lon, and every one of the
    55 live records checked 2026-09-16 bears that out -- but that is a
    measurement, not a guarantee, so neither the names nor the observation
    is trusted here: both orderings are tried against `geo.in_taiwan`, and
    the lot is dropped only if neither lands in Taiwan.
    """
    try:
        lat, lon = float(raw_lat), float(raw_lon)
    except (TypeError, ValueError):
        return None
    if geo.in_taiwan(lat, lon):
        return lat, lon
    if geo.in_taiwan(lon, lat):
        return lon, lat
    return None


def _serves_cars(raw: object) -> bool:
    """Does this lot have car spaces at all?

    Same convention every other adapter uses: `0` means "not a car park"
    (Hsinchu publishes several motorcycle-only lots, e.g. PARKNO 068 and
    079, both with `TOTALQUANTITY: 0`); a missing or unparseable capacity
    means "not reported", a different fact that must not be read as zero.
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
        raw_id = entry.get("PARKNO")
        if not raw_id or raw_id in seen:
            continue
        seen.add(raw_id)
        lot_id = ids.qualify(CITY, raw_id)

        data_ts = _parse_update_time(entry.get("UPDATETIME"))
        if data_ts is None:
            data_ts, ts_kind = now, TS_FETCH
        else:
            ts_kind = TS_RECORD

        observations.append(
            Observation(
                lot_id=lot_id,
                free_car=clean_count(entry.get("FREEQUANTITY")),
                # Hsinchu is one of the four cities that report a real live
                # motorcycle count. It reports independently of free_car --
                # one field's missing/unparseable value must never suppress
                # the other.
                free_motor=clean_count(entry.get("FREEQUANTITYMOT")),
                data_ts=data_ts,
                ts_kind=ts_kind,
            )
        )

        position = _parse_coords(entry.get("LATITUDE"), entry.get("LONGITUDE"))
        if position is None:
            continue
        lat, lon = position

        raw_capacity = entry.get("TOTALQUANTITY")
        capacity = clean_count(raw_capacity)
        lots.append(
            Lot(
                id=lot_id,
                name=entry.get("PARKINGNAME", ""),
                area="",
                lot_type="",
                # 0 means "not a car park" (a motorcycle-only lot here),
                # which is different from "full".
                capacity_car=capacity or None,
                lat=lat,
                lon=lon,
                service_time="",
                fare_text=entry.get("WEEKDAYS", ""),
                serves_cars=_serves_cars(raw_capacity),
            )
        )

    snapshot = FeedSnapshot(city=CITY, observed_at=now, observations=tuple(observations))
    return SourceTick(snapshot=snapshot, lots=tuple(lots))


class Source:
    city = CITY

    def fetch(self, *, now: int) -> SourceTick:
        return parse(http.get_json(URL, tls=TLS), now=now)
