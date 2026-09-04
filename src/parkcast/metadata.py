"""Parse the lot-description endpoint into typed records."""
import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from parkcast.geo import resolve_latlon
from parkcast.quality import clean_count


@dataclass(frozen=True, slots=True)
class Lot:
    id: str
    name: str
    area: str
    lot_type: str
    capacity_car: int | None
    lat: float
    lon: float
    service_time: str
    fare_text: str


def parse_metadata(payload: dict) -> tuple[Lot, ...]:
    """Lots without usable coordinates are dropped: they cannot be ranked by distance."""
    lots: list[Lot] = []
    seen: set[str] = set()

    for entry in payload["data"]["park"]:
        lot_id = entry.get("id")
        if not lot_id or lot_id in seen:
            continue
        position = resolve_latlon(entry)
        if position is None:
            continue
        seen.add(lot_id)

        capacity = clean_count(entry.get("totalcar"))
        lots.append(
            Lot(
                id=lot_id,
                name=entry.get("name", ""),
                area=entry.get("area", ""),
                lot_type=entry.get("type2", ""),
                # 0 means "not a car park", which is different from "full".
                capacity_car=capacity or None,
                lat=position[0],
                lon=position[1],
                service_time=entry.get("serviceTime", ""),
                fare_text=entry.get("payex", ""),
            )
        )

    return tuple(lots)


def capacity_map(lots: Iterable[Lot]) -> dict[str, int | None]:
    return {lot.id: lot.capacity_car for lot in lots}


def snapshot_metadata(payload: dict, out_dir: Path, day: date) -> Path:
    """Persist one dated copy of the raw metadata payload.

    Capacity and lot membership change over time, so a single in-memory copy
    would silently lose history. Writing the raw payload once per day gives
    every observation a metadata snapshot valid for its date, and gives the
    artifact builder its input. Existing days are never rewritten.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{day.isoformat()}.json"
    if not path.exists():
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path
