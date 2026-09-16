"""Nationwide coordinate sanity check, shared by every city adapter.

Taipei's own `geo.resolve_latlon` keeps using `config.LAT_MIN/LAT_MAX/
LON_MIN/LON_MAX` -- that box is intentionally tight to Taipei and must not
widen. The other five cities have no equivalent box of their own, so they
all sanity-check against Taiwan as a whole.
"""
from parkcast import config


def in_taiwan(lat: float, lon: float) -> bool:
    return (
        config.TW_LAT_MIN < lat < config.TW_LAT_MAX
        and config.TW_LON_MIN < lon < config.TW_LON_MAX
    )
