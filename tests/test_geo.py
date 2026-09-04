import json
from pathlib import Path

from parkcast.geo import resolve_latlon

FIXTURE = Path(__file__).parent / "fixtures" / "desc_sample.json"


def test_entrance_coord_xcod_is_latitude_despite_the_name():
    lot = {
        "tw97x": "302864.7812", "tw97y": "2771988.958",
        "EntranceCoord": {"EntrancecoordInfo": [{"Xcod": "25.0552", "Ycod": "121.5242"}]},
    }
    lat, lon = resolve_latlon(lot)
    assert abs(lat - 25.0552) < 1e-6, "Xcod holds LATITUDE"
    assert abs(lon - 121.5242) < 1e-6, "Ycod holds LONGITUDE"


def test_null_island_entrance_coord_falls_back_to_tw97():
    lot = {
        "tw97x": "302864.7812", "tw97y": "2771988.958",
        "EntranceCoord": {"EntrancecoordInfo": [{"Xcod": "0.0", "Ycod": "0.0"}]},
    }
    lat, lon = resolve_latlon(lot)
    assert 24.5 < lat < 25.5 and 121.0 < lon < 122.5, "must reject 0,0 and use tw97"


def test_missing_entrance_coord_falls_back_to_tw97():
    lot = {"tw97x": "302864.7812", "tw97y": "2771988.958"}
    lat, lon = resolve_latlon(lot)
    assert 24.5 < lat < 25.5 and 121.0 < lon < 122.5


def test_tw97_transform_matches_entrance_coord_within_300m():
    """Both paths should describe roughly the same place."""
    lot_full = {
        "tw97x": "302864.7812", "tw97y": "2771988.958",
        "EntranceCoord": {"EntrancecoordInfo": [{"Xcod": "25.0552", "Ycod": "121.5242"}]},
    }
    lat_a, lon_a = resolve_latlon(lot_full)
    lat_b, lon_b = resolve_latlon({"tw97x": lot_full["tw97x"], "tw97y": lot_full["tw97y"]})
    # ~0.003 degrees is roughly 300 m; entrance vs centroid differ slightly.
    assert abs(lat_a - lat_b) < 0.003 and abs(lon_a - lon_b) < 0.003


def test_unusable_coordinates_return_none():
    assert resolve_latlon({"tw97x": "0", "tw97y": "0"}) is None
    assert resolve_latlon({}) is None


def test_every_real_lot_resolves():
    lots = json.loads(FIXTURE.read_text(encoding="utf-8"))["data"]["park"]
    unresolved = [lot["id"] for lot in lots if resolve_latlon(lot) is None]
    assert unresolved == [], f"{len(unresolved)} lots without coordinates"
