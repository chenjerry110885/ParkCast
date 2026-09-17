"""Collect Kaohsiung's availability feed.

Like New Taipei, Kaohsiung answers one POST with its whole roster and every
lot's live count in the same records, so `SourceTick.lots` is never `None`
here. Unlike New Taipei, Kaohsiung is one of the four cities that report a
real live motorcycle count -- `motorcycleVacancy` is a reading, not a
capacity field -- and the two count fields report independently: a lot's
`motorcycleVacancy` sentinel must never suppress a real `smallcarVacancy`,
or vice versa.

The feed carries no timestamp anywhere, per-record or per-payload, so every
observation takes `data_ts=now` with `ts_kind=TS_FETCH`.
"""
from parkcast import ids
from parkcast.feed import TS_FETCH, FeedSnapshot, Observation
from parkcast.metadata import Lot
from parkcast.quality import clean_count
from parkcast.sources import SourceTick, geo, http

CITY = "kaohsiung"
URL = "https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLotPost"

# Measured in-container 2026-09-17 (python 3.13.15, OpenSSL 3.5.7, certifi
# 2026.07.22): a default-context fetch of this URL fails with "certificate
# verify failed: Missing Subject Key Identifier", and clearing
# `ssl.VERIFY_X509_STRICT` -- and nothing else -- makes it verify. The
# certificate without the SKI is certifi's own `TWCA Global Root CA`, the
# trust anchor at the top of this chain; all five certificates kpp.tbkc.gov.tw
# actually sends carry one. Hostname checking, CERT_REQUIRED and the path to
# that trusted root all stay in force. See `http.TlsPolicy`.
TLS = http.TlsPolicy(x509_strict=False)


def _serves_cars(raw: object) -> bool:
    """Does this lot have car spaces at all?

    Same convention `metadata._serves_cars` and `newtaipei._serves_cars`
    use: `0` means "not a car park"; a missing or unparseable capacity means
    "not reported", a different fact that must not be read as zero.
    """
    try:
        return int(raw) != 0  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return True


def parse(payload: dict, *, now: int) -> SourceTick:
    seen: set[str] = set()
    observations: list[Observation] = []
    lots: list[Lot] = []

    for entry in payload["parkingLots"]:
        raw_id = entry.get("id")
        if not raw_id or raw_id in seen:
            continue
        seen.add(raw_id)
        lot_id = ids.qualify(CITY, raw_id)

        observations.append(
            Observation(
                lot_id=lot_id,
                # -1 and -2 both mean "not reporting" here (not Taipei's
                # -9), and clean_count already maps every negative value
                # to None -- exactly what both sentinels need -- while 0
                # is a real reading (the lot is full) and survives.
                free_car=clean_count(entry.get("smallcarVacancy")),
                # Kaohsiung is one of the four cities that report a real
                # live motorcycle count, unlike New Taipei's capacity-only
                # field. It shares the same two sentinels and is read the
                # same way -- and independently: one field's sentinel must
                # never suppress the other field's real reading.
                free_motor=clean_count(entry.get("motorcycleVacancy")),
                data_ts=now,
                ts_kind=TS_FETCH,
            )
        )

        try:
            lat, lon = float(entry.get("lat")), float(entry.get("lng"))
        except (TypeError, ValueError):
            continue
        if not geo.in_taiwan(lat, lon):
            continue

        # Read the raw value once and reuse it for both capacity_car and
        # serves_cars, exactly as newtaipei.py and metadata.py do: by the
        # time clean_count and `or None` have run, 0 and "not reported"
        # are no longer distinguishable.
        raw_capacity = entry.get("volumnAuto")
        if raw_capacity in (None, ""):
            raw_capacity = entry.get("volumn")
        capacity = clean_count(raw_capacity)
        lots.append(
            Lot(
                id=lot_id,
                name=entry.get("name", ""),
                area=entry.get("areaname", ""),
                lot_type=entry.get("ownername", ""),
                # 0 means "not a car park", which is different from "full".
                capacity_car=capacity or None,
                lat=lat,
                lon=lon,
                service_time=entry.get("businesshours", ""),
                fare_text=entry.get("chargeway", ""),
                serves_cars=_serves_cars(raw_capacity),
            )
        )

    snapshot = FeedSnapshot(city=CITY, observed_at=now, observations=tuple(observations))
    return SourceTick(snapshot=snapshot, lots=tuple(lots))


class Source:
    city = CITY

    def fetch(self, *, now: int) -> SourceTick:
        return parse(
            http.post_json(URL, body=b"{}", content_type="application/json", tls=TLS),
            now=now,
        )
