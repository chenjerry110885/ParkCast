# ParkCast Plan 1 — Data Pipeline Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A collector that polls the Taipei parking feed on its publish phase, writes validated observations into SQLite, rolls each completed day into Parquet, and reports data quality — running continuously from day one.

**Architecture:** A single Python process. `feed`/`metadata` parse the two public JSON endpoints into typed records; `quality` normalises sentinels and flags anomalies; `store` persists to SQLite with idempotent upserts keyed on `(lot_id, data_ts)`; `scheduler` fires on the feed's publish phase with adaptive retry; `compact` rolls completed days into Parquet; `report` summarises coverage and gaps. No server, no network DB.

**Tech Stack:** Python 3.13, `requests`, `pyarrow`, `pyproj`, `pytest`, Docker Compose.

## Global Constraints

- Python **3.13**. Dependencies limited to: `requests`, `pyarrow`, `pyproj`, `pytest`.
- Feed timestamps (`UPDATETIME`) are **UTC+8**, format `Fri Sep 04 09:08:00 CST 2026`. "CST" here means Taipei, **not** US Central. Taiwan has no DST.
- **`data_ts` and `observed_at` are always stored separately.** Never derive one from the other.
- **Sentinel `-9` → `None`, never `0`.** Any negative count is missing data.
- **Gaps stay gaps.** Never interpolate a missing observation.
- All timestamps stored as **integer epoch seconds** (UTC).
- Poll phase: feed `data_ts` minutes are `≡3 (mod 5)`; publication is `≡1 (mod 5)`. Poll at **minute ≡1 (mod 5), second 30**.
- Coordinates: use `EntranceCoord` **only if it passes a Taipei bounds check** (`24.5<lat<25.5`, `121.0<lon<122.5`) — 574 of 1752 lots carry `0,0`. Otherwise transform `tw97x/y` (EPSG:3826 → EPSG:4326), which is valid for all 1752.
- **`Xcod` is LATITUDE and `Ycod` is LONGITUDE** in `EntranceCoord`. The names are misleading.
- Commits follow Conventional Commits, concise, **no `Co-Authored-By` trailers**.

## File Structure

```
pyproject.toml                  deps, pytest config, package metadata
src/parkcast/
  config.py       URLs, paths, tuning constants — no logic
  feed.py         availability JSON -> FeedSnapshot
  quality.py      sentinel handling, validation, quality bitflags
  geo.py          coordinate resolution + TWD97->WGS84
  metadata.py     lot-description JSON -> Lot records
  store.py        SQLite schema, idempotent upsert, prune, queries
  collector.py    one tick: fetch -> parse -> validate -> store
  scheduler.py    phase-aligned loop with adaptive retry
  compact.py      completed day -> Parquet
  report.py       data-quality summary
tests/
  fixtures/       real captured payloads (committed)
  test_*.py       one per module
docker/
  Dockerfile
  docker-compose.yml
```

---

### Task 1: Scaffolding and real fixtures

**Files:**
- Create: `pyproject.toml`, `src/parkcast/__init__.py`, `src/parkcast/config.py`
- Create: `tests/fixtures/avail_sample.json`, `tests/fixtures/desc_sample.json`
- Create: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing
- Produces: `config.AVAILABILITY_URL: str`, `config.METADATA_URL: str`, `config.DB_PATH: Path`, `config.PARQUET_DIR: Path`, `config.POLL_SECOND: int`, `config.POLL_MINUTE_MOD: int`, `config.HOT_RETENTION_SEC: int`, `config.TAIPEI_TZ: timezone`, `config.POLL_PERIOD_MIN: int`, `config.RETRY_DELAYS_SEC: tuple[int, ...]`, `config.HTTP_TIMEOUT_SEC: int`, `config.LAT_MIN/LAT_MAX/LON_MIN/LON_MAX: float`

- [ ] **Step 1: Create `pyproject.toml`**

```toml
[project]
name = "parkcast"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = ["requests>=2.32", "pyarrow>=17", "pyproj>=3.6"]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
```

- [ ] **Step 2: Create the venv and install**

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"
```

Expected: installs cleanly, no resolver errors.

- [ ] **Step 3: Capture real fixtures**

These are committed so tests never touch the network.

```bash
mkdir -p tests/fixtures
curl -s "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json" -o tests/fixtures/avail_sample.json
curl -s "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json" -o tests/fixtures/desc_sample.json
```

- [ ] **Step 4: Write `src/parkcast/config.py`**

```python
"""Static configuration. No logic, no I/O."""
from datetime import timedelta, timezone
from pathlib import Path

AVAILABILITY_URL = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json"
METADATA_URL = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json"

DATA_DIR = Path("data")
DB_PATH = DATA_DIR / "hot.sqlite"
PARQUET_DIR = DATA_DIR / "cold"

TAIPEI_TZ = timezone(timedelta(hours=8))

# Feed data_ts minutes are congruent to 3 (mod 5); publication lands ~3 min later,
# i.e. minutes congruent to 1 (mod 5). Poll 30s after that to be safe.
POLL_MINUTE_MOD = 1
POLL_SECOND = 30
POLL_PERIOD_MIN = 5

RETRY_DELAYS_SEC = (45, 45, 60)  # if data_ts has not advanced
HTTP_TIMEOUT_SEC = 30

HOT_RETENTION_SEC = 48 * 3600

# Taipei bounding box for coordinate sanity checks.
LAT_MIN, LAT_MAX = 24.5, 25.5
LON_MIN, LON_MAX = 121.0, 122.5
```

- [ ] **Step 5: Write the test**

```python
# tests/test_config.py
import json
from pathlib import Path
from parkcast import config


def test_fixtures_are_present_and_parseable():
    for name in ("avail_sample.json", "desc_sample.json"):
        path = Path(__file__).parent / "fixtures" / name
        assert path.exists(), f"missing fixture {name} — re-run the curl in Task 1"
        assert "data" in json.loads(path.read_text(encoding="utf-8"))


def test_taipei_tz_is_utc_plus_8_with_no_dst():
    assert config.TAIPEI_TZ.utcoffset(None).total_seconds() == 8 * 3600
```

- [ ] **Step 6: Run tests**

Run: `.venv/Scripts/python -m pytest tests/test_config.py -v`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml src/parkcast tests/
git commit -m "chore: scaffold parkcast package with captured fixtures"
```

---

### Task 2: Quality flags and sentinel handling

**Files:**
- Create: `src/parkcast/quality.py`
- Create: `tests/test_quality.py`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `Q` — `IntFlag` with members `OK=0`, `MISSING=1`, `CLAMPED=2`, `NO_CAPACITY=4`, `FROZEN=8`
  - `clean_count(raw: object) -> int | None`
  - `validate(free: int | None, capacity: int | None) -> tuple[int | None, Q]`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_quality.py
from parkcast.quality import Q, clean_count, validate


def test_minus_nine_is_missing_not_zero():
    assert clean_count(-9) is None


def test_all_negatives_are_missing():
    for raw in (-1, -9, -99):
        assert clean_count(raw) is None, f"{raw} should be missing"


def test_zero_is_a_real_value_meaning_full():
    assert clean_count(0) == 0


def test_non_numeric_is_missing():
    assert clean_count(None) is None
    assert clean_count("") is None
    assert clean_count("abc") is None


def test_numeric_strings_are_accepted():
    assert clean_count("42") == 42


def test_validate_flags_missing():
    value, flags = validate(None, 50)
    assert value is None
    assert Q.MISSING in flags


def test_validate_clamps_impossible_overcount():
    value, flags = validate(80, 50)
    assert value == 50, "free spaces cannot exceed capacity"
    assert Q.CLAMPED in flags


def test_validate_flags_unknown_capacity_without_clamping():
    value, flags = validate(80, None)
    assert value == 80
    assert Q.NO_CAPACITY in flags
    assert Q.CLAMPED not in flags


def test_validate_clean_case_has_no_flags():
    value, flags = validate(16, 50)
    assert value == 16
    assert flags == Q.OK
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_quality.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parkcast.quality'`

- [ ] **Step 3: Write `src/parkcast/quality.py`**

```python
"""Normalisation and quality flagging for raw feed counts."""
from enum import IntFlag


class Q(IntFlag):
    OK = 0
    MISSING = 1       # feed reported no data (sentinel or non-numeric)
    CLAMPED = 2       # free count exceeded capacity; clamped down
    NO_CAPACITY = 4   # capacity unknown, so no bound could be checked
    FROZEN = 8        # value unchanged for suspiciously long (set by report.py)


def clean_count(raw: object) -> int | None:
    """Convert a raw feed count to an int, or None when it means 'no data'.

    The feed uses -9 as its no-data sentinel. Treating it as a value would
    read as 'nine beyond full' and silently poison training. Zero is a real
    value and must survive: it means the lot is full.
    """
    try:
        value = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if value < 0 else value


def validate(free: int | None, capacity: int | None) -> tuple[int | None, Q]:
    """Bound a count against capacity and describe what happened."""
    if free is None:
        return None, Q.MISSING
    if capacity is None:
        return free, Q.NO_CAPACITY
    if free > capacity:
        return capacity, Q.CLAMPED
    return free, Q.OK
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_quality.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/parkcast/quality.py tests/test_quality.py
git commit -m "feat: add sentinel handling and quality flags"
```

---

### Task 3: Parse the availability feed

**Files:**
- Create: `src/parkcast/feed.py`
- Create: `tests/test_feed.py`

**Interfaces:**
- Consumes: `config.TAIPEI_TZ`, `quality.clean_count` (Task 2)
- Produces:
  - `Observation(lot_id: str, free_car: int | None, free_motor: int | None)` — frozen dataclass
  - `FeedSnapshot(data_ts: int, observed_at: int, observations: tuple[Observation, ...])` — frozen dataclass
  - `parse_updatetime(text: str) -> int`
  - `parse_availability(payload: dict, observed_at: int) -> FeedSnapshot`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_feed.py
import json
from datetime import datetime
from pathlib import Path

import pytest

from parkcast.feed import FeedSnapshot, parse_availability, parse_updatetime

FIXTURE = Path(__file__).parent / "fixtures" / "avail_sample.json"


def test_parse_updatetime_treats_cst_as_taipei_not_us_central():
    ts = parse_updatetime("Fri Sep 04 09:08:00 CST 2026")
    # 09:08 UTC+8 == 01:08 UTC. If CST were misread as US Central (UTC-6 or -5),
    # this would be off by 13-14 hours.
    assert datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d %H:%M") == "2026-09-04 01:08"


def test_parse_updatetime_rejects_garbage():
    with pytest.raises(ValueError):
        parse_updatetime("not a timestamp")


def test_parse_availability_on_real_payload():
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    snap = parse_availability(payload, observed_at=1788484280)

    assert isinstance(snap, FeedSnapshot)
    assert snap.observed_at == 1788484280
    assert snap.data_ts > 0
    # data_ts must precede observed_at: the feed publishes ~3 min after stamping.
    assert snap.data_ts < snap.observed_at
    assert len(snap.observations) > 1000
    assert len({o.lot_id for o in snap.observations}) == len(snap.observations)


def test_sentinel_minus_nine_becomes_none_not_zero():
    payload = {
        "data": {
            "UPDATETIME": "Fri Sep 04 09:08:00 CST 2026",
            "park": [{"id": "TPE0001", "availablecar": 16, "availablemotor": -9}],
        }
    }
    snap = parse_availability(payload, observed_at=1788484280)
    obs = snap.observations[0]
    assert obs.free_car == 16
    assert obs.free_motor is None, "-9 must become None; 0 would mean 'lot is full'"


def test_data_ts_minutes_land_on_the_expected_phase():
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    snap = parse_availability(payload, observed_at=1788484280)
    assert (snap.data_ts // 60) % 5 == 3, "feed stamps minutes congruent to 3 (mod 5)"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_feed.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parkcast.feed'`

- [ ] **Step 3: Write `src/parkcast/feed.py`**

```python
"""Parse the Taipei availability endpoint into typed records."""
from dataclasses import dataclass
from datetime import datetime

from parkcast import config
from parkcast.quality import clean_count

_UPDATETIME_FORMAT = "%a %b %d %H:%M:%S CST %Y"


@dataclass(frozen=True, slots=True)
class Observation:
    lot_id: str
    free_car: int | None
    free_motor: int | None


@dataclass(frozen=True, slots=True)
class FeedSnapshot:
    data_ts: int
    observed_at: int
    observations: tuple[Observation, ...]


def parse_updatetime(text: str) -> int:
    """'Fri Sep 04 09:08:00 CST 2026' -> epoch seconds.

    CST in this feed is Taipei (UTC+8), not US Central. Taiwan has no DST,
    so a fixed offset is correct year-round.
    """
    naive = datetime.strptime(text.strip(), _UPDATETIME_FORMAT)
    return int(naive.replace(tzinfo=config.TAIPEI_TZ).timestamp())


def parse_availability(payload: dict, observed_at: int) -> FeedSnapshot:
    data = payload["data"]
    data_ts = parse_updatetime(data["UPDATETIME"])

    seen: set[str] = set()
    observations: list[Observation] = []
    for entry in data["park"]:
        lot_id = entry["id"]
        if lot_id in seen:
            continue
        seen.add(lot_id)
        observations.append(
            Observation(
                lot_id=lot_id,
                free_car=clean_count(entry.get("availablecar")),
                free_motor=clean_count(entry.get("availablemotor")),
            )
        )

    return FeedSnapshot(data_ts, observed_at, tuple(observations))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_feed.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/parkcast/feed.py tests/test_feed.py
git commit -m "feat: parse availability feed into typed snapshots"
```

---

### Task 4: Coordinate resolution

**Files:**
- Create: `src/parkcast/geo.py`
- Create: `tests/test_geo.py`

**Interfaces:**
- Consumes: `config.LAT_MIN`, `config.LAT_MAX`, `config.LON_MIN`, `config.LON_MAX`
- Produces: `resolve_latlon(lot: dict) -> tuple[float, float] | None`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_geo.py
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_geo.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parkcast.geo'`

- [ ] **Step 3: Write `src/parkcast/geo.py`**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_geo.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/parkcast/geo.py tests/test_geo.py
git commit -m "feat: resolve lot coordinates with bounds-checked fallback"
```

---

### Task 5: Parse lot metadata

**Files:**
- Create: `src/parkcast/metadata.py`
- Create: `tests/test_metadata.py`

**Interfaces:**
- Consumes: `geo.resolve_latlon`, `quality.clean_count`
- Produces:
  - `Lot(id, name, area, lot_type, capacity_car, lat, lon, service_time, fare_text)` — frozen dataclass
  - `parse_metadata(payload: dict) -> tuple[Lot, ...]`
  - `capacity_map(lots) -> dict[str, int | None]`
  - `snapshot_metadata(payload: dict, out_dir: Path, day: date) -> Path`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_metadata.py
import json
from datetime import date
from pathlib import Path

from parkcast.metadata import Lot, capacity_map, parse_metadata, snapshot_metadata

FIXTURE = Path(__file__).parent / "fixtures" / "desc_sample.json"


def _payload():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_parses_every_lot_with_coordinates():
    lots = parse_metadata(_payload())
    assert len(lots) > 1700
    assert all(isinstance(lot, Lot) for lot in lots)
    assert all(lot.lat is not None and lot.lon is not None for lot in lots)


def test_lot_ids_are_unique():
    lots = parse_metadata(_payload())
    assert len({lot.id for lot in lots}) == len(lots)


def test_capacity_is_none_when_zero_rather_than_zero():
    """totalcar=0 means 'not a car park', not 'a car park with no spaces'."""
    payload = {"data": {"park": [
        {"id": "X1", "name": "n", "area": "a", "type2": "t", "totalcar": "0",
         "tw97x": "302864.78", "tw97y": "2771988.95"},
    ]}}
    lots = parse_metadata(payload)
    assert lots[0].capacity_car is None


def test_capacity_map_covers_all_lots():
    lots = parse_metadata(_payload())
    caps = capacity_map(lots)
    assert len(caps) == len(lots)
    assert all(v is None or v > 0 for v in caps.values())


def test_lots_without_usable_coordinates_are_dropped():
    payload = {"data": {"park": [
        {"id": "BAD", "name": "n", "area": "a", "type2": "t", "totalcar": "10",
         "tw97x": "0", "tw97y": "0"},
    ]}}
    assert parse_metadata(payload) == ()


def test_snapshot_is_written_once_per_day(tmp_path):
    """Capacity and lot membership drift; keep a dated copy so history survives."""
    payload = _payload()
    first = snapshot_metadata(payload, tmp_path, date(2026, 9, 4))
    assert first.exists() and first.name == "2026-09-04.json"

    first.write_text("SENTINEL", encoding="utf-8")
    again = snapshot_metadata(payload, tmp_path, date(2026, 9, 4))
    assert again.read_text(encoding="utf-8") == "SENTINEL", "must not rewrite an existing day"


def test_snapshot_round_trips_to_the_same_lots(tmp_path):
    path = snapshot_metadata(_payload(), tmp_path, date(2026, 9, 4))
    restored = json.loads(path.read_text(encoding="utf-8"))
    assert parse_metadata(restored) == parse_metadata(_payload())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_metadata.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parkcast.metadata'`

- [ ] **Step 3: Write `src/parkcast/metadata.py`**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_metadata.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/parkcast/metadata.py tests/test_metadata.py
git commit -m "feat: parse lot metadata into typed records"
```

---

### Task 6: SQLite store

**Files:**
- Create: `src/parkcast/store.py`
- Create: `tests/test_store.py`

**Interfaces:**
- Consumes: `feed.FeedSnapshot`, `quality.validate`, `quality.Q`, `config.DB_PATH`, `config.HOT_RETENTION_SEC`
- Produces:
  - `connect(path) -> sqlite3.Connection`
  - `insert_snapshot(conn, snapshot: FeedSnapshot, capacities: dict[str, int | None]) -> int`
  - `latest_data_ts(conn) -> int | None`
  - `prune(conn, cutoff_ts: int) -> int`
  - `count_rows(conn) -> int`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_store.py
import pytest

from parkcast import store
from parkcast.feed import FeedSnapshot, Observation
from parkcast.quality import Q


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def snap(data_ts, observed_at, free_car=16):
    return FeedSnapshot(data_ts, observed_at, (Observation("TPE0001", free_car, None),))


def test_insert_then_read_back(conn):
    assert store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50}) == 1
    row = conn.execute("SELECT lot_id, data_ts, observed_at, free_car FROM observations").fetchone()
    assert tuple(row) == ("TPE0001", 1000, 1180, 16)


def test_reinserting_the_same_tick_is_a_no_op(conn):
    store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50})
    inserted = store.insert_snapshot(conn, snap(1000, 1999), {"TPE0001": 50})
    assert inserted == 0, "duplicate (lot_id, data_ts) must not create a second row"
    assert store.count_rows(conn) == 1


def test_first_observed_at_wins_on_duplicate(conn):
    store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50})
    store.insert_snapshot(conn, snap(1000, 1999), {"TPE0001": 50})
    observed = conn.execute("SELECT observed_at FROM observations").fetchone()[0]
    assert observed == 1180, "must keep the earliest sighting, not overwrite it"


def test_missing_value_stored_as_null_not_zero(conn):
    store.insert_snapshot(conn, snap(1000, 1180, free_car=None), {"TPE0001": 50})
    value, flags = conn.execute("SELECT free_car, quality FROM observations").fetchone()
    assert value is None
    assert Q.MISSING in Q(flags)


def test_overcount_is_clamped_and_flagged(conn):
    store.insert_snapshot(conn, snap(1000, 1180, free_car=80), {"TPE0001": 50})
    value, flags = conn.execute("SELECT free_car, quality FROM observations").fetchone()
    assert value == 50
    assert Q.CLAMPED in Q(flags)


def test_unknown_lot_gets_no_capacity_flag(conn):
    store.insert_snapshot(conn, snap(1000, 1180), {})
    flags = conn.execute("SELECT quality FROM observations").fetchone()[0]
    assert Q.NO_CAPACITY in Q(flags)


def test_latest_data_ts(conn):
    assert store.latest_data_ts(conn) is None
    store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50})
    store.insert_snapshot(conn, snap(1300, 1480), {"TPE0001": 50})
    assert store.latest_data_ts(conn) == 1300


def test_prune_removes_only_old_rows(conn):
    store.insert_snapshot(conn, snap(1000, 1180), {"TPE0001": 50})
    store.insert_snapshot(conn, snap(5000, 5180), {"TPE0001": 50})
    assert store.prune(conn, cutoff_ts=2000) == 1
    assert store.latest_data_ts(conn) == 5000
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parkcast.store'`

- [ ] **Step 3: Write `src/parkcast/store.py`**

```python
"""SQLite hot store: the rolling 48-hour window of observations."""
import sqlite3
from pathlib import Path

from parkcast.feed import FeedSnapshot
from parkcast.quality import validate

_SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
    lot_id      TEXT    NOT NULL,
    data_ts     INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    free_car    INTEGER,
    free_motor  INTEGER,
    quality     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lot_id, data_ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_obs_data_ts ON observations(data_ts);
"""


def connect(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    return conn


def insert_snapshot(
    conn: sqlite3.Connection,
    snapshot: FeedSnapshot,
    capacities: dict[str, int | None],
) -> int:
    """Insert a tick. Returns rows actually written.

    DO NOTHING on conflict: a given (lot_id, data_ts) describes one moment, so
    the first sighting is the truthful observed_at. Re-fetching must not rewrite it.
    """
    rows = []
    for obs in snapshot.observations:
        capacity = capacities.get(obs.lot_id)
        free_car, flags = validate(obs.free_car, capacity)
        free_motor, _ = validate(obs.free_motor, None)
        rows.append(
            (obs.lot_id, snapshot.data_ts, snapshot.observed_at,
             free_car, free_motor, int(flags))
        )

    cursor = conn.executemany(
        """
        INSERT INTO observations
            (lot_id, data_ts, observed_at, free_car, free_motor, quality)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(lot_id, data_ts) DO NOTHING
        """,
        rows,
    )
    return cursor.rowcount


def latest_data_ts(conn: sqlite3.Connection) -> int | None:
    return conn.execute("SELECT MAX(data_ts) FROM observations").fetchone()[0]


def prune(conn: sqlite3.Connection, cutoff_ts: int) -> int:
    cursor = conn.execute("DELETE FROM observations WHERE data_ts < ?", (cutoff_ts,))
    return cursor.rowcount


def count_rows(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_store.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/parkcast/store.py tests/test_store.py
git commit -m "feat: add sqlite hot store with idempotent upserts"
```

---

### Task 7: Collector tick

**Files:**
- Create: `src/parkcast/collector.py`
- Create: `tests/test_collector.py`

**Interfaces:**
- Consumes: `config`, `feed.parse_availability`, `store.*`
- Produces:
  - `TickResult(data_ts: int, rows_written: int, advanced: bool)` — frozen dataclass
  - `fetch_json(url: str, *, timeout: int = config.HTTP_TIMEOUT_SEC) -> dict`
  - `collect_once(conn, capacities, *, now: int | None = None, fetch=fetch_json) -> TickResult`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_collector.py
import json
from pathlib import Path

import pytest

from parkcast import collector, store

FIXTURE = Path(__file__).parent / "fixtures" / "avail_sample.json"


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def fake_fetch(_url, **_kwargs):
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_tick_writes_rows_and_reports_advance(conn):
    result = collector.collect_once(conn, {}, now=1788484280, fetch=fake_fetch)
    assert result.rows_written > 1000
    assert result.advanced is True
    assert store.count_rows(conn) == result.rows_written


def test_repeated_tick_writes_nothing_and_reports_no_advance(conn):
    first = collector.collect_once(conn, {}, now=1788484280, fetch=fake_fetch)
    second = collector.collect_once(conn, {}, now=1788484600, fetch=fake_fetch)
    assert second.rows_written == 0
    assert second.advanced is False, "same data_ts means the feed has not published yet"
    assert store.count_rows(conn) == first.rows_written


def test_observed_at_uses_supplied_now_not_feed_time(conn):
    collector.collect_once(conn, {}, now=1788484280, fetch=fake_fetch)
    data_ts, observed_at = conn.execute(
        "SELECT data_ts, observed_at FROM observations LIMIT 1"
    ).fetchone()
    assert observed_at == 1788484280
    assert data_ts != observed_at, "the two must never be collapsed"


def test_fetch_failure_propagates_rather_than_writing_partial_data(conn):
    def boom(_url, **_kwargs):
        raise ConnectionError("network down")

    with pytest.raises(ConnectionError):
        collector.collect_once(conn, {}, now=1788484280, fetch=boom)
    assert store.count_rows(conn) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_collector.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parkcast.collector'`

- [ ] **Step 3: Write `src/parkcast/collector.py`**

```python
"""One collection tick: fetch, parse, validate, persist."""
import time
from dataclasses import dataclass

import requests

from parkcast import config, store
from parkcast.feed import parse_availability


@dataclass(frozen=True, slots=True)
class TickResult:
    data_ts: int
    rows_written: int
    advanced: bool


def fetch_json(url: str, *, timeout: int = config.HTTP_TIMEOUT_SEC) -> dict:
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    return response.json()


def collect_once(
    conn,
    capacities: dict[str, int | None],
    *,
    now: int | None = None,
    fetch=fetch_json,
) -> TickResult:
    """Fetch one tick and persist it.

    Fetch errors propagate: a failed tick must leave the store untouched rather
    than writing partial data. The caller decides whether to retry.
    """
    observed_at = int(time.time()) if now is None else now
    previous = store.latest_data_ts(conn)

    snapshot = parse_availability(fetch(config.AVAILABILITY_URL), observed_at)
    rows = store.insert_snapshot(conn, snapshot, capacities)

    return TickResult(
        data_ts=snapshot.data_ts,
        rows_written=rows,
        advanced=previous is None or snapshot.data_ts > previous,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_collector.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/parkcast/collector.py tests/test_collector.py
git commit -m "feat: add collector tick with advance detection"
```

---

### Task 8: Phase-aligned scheduler

**Files:**
- Create: `src/parkcast/scheduler.py`
- Create: `tests/test_scheduler.py`

**Interfaces:**
- Consumes: `config.POLL_MINUTE_MOD`, `config.POLL_SECOND`, `config.POLL_PERIOD_MIN`, `config.RETRY_DELAYS_SEC`, `config.HOT_RETENTION_SEC`, `collector.collect_once`, `store.prune`
- Produces:
  - `next_poll_ts(now: int) -> int`
  - `run_forever(conn, capacities, *, collect=..., sleep=time.sleep, now_fn=...) -> None`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_scheduler.py
from parkcast.scheduler import next_poll_ts


def minute_of(ts: int) -> int:
    return (ts // 60) % 60


def second_of(ts: int) -> int:
    return ts % 60


def test_next_slot_lands_on_the_publish_phase():
    """Publication is on minutes congruent to 1 (mod 5); we poll 30s after."""
    ts = next_poll_ts(1788484080)  # 09:08:00 +08:00
    assert minute_of(ts) % 5 == 1
    assert second_of(ts) == 30


def test_next_slot_is_strictly_in_the_future():
    for now in range(1788484080, 1788484080 + 600, 37):
        assert next_poll_ts(now) > now


def test_exact_slot_moment_rolls_to_the_following_slot():
    slot = next_poll_ts(1788484080)
    assert next_poll_ts(slot) == slot + 300


def test_gap_between_consecutive_slots_is_five_minutes():
    a = next_poll_ts(1788484080)
    b = next_poll_ts(a)
    assert b - a == 300


def test_slot_follows_the_feed_by_about_three_and_a_half_minutes():
    """Feed stamps minute ≡3 (mod 5); we should poll ~3.5 min later."""
    data_ts = 1788484080  # minute 8, which is ≡3 (mod 5)
    assert minute_of(data_ts) % 5 == 3
    lag = next_poll_ts(data_ts) - data_ts
    assert 180 <= lag <= 240, f"expected a 3-4 min lag, got {lag}s"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_scheduler.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parkcast.scheduler'`

- [ ] **Step 3: Write `src/parkcast/scheduler.py`**

```python
"""Phase-aligned polling loop.

Minute-of-hour is identical in UTC and UTC+8 because the offset is a whole
number of hours, so slot arithmetic needs no timezone conversion.
"""
import logging
import time

from parkcast import config, store
from parkcast.collector import collect_once

log = logging.getLogger("parkcast.scheduler")


def next_poll_ts(now: int) -> int:
    """The next instant with minute ≡ POLL_MINUTE_MOD (mod 5) at POLL_SECOND."""
    period = config.POLL_PERIOD_MIN * 60
    # Offset, in seconds past the hour, of the first slot in each 5-minute cycle.
    offset = config.POLL_MINUTE_MOD * 60 + config.POLL_SECOND
    elapsed = now - offset
    slots_done = elapsed // period
    return offset + (slots_done + 1) * period


def run_forever(
    conn,
    capacities: dict[str, int | None],
    *,
    collect=collect_once,
    sleep=time.sleep,
    now_fn=lambda: int(time.time()),
) -> None:
    while True:
        target = next_poll_ts(now_fn())
        sleep(max(0, target - now_fn()))

        for delay in (0, *config.RETRY_DELAYS_SEC):
            if delay:
                sleep(delay)
            try:
                result = collect(conn, capacities)
            except Exception:
                log.exception("tick failed; will retry within this slot")
                continue
            if result.advanced:
                log.info("tick data_ts=%s rows=%s", result.data_ts, result.rows_written)
                break
            log.warning("feed has not advanced (data_ts=%s); retrying", result.data_ts)
        else:
            log.error("slot exhausted without a fresh tick")

        removed = store.prune(conn, now_fn() - config.HOT_RETENTION_SEC)
        if removed:
            log.info("pruned %s rows beyond the hot window", removed)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_scheduler.py -v`
Expected: 5 passed.

- [ ] **Step 5: Run the whole suite**

Run: `.venv/Scripts/python -m pytest -v`
Expected: 46 passed.

- [ ] **Step 6: Commit**

```bash
git add src/parkcast/scheduler.py tests/test_scheduler.py
git commit -m "feat: add phase-aligned polling loop with retry"
```

---

### Task 9: Package and GO LIVE

This is the day-one milestone. Once this task lands, data starts accumulating and never stops.

**Files:**
- Create: `src/parkcast/__main__.py`, `docker/Dockerfile`, `docker/docker-compose.yml`, `.dockerignore`
- Modify: `.gitignore` (confirm `data/` is ignored — it already is)

**Interfaces:**
- Consumes: `collector.fetch_json`, `metadata.snapshot_metadata`, `metadata.parse_metadata`, `metadata.capacity_map`, `scheduler.run_forever`, `store.connect`, `config.DB_PATH`, `config.PARQUET_DIR`
- Produces: a console entry point runnable as `python -m parkcast`

- [ ] **Step 1: Write `src/parkcast/__main__.py`**

```python
"""Entry point: python -m parkcast"""
import logging
from datetime import datetime

from parkcast import config, store
from parkcast.collector import fetch_json
from parkcast.metadata import capacity_map, parse_metadata, snapshot_metadata
from parkcast.scheduler import run_forever


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("parkcast")

    conn = store.connect(config.DB_PATH)

    raw_metadata = fetch_json(config.METADATA_URL)
    snapshot_metadata(raw_metadata, config.PARQUET_DIR / "meta", datetime.now(config.TAIPEI_TZ).date())
    capacities = capacity_map(parse_metadata(raw_metadata))
    log.info("loaded capacities for %s lots", len(capacities))

    run_forever(conn, capacities)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke-test one real tick locally**

```bash
.venv/Scripts/python -c "from parkcast import config, store; from parkcast.collector import collect_once, fetch_json; from parkcast.metadata import capacity_map, parse_metadata; c=store.connect(config.DB_PATH); caps=capacity_map(parse_metadata(fetch_json(config.METADATA_URL))); print(collect_once(c, caps))"
```

Expected: a `TickResult` with `rows_written` above 1000 and `advanced=True`. Run it a second time; expect `rows_written=0, advanced=False`.

- [ ] **Step 3: Write `docker/Dockerfile`**

```dockerfile
FROM python:3.13-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

ENV PYTHONUNBUFFERED=1
VOLUME ["/app/data"]
CMD ["python", "-m", "parkcast"]
```

- [ ] **Step 4: Write `docker/docker-compose.yml`**

```yaml
services:
  collector:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    restart: unless-stopped
    volumes:
      - ../data:/app/data
    environment:
      TZ: Asia/Taipei
```

- [ ] **Step 5: Write `.dockerignore`**

```
.venv
data
tests
docs
tasks
.git
__pycache__
```

- [ ] **Step 6: Bring it up and verify it is collecting**

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs -f
```

Expected: within one 5-minute cycle, a log line `tick data_ts=... rows=...` with rows above 1000.

- [ ] **Step 7: Verify persisted rows after two cycles**

```bash
.venv/Scripts/python -c "from parkcast import config, store; c=store.connect(config.DB_PATH); print('rows', store.count_rows(c), 'latest', store.latest_data_ts(c))"
```

Expected: `rows` above 2000 and growing, and distinct `data_ts` values 300 seconds apart.

- [ ] **Step 8: Commit**

```bash
git add src/parkcast/__main__.py docker .dockerignore
git commit -m "feat: package collector for continuous operation"
```

---

### Task 10: Daily Parquet compaction

**Files:**
- Create: `src/parkcast/compact.py`
- Create: `tests/test_compact.py`

**Interfaces:**
- Consumes: `store`, `config.PARQUET_DIR`, `config.TAIPEI_TZ`
- Produces:
  - `day_bounds(day: date) -> tuple[int, int]`
  - `compact_day(conn, day: date, out_dir: Path) -> Path | None`
  - Parquet schema: `lot_id: str`, `date: str`, `free_car: list[int32]` (288 slots, null for gaps), `quality: list[int16]`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_compact.py
from datetime import date

import pyarrow.parquet as pq
import pytest

from parkcast import store
from parkcast.compact import compact_day, day_bounds
from parkcast.feed import FeedSnapshot, Observation


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def test_day_bounds_span_exactly_24_hours_in_taipei():
    start, end = day_bounds(date(2026, 9, 4))
    assert end - start == 86400
    assert start % 86400 == 16 * 3600, "a Taipei day starts at 16:00 UTC the day before"


def test_compaction_produces_288_slots_per_lot(conn, tmp_path):
    start, _ = day_bounds(date(2026, 9, 4))
    for i in (0, 1, 5):
        ts = start + i * 300
        store.insert_snapshot(
            conn, FeedSnapshot(ts, ts + 200, (Observation("A", 10 + i, None),)), {"A": 50}
        )

    path = compact_day(conn, date(2026, 9, 4), tmp_path)
    table = pq.read_table(path)
    row = table.to_pylist()[0]

    assert len(row["free_car"]) == 288
    assert row["free_car"][0] == 10
    assert row["free_car"][1] == 11
    assert row["free_car"][5] == 15


def test_gaps_are_null_never_interpolated(conn, tmp_path):
    start, _ = day_bounds(date(2026, 9, 4))
    for i in (0, 5):
        ts = start + i * 300
        store.insert_snapshot(
            conn, FeedSnapshot(ts, ts + 200, (Observation("A", 10 + i, None),)), {"A": 50}
        )

    row = pq.read_table(compact_day(conn, date(2026, 9, 4), tmp_path)).to_pylist()[0]
    assert row["free_car"][1] is None, "slot 1 was never observed and must stay null"
    assert row["free_car"][2] is None
    assert row["free_car"][15] is None


def test_empty_day_produces_no_file(conn, tmp_path):
    assert compact_day(conn, date(2026, 9, 4), tmp_path) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_compact.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parkcast.compact'`

- [ ] **Step 3: Write `src/parkcast/compact.py`**

```python
"""Roll a completed day out of SQLite into a compact Parquet file.

One row per (lot, day), holding a 288-slot array at 5-minute resolution.
Unobserved slots stay null: interpolated data that looks real is worse than
missing data that looks missing.
"""
from datetime import date, datetime, time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from parkcast import config

SLOTS_PER_DAY = 288
SLOT_SECONDS = 300

_SCHEMA = pa.schema([
    ("lot_id", pa.string()),
    ("date", pa.string()),
    ("free_car", pa.list_(pa.int32(), SLOTS_PER_DAY)),
    ("quality", pa.list_(pa.int16(), SLOTS_PER_DAY)),
])


def day_bounds(day: date) -> tuple[int, int]:
    """[start, end) epoch seconds for a calendar day in Taipei."""
    start = int(datetime.combine(day, time.min, config.TAIPEI_TZ).timestamp())
    return start, start + SLOTS_PER_DAY * SLOT_SECONDS


def compact_day(conn, day: date, out_dir: Path) -> Path | None:
    start, end = day_bounds(day)
    rows = conn.execute(
        """
        SELECT lot_id, data_ts, free_car, quality
        FROM observations
        WHERE data_ts >= ? AND data_ts < ?
        ORDER BY lot_id, data_ts
        """,
        (start, end),
    ).fetchall()

    if not rows:
        return None

    free: dict[str, list[int | None]] = {}
    flags: dict[str, list[int | None]] = {}
    for lot_id, data_ts, free_car, quality in rows:
        slot = (data_ts - start) // SLOT_SECONDS
        if not 0 <= slot < SLOTS_PER_DAY:
            continue
        free.setdefault(lot_id, [None] * SLOTS_PER_DAY)[slot] = free_car
        flags.setdefault(lot_id, [None] * SLOTS_PER_DAY)[slot] = quality

    lot_ids = sorted(free)
    table = pa.table(
        {
            "lot_id": lot_ids,
            "date": [day.isoformat()] * len(lot_ids),
            "free_car": [free[k] for k in lot_ids],
            "quality": [flags[k] for k in lot_ids],
        },
        schema=_SCHEMA,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{day.isoformat()}.parquet"
    pq.write_table(table, path, compression="zstd")
    return path
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_compact.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/parkcast/compact.py tests/test_compact.py
git commit -m "feat: compact completed days into parquet"
```

---

### Task 11: Data-quality report

**Files:**
- Create: `src/parkcast/report.py`
- Create: `tests/test_report.py`

**Interfaces:**
- Consumes: `store`, `quality.Q`, `compact.SLOTS_PER_DAY`, `compact.day_bounds`
- Produces:
  - `DayReport(day, ticks_seen, ticks_expected, lots_seen, missing_pct, clamped, frozen_lots)` — frozen dataclass
  - `build_report(conn, day: date) -> DayReport`
  - `find_frozen_lots(conn, day: date, *, min_run: int = 72) -> list[str]`
  - `format_report(report: DayReport) -> str`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_report.py
from datetime import date

import pytest

from parkcast import store
from parkcast.compact import day_bounds
from parkcast.feed import FeedSnapshot, Observation
from parkcast.report import build_report, find_frozen_lots, format_report


@pytest.fixture
def conn(tmp_path):
    c = store.connect(tmp_path / "t.sqlite")
    yield c
    c.close()


def write(conn, slot, lot="A", free=10):
    start, _ = day_bounds(date(2026, 9, 4))
    ts = start + slot * 300
    store.insert_snapshot(conn, FeedSnapshot(ts, ts + 200, (Observation(lot, free, None),)), {lot: 50})


def test_counts_ticks_and_reports_gaps(conn):
    for slot in (0, 1, 2):
        write(conn, slot)
    report = build_report(conn, date(2026, 9, 4))
    assert report.ticks_seen == 3
    assert report.ticks_expected == 288
    assert report.lots_seen == 1


def test_missing_percentage_counts_nulls(conn):
    write(conn, 0, free=10)
    write(conn, 1, free=None)
    report = build_report(conn, date(2026, 9, 4))
    assert report.missing_pct == pytest.approx(50.0)


def test_frozen_lot_detected_after_long_unchanged_run(conn):
    for slot in range(80):
        write(conn, slot, lot="STUCK", free=7)
    for slot in range(80):
        write(conn, slot, lot="FINE", free=slot)
    frozen = find_frozen_lots(conn, date(2026, 9, 4), min_run=72)
    assert "STUCK" in frozen
    assert "FINE" not in frozen


def test_short_unchanged_run_is_not_frozen(conn):
    """A genuinely quiet lot overnight should not be flagged."""
    for slot in range(20):
        write(conn, slot, lot="QUIET", free=7)
    assert find_frozen_lots(conn, date(2026, 9, 4), min_run=72) == []


def test_format_report_is_human_readable(conn):
    write(conn, 0)
    text = format_report(build_report(conn, date(2026, 9, 4)))
    assert "2026-09-04" in text
    assert "ticks" in text.lower()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_report.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parkcast.report'`

- [ ] **Step 3: Write `src/parkcast/report.py`**

```python
"""Daily data-quality summary: coverage, gaps, and suspect sensors."""
from dataclasses import dataclass
from datetime import date

from parkcast.compact import SLOTS_PER_DAY, day_bounds
from parkcast.quality import Q


@dataclass(frozen=True, slots=True)
class DayReport:
    day: date
    ticks_seen: int
    ticks_expected: int
    lots_seen: int
    missing_pct: float
    clamped: int
    frozen_lots: tuple[str, ...]


def find_frozen_lots(conn, day: date, *, min_run: int = 72) -> list[str]:
    """Lots whose value never changed across at least `min_run` observations.

    72 slots is six hours. A lot that never moves for six hours is far more
    likely to have a broken sensor than to be genuinely static, and undetected
    it becomes a confidently wrong prediction.
    """
    start, end = day_bounds(day)
    rows = conn.execute(
        """
        SELECT lot_id, COUNT(*) AS n, COUNT(DISTINCT free_car) AS distinct_values
        FROM observations
        WHERE data_ts >= ? AND data_ts < ? AND free_car IS NOT NULL
        GROUP BY lot_id
        """,
        (start, end),
    ).fetchall()
    return [lot_id for lot_id, n, distinct in rows if n >= min_run and distinct == 1]


def build_report(conn, day: date) -> DayReport:
    start, end = day_bounds(day)
    window = (start, end)

    ticks_seen = conn.execute(
        "SELECT COUNT(DISTINCT data_ts) FROM observations WHERE data_ts >= ? AND data_ts < ?",
        window,
    ).fetchone()[0]
    lots_seen = conn.execute(
        "SELECT COUNT(DISTINCT lot_id) FROM observations WHERE data_ts >= ? AND data_ts < ?",
        window,
    ).fetchone()[0]
    total, missing, clamped = conn.execute(
        """
        SELECT COUNT(*),
               SUM(CASE WHEN free_car IS NULL THEN 1 ELSE 0 END),
               SUM(CASE WHEN quality & ? THEN 1 ELSE 0 END)
        FROM observations WHERE data_ts >= ? AND data_ts < ?
        """,
        (int(Q.CLAMPED), start, end),
    ).fetchone()

    return DayReport(
        day=day,
        ticks_seen=ticks_seen,
        ticks_expected=SLOTS_PER_DAY,
        lots_seen=lots_seen,
        missing_pct=(100.0 * (missing or 0) / total) if total else 0.0,
        clamped=clamped or 0,
        frozen_lots=tuple(find_frozen_lots(conn, day)),
    )


def format_report(report: DayReport) -> str:
    coverage = 100.0 * report.ticks_seen / report.ticks_expected
    return "\n".join([
        f"ParkCast data quality — {report.day.isoformat()}",
        f"  ticks      {report.ticks_seen}/{report.ticks_expected} ({coverage:.1f}% coverage)",
        f"  lots       {report.lots_seen}",
        f"  missing    {report.missing_pct:.2f}% of readings",
        f"  clamped    {report.clamped}",
        f"  frozen     {len(report.frozen_lots)} lots",
    ])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_report.py -v`
Expected: 5 passed.

- [ ] **Step 5: Run the full suite**

Run: `.venv/Scripts/python -m pytest -v`
Expected: 55 passed.

- [ ] **Step 6: Commit**

```bash
git add src/parkcast/report.py tests/test_report.py
git commit -m "feat: add daily data-quality report"
```

---

## Definition of done for Plan 1

- [ ] Collector has been running continuously for 24 hours without gaps
- [ ] `python -m parkcast` reports a fresh tick every 5 minutes
- [ ] Full test suite passes (55 tests)
- [ ] `build_report` shows coverage above 99% for a complete day
- [ ] A day has been compacted to Parquet and reads back with 288 slots per lot

## Follow-on plans (written at their cut lines, not now)

- **Plan 2 — Forecast artifacts:** persistence and climatology baselines, grid generation, `grid.bin` / `lots.json` publishing
- **Plan 3 — PWA:** destination input, expected-cost ranker, ranked list, map, time-scrubber
- **Plan 4 — Model and evaluation:** feature engineering, backtest harness, LightGBM, calibration, reliability diagram

---

## Review

_(Populated as tasks complete.)_
