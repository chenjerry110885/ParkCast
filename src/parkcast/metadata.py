"""Parse the lot-description endpoint into typed records."""
import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from parkcast import ids
from parkcast.geo import resolve_latlon
from parkcast.quality import clean_count


@dataclass(frozen=True, slots=True)
class Lot:
    # Namespaced the same way `sources.<city>.parse` namespaces
    # `Observation.lot_id` (`ids.qualify`) -- see `parse_metadata`. Every
    # consumer that joins a `Lot` against the store (capacity validation,
    # `scheduler.publish_artifacts`'s `lot.id in history.counts.lot` filter,
    # `liveness.not_updating`) depends on the two conventions agreeing.
    id: str
    name: str
    area: str
    lot_type: str
    capacity_car: int | None
    lat: float
    lon: float
    service_time: str
    fare_text: str
    # Whether this lot has car spaces at all, as opposed to an unknown number of
    # them. `capacity_car` cannot answer that: it is None for both. Defaults to
    # True so the only way to drop a lot from the roster is to have measured
    # that it takes no cars -- an unset field can never quietly hide a car park.
    serves_cars: bool = True
    # Scooter/motorcycle capacity (`totalmotor`) and EV charging points
    # (`ChargingStation`) -- both live only in Taipei's own metadata feed
    # today. Unlike `capacity_car`, `0` here needs no `serves_cars`-style
    # escape hatch: a car park with zero motorcycle spaces, or zero charging
    # points, is still a car park, so `0` is never forced to None. It stays a
    # plain, real `0` -- "we checked and there are none" -- and only a
    # missing, negative or unparseable field becomes `None`, "not reported".
    # Both default to None and only `parse_metadata` (Taipei) ever sets them:
    # Kaohsiung, Tainan and Hsinchu report a *live* motorcycle count under
    # different field names (a different fact -- occupancy, not capacity),
    # New Taipei and Taoyuan have no motorcycle field at all, and none of the
    # five has anything resembling `ChargingStation`. Every other adapter's
    # `Lot(...)` call leaves both at this default deliberately -- see
    # `docs/sources.md` -- rather than inventing a shared schema for cities
    # nothing reads yet.
    capacity_motor: int | None = None
    charging: int | None = None


def _serves_cars(raw: object) -> bool:
    """Does this lot have car spaces at all?

    `0` and `-9` are different facts and the feed uses both fields' conventions
    here: `0` means "not a car park" (a motorcycle or coach park), while `-9`,
    a missing key, or unparseable text mean "not reported". Only the first is
    grounds for dropping the lot. Measured 2026-09-07: `totalcar` is positive
    for 1,699 lots and exactly 0 for 56, with no -9 anywhere -- but that is a
    measurement, not a guarantee, so unknown must stay a car park.
    """
    try:
        return int(raw) != 0  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return True


def parse_metadata(payload: dict, city: str = "taipei") -> tuple[Lot, ...]:
    """Lots without usable coordinates are dropped: they cannot be ranked by distance.

    This parses Taipei's own `TCMSV_alldesc.json` -- `city` defaults to
    `"taipei"` rather than being hard-coded, so it names the convention
    instead of repeating the string. Every `Lot.id` is namespaced through
    `ids.qualify(city, raw_id)`, exactly like `sources.<city>.parse`
    namespaces `Observation.lot_id`: the two have to agree, because
    `capacity_map`'s output is looked up by `obs.lot_id` in
    `store.insert_snapshot`, and `scheduler.publish_artifacts` filters lots
    with `lot.id in history.counts.lot`, which is keyed by the *stored*
    (namespaced) lot_id. A bare `Lot.id` there matches nothing, silently
    dropping every lot and freezing publishing entirely.
    """
    lots: list[Lot] = []
    seen: set[str] = set()

    for entry in payload["data"]["park"]:
        raw_id = entry.get("id")
        if not raw_id or raw_id in seen:
            continue
        position = resolve_latlon(entry)
        if position is None:
            continue
        seen.add(raw_id)

        # Read the raw value twice, deliberately: `clean_count` maps -9 to None
        # and `capacity or None` maps 0 to None, so by the time capacity_car is
        # built the difference between "no car spaces" and "not reported" is
        # already gone. `serves_cars` has to be computed before both.
        raw_capacity = entry.get("totalcar")
        capacity = clean_count(raw_capacity)
        # `totalmotor` and `ChargingStation` need none of the above trickery:
        # unlike `totalcar`, a `0` here carries no second meaning about the
        # lot's own type, so `clean_count` alone is the whole conversion --
        # its real 0/None split (negative or unparseable -> None, everything
        # else survives including 0) is exactly the distinction these two
        # fields need, with nothing to collapse afterwards.
        capacity_motor = clean_count(entry.get("totalmotor"))
        charging = clean_count(entry.get("ChargingStation"))
        lots.append(
            Lot(
                id=ids.qualify(city, raw_id),
                name=entry.get("name", ""),
                area=entry.get("area", ""),
                lot_type=entry.get("type2", ""),
                # 0 means "not a car park", which is different from "full".
                capacity_car=capacity or None,
                lat=position[0],
                lon=position[1],
                service_time=entry.get("serviceTime", ""),
                fare_text=entry.get("payex", ""),
                serves_cars=_serves_cars(raw_capacity),
                capacity_motor=capacity_motor,
                charging=charging,
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
