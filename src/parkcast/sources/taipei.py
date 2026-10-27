"""Collect Taipei's availability feed.

Taipei stamps the whole feed once (`UPDATETIME`), not each record, so every
observation in a tick shares one `data_ts` with `ts_kind=TS_FEED`. Taipei's
roster still comes from its own separate daily `METADATA_URL` endpoint
(`metadata.parse_metadata`), so `SourceTick.lots` is always `None` here.

The feed is read as XML (`config.AVAILABILITY_URL`): the JSON copy stopped
updating around 2026-10-21. `from_xml` turns it into the exact dict the JSON
used to be, so `parse` -- and every test written against the JSON -- is
unchanged.
"""
import xml.etree.ElementTree as ET

from parkcast import config, ids
from parkcast.feed import TS_FEED, FeedSnapshot, Observation, parse_updatetime
from parkcast.quality import clean_count
from parkcast.sources import SourceTick, http

CITY = "taipei"
URL = config.AVAILABILITY_URL

#: XML element -> the JSON key `parse` reads. The other counts the feed carries
#: (bus, handicap, pregnancy, heavy motor) are not collected, as before.
_FIELDS = {"ID": "id", "AVAILABLECAR": "availablecar", "AVAILABLEMOTOR": "availablemotor"}


def from_xml(body: bytes) -> dict:
    """The XML feed as the JSON payload it replaced: `{"data": {"UPDATETIME",
    "park": [{"id", "availablecar", "availablemotor"}]}}`, values as text.

    `clean_count` already turns "15" into 15 and "-9" into None, so text is
    all `parse` needs. A body declaring a DOCTYPE is refused before parsing: a
    feed of counts has no use for one, and refusing it is cheaper than relying
    on the parser to defuse whatever entities it declares. Anything unreadable,
    or without an UPDATETIME, is a `FeedError` -- this source fails, the other
    five do not.
    """
    if b"<!DOCTYPE" in body[:4096].upper():
        raise http.FeedError("Taipei's availability XML declares a DOCTYPE; refusing it")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise http.FeedError(f"Taipei's availability XML is unreadable: {exc}") from exc
    stamp = root.findtext("UPDATETIME")
    if not stamp:
        raise http.FeedError("Taipei's availability XML has no UPDATETIME")
    park = [{key: el.findtext(tag) for tag, key in _FIELDS.items()}
            for el in root.iter("PARK")]
    return {"data": {"UPDATETIME": stamp.strip(), "park": park}}


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
        return parse(from_xml(http.get_bytes(URL)), now=now)
