"""Resolve a lot's WGS84 position from the two coordinate sources the feed offers."""
from functools import lru_cache

from pyproj import Transformer

from parkcast import config


@lru_cache(maxsize=1)
def _transformer() -> Transformer:
    # EPSG:3826 = TWD97 / TM2 zone 121. always_xy keeps the (x, y) -> (lon, lat) order explicit.
    return Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)


def _in_taipei(lat: float, lon: float) -> bool:
    return (
        config.LAT_MIN < lat < config.LAT_MAX
        and config.LON_MIN < lon < config.LON_MAX
    )


def _from_entrance(lot: dict) -> tuple[float, float] | None:
    entries = (lot.get("EntranceCoord") or {}).get("EntrancecoordInfo") or []
    for entry in entries:
        try:
            # Despite the names, Xcod is LATITUDE and Ycod is LONGITUDE.
            lat, lon = float(entry["Xcod"]), float(entry["Ycod"])
        except (KeyError, TypeError, ValueError):
            continue
        if _in_taipei(lat, lon):
            return lat, lon
    return None


def _from_tw97(lot: dict) -> tuple[float, float] | None:
    try:
        x, y = float(lot["tw97x"]), float(lot["tw97y"])
    except (KeyError, TypeError, ValueError):
        return None
    lon, lat = _transformer().transform(x, y)
    return (lat, lon) if _in_taipei(lat, lon) else None


def resolve_latlon(lot: dict) -> tuple[float, float] | None:
    """Prefer the entrance coordinate, but only when it passes a bounds check.

    574 of 1752 lots carry 0,0 in EntranceCoord. Trusting 'present' rather than
    'valid' would place them off West Africa and wreck distance ranking.
    """
    return _from_entrance(lot) or _from_tw97(lot)
