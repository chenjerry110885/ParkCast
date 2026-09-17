# ParkCast — the nationwide collector

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The UI-redesign todo is archived at `docs/superpowers/plans/2026-09-15-ui-redesign-archive.md`.

**Goal:** Collect parking availability for six Taiwanese cities instead of one — about 7,000 lots against 1,090 — and publish one artifact shard per city.

**Architecture:** One adapter per city behind a `Source` protocol, each owning its transport, its field names and its own not-reporting sentinel, all normalised to `None`. `data_ts` moves from the tick to the observation, because the six cities publish on six clocks. Lot ids are namespaced `city:feedid` in the store and written bare into that city's artifact shard, so Taipei's published files do not change by a byte.

**Tech Stack:** Python 3.13+, `requests`, SQLite, pyarrow. No new dependency.

**Spec:** [`docs/superpowers/specs/2026-09-16-nationwide-collector-design.md`](../docs/superpowers/specs/2026-09-16-nationwide-collector-design.md)
**Verified endpoint facts:** [`docs/research/2026-09-16-city-parking-feeds.md`](../docs/research/2026-09-16-city-parking-feeds.md) — every URL, field name and sentinel below was fetched live on 2026-09-16.

## Global Constraints

- **Free sources only.** No API key, no account, no paid tier. Never add one.
- **One request per city per tick**, `User-Agent: parkcast-collector/1`, `allow_redirects=False`, and the existing `MAX_FEED_BYTES` cap on every body.
- **A failing city must not disturb the others, and must never disturb Taipei** — it is the only corpus that exists.
- **`None` is the only representation of "not reporting"** that reaches the store. Each city's sentinel (`-9`, `-1`, `-2`, JSON `null`, missing key) is normalised in its adapter and nowhere else.
- **Never read or write anything under `data/`** during development — a live collector owns it. Tests use `tmp_path`.
- **Taipei's published artifacts must not change.** Its shard is byte-compared against the pre-change output in Task 11.
- **Never commit** unless a task's final step says to. Run `python -m pytest` from the repo root; the host Python has no pytest, so use the container recipe in `docker/README.md` if a bare run fails.

---

## File structure

| Path | Responsibility |
|---|---|
| `src/parkcast/sources/__init__.py` | the `Source` protocol, `SourceTick`, the `SOURCES` registry |
| `src/parkcast/sources/http.py` | `get_json`, `post_json` — transport, size caps, no redirects |
| `src/parkcast/sources/taipei.py` … `hsinchu.py` | one adapter per city: transport, field names, sentinel |
| `src/parkcast/ids.py` | `qualify(city, raw)`, `bare(lot_id)`, `city_of(lot_id)` |
| `tests/fixtures/sources/<city>.json` | a recorded payload per city, trimmed, including its sentinel cases |
| `src/parkcast/feed.py` | `Observation` and `FeedSnapshot` — widened, not replaced |
| `src/parkcast/store.py` | the `city` column, the `sources` table, the one-time migration |
| `src/parkcast/artifacts.py` | shard filenames, bare ids, `cities.json` |
| `src/parkcast/scheduler.py` | the per-source tick loop and per-city publishing |
| `src/parkcast/report.py` | per-source health |

---

### Task 1: `data_ts` moves to the observation

The six cities time-stamp differently: Taipei stamps the whole feed, New Taipei stamps every record, Kaohsiung stamps nothing. A single `data_ts` per tick can only be a lie for five of them.

**Files:**
- Modify: `src/parkcast/feed.py:11-23` (the two dataclasses), `src/parkcast/feed.py:35-54` (`parse_availability`)
- Modify: `src/parkcast/store.py:38-81` (`insert_snapshot`)
- Test: `tests/test_feed.py`, `tests/test_store.py`

**Interfaces:**
- Produces: `Observation(lot_id, free_car, free_motor, data_ts: int, ts_kind: str)` where `ts_kind` is exactly one of `"record"`, `"feed"`, `"fetch"`; `FeedSnapshot(city: str, observed_at: int, observations: tuple[Observation, ...])` with a `latest_data_ts` property returning `max(o.data_ts)` or `0` when empty. **`FeedSnapshot` no longer has a `data_ts` field.**

- [ ] **Step 1: Write the failing test**

```python
# tests/test_feed.py
def test_each_observation_carries_its_own_timestamp_and_its_kind():
    payload = {"data": {"UPDATETIME": "Fri Sep 04 09:08:00 CST 2026",
                        "park": [{"id": "TPE0001", "availablecar": 5, "availablemotor": -9}]}}
    snap = parse_availability(payload, observed_at=1757000000)
    obs = snap.observations[0]
    assert obs.data_ts == parse_updatetime("Fri Sep 04 09:08:00 CST 2026")
    # Taipei stamps the feed, not the record -- say so, so a model can exclude it later.
    assert obs.ts_kind == "feed"
    assert snap.latest_data_ts == obs.data_ts
    assert snap.city == "taipei"


def test_latest_data_ts_is_zero_for_an_empty_feed():
    assert FeedSnapshot(city="taipei", observed_at=1, observations=()).latest_data_ts == 0
```

- [ ] **Step 2: Run it and watch it fail**

Run: `python -m pytest tests/test_feed.py -v`
Expected: FAIL — `Observation.__init__() got an unexpected keyword argument 'data_ts'`

- [ ] **Step 3: Widen the dataclasses**

```python
# src/parkcast/feed.py
TS_RECORD = "record"   # the feed stamped this lot
TS_FEED = "feed"       # the feed stamped the whole payload
TS_FETCH = "fetch"     # the feed stamped nothing; this is when we asked

@dataclass(frozen=True, slots=True)
class Observation:
    lot_id: str
    free_car: int | None
    free_motor: int | None
    data_ts: int
    # Which of the three above produced `data_ts`. A fetch-time stamp is an
    # assumption, not a reading, and a backtest must be able to exclude it.
    ts_kind: str


@dataclass(frozen=True, slots=True)
class FeedSnapshot:
    city: str
    observed_at: int
    observations: tuple[Observation, ...]

    @property
    def latest_data_ts(self) -> int:
        return max((o.data_ts for o in self.observations), default=0)
```

Then in `parse_availability`, compute `data_ts` once as now and pass `data_ts=data_ts, ts_kind=TS_FEED` into each `Observation`, and return `FeedSnapshot(city="taipei", observed_at=observed_at, observations=tuple(observations))`.

- [ ] **Step 4: Make the store write the per-row timestamp**

In `insert_snapshot`, replace `snapshot.data_ts` in the row tuple with `obs.data_ts`. Everything else — the `BEGIN IMMEDIATE`, the `DO NOTHING`, the validate calls — is unchanged.

- [ ] **Step 5: Fix every caller the change breaks**

`collect_once` returns `TickResult(data_ts=snapshot.latest_data_ts, ...)`. Search for `\.data_ts` and `FeedSnapshot(` across `src/` and `tests/` and update each. Do not change behaviour anywhere else.

- [ ] **Step 6: Run the whole suite**

Run: `python -m pytest`
Expected: PASS, 355+ tests. Any test asserting a single tick timestamp should now read it from `latest_data_ts`.

- [ ] **Step 7: Commit**

```bash
git add src/parkcast/feed.py src/parkcast/store.py tests/
git commit -m "refactor(feed): carry data_ts per observation, with its provenance"
```

---

### Task 2: namespaced ids, the `city` column, the `sources` table

**Files:**
- Create: `src/parkcast/ids.py`, `tests/test_ids.py`
- Modify: `src/parkcast/store.py:8-35` (schema), `:38-81` (insert), `:84-110` (queries)
- Test: `tests/test_store.py`

**Interfaces:**
- Produces: `ids.qualify(city: str, raw: str) -> str` → `"taipei:TPE0001"`; `ids.bare(lot_id: str) -> str` → `"TPE0001"`; `ids.city_of(lot_id: str) -> str` → `"taipei"`. `store.migrate_to_namespaced_ids(conn, city: str = "taipei") -> int` returning rows rewritten. `store.record_source_health(conn, city, *, observed_at, rows, usable, newest_ts, ok: bool) -> None`. `store.source_health(conn) -> dict[str, dict]`. `store.latest_data_ts(conn, city: str | None = None)`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_ids.py
import pytest
from parkcast.ids import bare, city_of, qualify

def test_round_trips_and_keeps_colons_in_the_feed_id():
    assert qualify("taipei", "TPE0001") == "taipei:TPE0001"
    assert bare("taipei:TPE0001") == "TPE0001"
    assert city_of("taipei:TPE0001") == "taipei"
    # Kaohsiung ids contain no colon today, but a feed id that did must survive.
    assert bare("kaohsiung:PL:0001") == "PL:0001"

def test_rejects_an_unqualified_id():
    with pytest.raises(ValueError):
        city_of("TPE0001")
```

```python
# tests/test_store.py
def test_migration_namespaces_every_row_once(tmp_path):
    conn = store.connect(tmp_path / "hot.sqlite")
    conn.execute("INSERT INTO observations (lot_id, city, data_ts, observed_at, free_car, free_motor, quality)"
                 " VALUES ('TPE0001', '', 100, 100, 5, NULL, 0)")
    assert store.migrate_to_namespaced_ids(conn) == 1
    row = conn.execute("SELECT lot_id, city FROM observations").fetchone()
    assert row == ("taipei:TPE0001", "taipei")
    # Idempotent: a second run must not double-prefix.
    assert store.migrate_to_namespaced_ids(conn) == 0
    assert conn.execute("SELECT lot_id FROM observations").fetchone()[0] == "taipei:TPE0001"

def test_source_health_round_trips(tmp_path):
    conn = store.connect(tmp_path / "hot.sqlite")
    store.record_source_health(conn, "tainan", observed_at=200, rows=268, usable=190, newest_ts=199, ok=True)
    health = store.source_health(conn)["tainan"]
    assert (health["rows"], health["usable"], health["ok"]) == (268, 190, True)
```

- [ ] **Step 2: Run them and watch them fail**

Run: `python -m pytest tests/test_ids.py tests/test_store.py -v`
Expected: FAIL — no module `parkcast.ids`; `observations` has no column `city`.

- [ ] **Step 3: Write `ids.py`**

```python
"""Lot identity across cities.

Two cities use bare numeric ids -- New Taipei's `010001` and Tainan's `1` --
so a feed id alone cannot name a lot. The store namespaces every id; the
published artifacts strip it again, because each shard is one city and the
app's stored recents key on the id it already knows.
"""
SEPARATOR = ":"


def qualify(city: str, raw: str) -> str:
    return f"{city}{SEPARATOR}{raw}"


def city_of(lot_id: str) -> str:
    city, sep, _ = lot_id.partition(SEPARATOR)
    if not sep:
        raise ValueError(f"lot id {lot_id!r} is not namespaced")
    return city


def bare(lot_id: str) -> str:
    """The feed's own id. `partition`, not `split`, so a feed id containing a
    colon comes back whole rather than truncated at its first one."""
    _, sep, raw = lot_id.partition(SEPARATOR)
    if not sep:
        raise ValueError(f"lot id {lot_id!r} is not namespaced")
    return raw
```

- [ ] **Step 4: Extend the schema**

Add to `_SCHEMA` in `store.py`, leaving the existing statements untouched:

```sql
CREATE TABLE IF NOT EXISTS sources (
    city        TEXT    NOT NULL PRIMARY KEY,
    first_ts    INTEGER,
    last_ts     INTEGER,
    last_rows   INTEGER NOT NULL DEFAULT 0,
    last_usable INTEGER NOT NULL DEFAULT 0,
    last_ok     INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
```

`observations` needs a `city` column. `ALTER TABLE ... ADD COLUMN` cannot be written inside `CREATE TABLE IF NOT EXISTS`, so add it conditionally in `connect`, after `executescript`:

```python
    columns = {row[1] for row in conn.execute("PRAGMA table_info(observations)")}
    if "city" not in columns:
        # Existing rows are Taipei's -- it is the only city ever collected --
        # and the migration below rewrites both this and the id.
        conn.execute("ALTER TABLE observations ADD COLUMN city TEXT NOT NULL DEFAULT ''")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_obs_city_ts ON observations(city, data_ts)")
```

- [ ] **Step 5: Write the migration and the health functions**

```python
def migrate_to_namespaced_ids(conn: sqlite3.Connection, city: str = "taipei") -> int:
    """Prefix every un-namespaced row's id, once. Returns rows rewritten.

    One transaction: a half-migrated store has two id conventions in one table
    and every later query silently reads half the corpus. Idempotent, because
    the collector may restart mid-day and this runs at startup.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.execute(
            "UPDATE observations SET lot_id = ? || lot_id, city = ? "
            "WHERE instr(lot_id, ?) = 0",
            (f"{city}{ids.SEPARATOR}", city, ids.SEPARATOR),
        )
        rewritten = cursor.rowcount
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
    return rewritten
```

`record_source_health` is an `INSERT ... ON CONFLICT(city) DO UPDATE`, setting `first_ts = COALESCE(first_ts, excluded.first_ts)` so the first sighting is never overwritten. `source_health` returns `{city: {"first_ts":…, "last_ts":…, "rows":…, "usable":…, "ok": bool}}`.

- [ ] **Step 6: Make `insert_snapshot` write the city**

Add `city` to the INSERT column list and to each row tuple, taking it from `snapshot.city`. Give `latest_data_ts` and `oldest_data_ts` an optional `city: str | None = None` that adds `WHERE city = ?` when given — the new index serves it.

- [ ] **Step 7: Run the tests**

Run: `python -m pytest tests/test_ids.py tests/test_store.py -v`
Expected: PASS.

- [ ] **Step 8: Run the whole suite and commit**

```bash
python -m pytest
git add src/parkcast/ids.py src/parkcast/store.py tests/
git commit -m "feat(store): namespace lot ids by city, and track per-source health"
```

---

### Task 3: the `Source` protocol and its transport

**Files:**
- Create: `src/parkcast/sources/__init__.py`, `src/parkcast/sources/http.py`, `tests/test_sources_http.py`

**Interfaces:**
- Produces:

```python
@dataclass(frozen=True, slots=True)
class SourceTick:
    snapshot: FeedSnapshot
    # The roster this tick carried, or None when the city publishes its metadata
    # separately (Taipei). Five of six feeds answer both questions in one
    # request, and fetching twice would double the load for no new fact.
    lots: tuple[Lot, ...] | None


class Source(Protocol):
    city: str
    def fetch(self, *, now: int) -> SourceTick: ...
```

  plus `sources.http.get_json(url, *, timeout, max_bytes) -> object` and `sources.http.post_json(url, *, body: bytes = b"", content_type: str | None = None, timeout, max_bytes) -> object`, and `SOURCES: dict[str, Source]` (populated in Task 10).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sources_http.py
def test_post_json_sends_an_explicit_content_length(monkeypatch):
    seen = {}
    class FakeResponse:
        status_code = 200
        is_redirect = False
        headers = {"Content-Length": "2"}
        def raise_for_status(self): pass
        def iter_content(self, chunk_size): yield b"{}"
        def __enter__(self): return self
        def __exit__(self, *a): return False
    def fake_post(url, **kwargs):
        seen.update(kwargs); seen["url"] = url
        return FakeResponse()
    monkeypatch.setattr(http.requests, "post", fake_post)

    assert http.post_json("https://example.test/x") == {}
    # New Taipei answers 411 without it.
    assert seen["headers"]["Content-Length"] == "0"
    assert seen["headers"]["User-Agent"] == "parkcast-collector/1"
    assert seen["allow_redirects"] is False
```

- [ ] **Step 2: Run it and watch it fail**

Run: `python -m pytest tests/test_sources_http.py -v`
Expected: FAIL — no module `parkcast.sources.http`.

- [ ] **Step 3: Write `http.py`**

Lift the body-reading loop out of `collector.fetch_json` verbatim — the redirect refusal, the declared-length check, the streaming cap — into one private `_read(response, max_bytes) -> bytes`, and expose `get_json` and `post_json` over it. Both send `headers={"User-Agent": "parkcast-collector/1", ...}` and `allow_redirects=False`. `post_json` always sets `Content-Length` explicitly (`str(len(body))`), because New Taipei's IIS answers **411 Length Required** to a POST without one.

`collector.fetch_json` stays where it is and keeps working — Task 4 moves Taipei onto `get_json`.

- [ ] **Step 4: Write `__init__.py`** with `SourceTick`, the `Source` protocol and an empty `SOURCES: dict[str, Source] = {}`.

- [ ] **Step 5: Run the test, then the suite**

Run: `python -m pytest tests/test_sources_http.py -v` then `python -m pytest`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/parkcast/sources/ tests/test_sources_http.py
git commit -m "feat(sources): a Source protocol and its transport"
```

---

### Tasks 4-9: one adapter per city

**Every adapter task has the same six steps.** They differ only in the table that follows. Read your own task's table; do not read another's.

Each adapter is a module `src/parkcast/sources/<city>.py` exposing:

```python
CITY = "<city>"
URL = "<endpoint>"

def parse(payload: object, *, now: int) -> SourceTick: ...     # pure, no network

class Source:
    city = CITY
    def fetch(self, *, now: int) -> SourceTick:
        return parse(http.get_json(URL), now=now)              # or post_json
```

**The six steps, for every adapter:**

- [ ] **Step 1: Record the fixture.** Fetch the endpoint once with `curl`, and save a **trimmed** copy to `tests/fixtures/sources/<city>.json` — keep 15–25 records chosen to include: at least one lot reporting a real car count, at least one showing the city's not-reporting sentinel, and (where the city has one) at least one with a real motorcycle count. Preserve the payload's exact envelope. Record the byte size of the full response in a comment at the top of the test file.
- [ ] **Step 2: Write the failing test** against the fixture — a test that asserts the parsed counts, the sentinel mapped to `None`, the id namespacing, the coordinates, and the `ts_kind`. No network in the test.
- [ ] **Step 3: Run it and watch it fail** (`python -m pytest tests/test_sources_<city>.py -v`).
- [ ] **Step 4: Write the adapter** per your table.
- [ ] **Step 5: Run the test, then the whole suite.**
- [ ] **Step 6: Commit** — `git commit -m "feat(sources): collect <City>"`.

**A worked example of Step 2**, for New Taipei — the trickiest of the six. Yours differs only in the field names and the sentinel from your own table:

```python
# tests/test_sources_newtaipei.py
# Full live response on 2026-09-16: 500,802 bytes, 3,824 records.
import json
from pathlib import Path

from parkcast.sources import newtaipei

FIXTURE = json.loads((Path(__file__).parent / "fixtures/sources/newtaipei.json").read_text(encoding="utf-8"))


def test_parses_counts_namespaces_ids_and_stamps_each_record():
    tick = newtaipei.parse(FIXTURE, now=1_758_000_000)
    by_id = {o.lot_id: o for o in tick.snapshot.observations}

    live = by_id["newtaipei:010001"]
    assert live.free_car == 33
    assert live.ts_kind == "record"          # recdate/rectime, not our clock
    assert live.data_ts == 1_789_000_000     # replace with the fixture's own stamp
    assert tick.snapshot.city == "newtaipei"

    # null, -1 and -2 all mean "not reporting" and must arrive as None -- never
    # as a number, and never dropped: "seen, reported nothing" is a fact.
    for lot_id in ("newtaipei:010099", "newtaipei:010098"):
        assert by_id[lot_id].free_car is None

    # New Taipei publishes motorcycle capacity but never a live count.
    assert all(o.free_motor is None for o in tick.snapshot.observations)


def test_carries_its_own_roster_with_usable_coordinates():
    tick = newtaipei.parse(FIXTURE, now=1_758_000_000)
    assert tick.lots is not None
    lot = next(l for l in tick.lots if l.id == "newtaipei:010001")
    assert lot.name == "莊敬立體停車場"
    assert 24.0 < lot.lat < 25.5 and 121.0 < lot.lon < 122.5
    assert lot.capacity_car == 41            # carNum, not NowCarSpace


def test_a_record_with_an_unparseable_stamp_falls_back_to_the_fetch_time():
    broken = [dict(FIXTURE[0], recdate="badvalue", rectime="??????")]
    obs = newtaipei.parse(broken, now=1_758_000_000).snapshot.observations[0]
    assert obs.data_ts == 1_758_000_000
    assert obs.ts_kind == "fetch"
```

**Rules binding every adapter:**

- Emit `lot_id=ids.qualify(CITY, <feed id>)` on both the `Observation` and the `Lot`.
- Map the city's sentinel to `None` **here and nowhere else**. A count of `0` is a real reading and must survive.
- Drop a lot with no usable coordinates, exactly as `metadata.parse_metadata` does — it cannot be ranked by distance. Sanity-check against `config.LAT_MIN/LAT_MAX/LON_MIN/LON_MAX`? **No** — those are Taipei's box. Use a Taiwan box: lat 21.5–25.5, lon 118.0–122.5, added to `config` as `TW_LAT_MIN` etc. in Task 4.
- A duplicate feed id within one payload keeps its first occurrence, as Taipei's parser already does.
- `Lot.capacity_car` follows the existing convention: `0` means "not a car park" → `None` with `serves_cars=False`; a missing or sentinel value means "not reported" → `None` with `serves_cars=True`.

#### Task 4: 臺北市 Taipei

| | |
|---|---|
| Transport | `GET https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json` |
| Records at | `payload["data"]["park"]` |
| Lot id | `id` |
| Car free | `availablecar` | 
| Motor free | `availablemotor` |
| Sentinel | `-9` (already handled by `quality.clean_count`) |
| Timestamp | `payload["data"]["UPDATETIME"]` via `parse_updatetime`, `ts_kind="feed"` |
| Roster | `None` — Taipei keeps its separate daily `METADATA_URL` path, unchanged |

This task **moves** `parse_availability` from `feed.py` into `sources/taipei.py` and adapts it to return a `SourceTick`; `feed.py` keeps only the dataclasses and `parse_updatetime`. Update `tests/test_feed.py` imports accordingly. Also add the `TW_*` bounding box to `config.py` and a `sources/geo.py` helper `in_taiwan(lat, lon) -> bool` used by every later adapter.

#### Task 5: 新北市 New Taipei

| | |
|---|---|
| Transport | `POST https://www.parkinginfo.ntpc.gov.tw/parkinginfo/public/getSpot.ashx`, empty body — **`Content-Length: 0` is required or the server answers 411** |
| Records at | the top-level JSON array |
| Lot id | `parkingLotId` |
| Car free | `NowCarSpace` |
| Motor free | none — New Taipei publishes motorcycle **capacity** only |
| Sentinel | JSON `null`, `-1`, `-2` → all `None` |
| Timestamp | per record: `recdate` (ROC, `1150916` = ROC year 115 → 2026-09-16) + `rectime` (`HHMMSS`), Taipei time, `ts_kind="record"`. A record whose date or time will not parse falls back to `now` with `ts_kind="fetch"` |
| Coordinates | `Lat`, `Lng` — WGS84 decimal **strings**, already correct |
| Roster | name `parkingLotName`, area from `parkinglotAddress` (the district substring ending in `區`), capacity `carNum`, fare `chargingstandard`, type `operationType` |

ROC-date conversion, with a test of its own:

```python
def _roc_timestamp(recdate: str, rectime: str) -> int | None:
    """'1150916' + '094529' -> epoch seconds, Taipei. None if unparseable."""
    if len(recdate) != 7 or len(rectime) != 6 or not (recdate + rectime).isdigit():
        return None
    year = int(recdate[:3]) + 1911
    try:
        stamp = datetime(year, int(recdate[3:5]), int(recdate[5:7]),
                         int(rectime[:2]), int(rectime[2:4]), int(rectime[4:6]),
                         tzinfo=config.TAIPEI_TZ)
    except ValueError:
        return None
    return int(stamp.timestamp())
```

The full response is ~500 KB, 3,824 records, of which about 1,920 carry a usable `NowCarSpace`.

#### Task 6: 高雄市 Kaohsiung

| | |
|---|---|
| Transport | `POST https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLotPost`, body `b"{}"`, `Content-Type: application/json` |
| Records at | `payload["parkingLots"]` |
| Lot id | `id` (e.g. `PL_KHB00035`) |
| Car free | `smallcarVacancy` |
| Motor free | `motorcycleVacancy` |
| Sentinel | `-1` and `-2` → `None` (**not** `-9`) |
| Timestamp | none in the feed → `now`, `ts_kind="fetch"` |
| Coordinates | `lat`, `lng` — decimal strings |
| Roster | name `name`, area `areaname`, capacity `volumnAuto` (fall back to `volumn`), fare `chargeway`, type `ownername` |

1,447 records, ~1.6 MB; 952 have a usable `leftspace` and 120 a usable `motorcycleVacancy`.

#### Task 7: 臺南市 Tainan

| | |
|---|---|
| Transport | `GET https://parkweb.tainan.gov.tw/api/parking.php` |
| Records at | the top-level JSON array |
| Lot id | `id` |
| Car free | `car` (capacity `car_total`) |
| Motor free | `moto` (capacity `moto_total`) |
| Sentinel | none documented; treat a missing key or a non-integer as `None`, and keep `0` as a real reading |
| Timestamp | per record `update_time`, `"%Y-%m-%d %H:%M:%S"` in Taipei time, `ts_kind="record"`; unparseable → `now` / `"fetch"` |
| Coordinates | `lnglat`, a single `"lat,lng"` string — **split it and check the order against the Taiwan box**, since the field name says the opposite of what it holds |
| Roster | name `name`, area `zone`, fare `chargeFee`, type `typeName` |

#### Task 8: 桃園市 Taoyuan

| | |
|---|---|
| Transport | `GET https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0381e141-f7ee-450e-99da-2240208d1773/download` |
| Records at | the top-level JSON array |
| Lot id | `parkId` |
| Car free | `surplusSpace` (capacity `totalSpace`) — **numeric strings, not ints** |
| Motor free | none |
| Sentinel | none observed; a missing key or non-numeric string → `None` |
| Timestamp | none per record → `now`, `ts_kind="fetch"` |
| Coordinates | **`wgsY` holds the longitude (~121.x) and `wgsX` the latitude (~24.x)** — the names are swapped in the source data. Assign by value against the Taiwan box, not by name, and assert this in the test |
| Roster | name `parkName`, area `areaName`, fare `payGuide`, type `""` |

#### Task 9: 新竹市 Hsinchu City

| | |
|---|---|
| Transport | `GET https://hispark.hccg.gov.tw/OpenData/GetParkInfo` |
| Records at | the top-level JSON array |
| Lot id | `PARKNO` |
| Car free | `FREEQUANTITY` (capacity `TOTALQUANTITY`) |
| Motor free | `FREEQUANTITYMOT` (capacity `TOTALQUANTITYMOT`) |
| Sentinel | none observed; missing or non-integer → `None` |
| Timestamp | per record `UPDATETIME`, ISO-ish `2026-09-16T09:01:45.08` in Taipei time — parse with `datetime.fromisoformat`, `ts_kind="record"`; unparseable → `now` / `"fetch"` |
| Coordinates | `LATITUDE`, `LONGITUDE` |
| Roster | name `PARKINGNAME`, area `""`, fare `WEEKDAYS`, type `""` |

---

### Task 10: collect every source, isolate every failure

**Files:**
- Modify: `src/parkcast/collector.py:47-69` (`collect_once`), `src/parkcast/sources/__init__.py` (populate `SOURCES`), `src/parkcast/scheduler.py` (the tick body inside `run_forever`)
- Test: `tests/test_collector.py`, `tests/test_scheduler.py`

**Interfaces:**
- Consumes: `Source`, `SourceTick`, `store.record_source_health`.
- Produces: `collect_once(conn, source, capacities, *, now=None) -> TickResult` with `TickResult(city, data_ts, rows_written, advanced)`; `collect_all(conn, sources, capacities, *, now=None) -> list[TickResult]`.

- [ ] **Step 1: Write the failing test**

```python
def test_one_failing_city_does_not_stop_the_others(tmp_path):
    conn = store.connect(tmp_path / "hot.sqlite")
    good = _StubSource("tainan", rows=[("1", 5)])
    class Broken:
        city = "taoyuan"
        def fetch(self, *, now): raise FeedError("boom")
    results = collect_all(conn, [Broken(), good], {}, now=1000)
    assert [r.city for r in results] == ["tainan"]
    assert store.source_health(conn)["taoyuan"]["ok"] is False
    assert store.source_health(conn)["tainan"]["ok"] is True
    # Taipei is the only corpus that exists; a stranger's failure cannot touch it.
    assert conn.execute("SELECT COUNT(*) FROM observations WHERE city='tainan'").fetchone()[0] == 1
```

- [ ] **Step 2: Run it and watch it fail.** Expected: FAIL — no `collect_all`.

- [ ] **Step 3: Implement**

`collect_once` takes a `source` instead of reaching for `config.AVAILABILITY_URL`, and returns a `TickResult` carrying `city`. `collect_all` loops the sources, wrapping each in `try/except Exception`, logging the failure with the city name, recording health either way, and returning only the successful results. It never re-raises: one city's outage is not a tick failure.

- [ ] **Step 4: Register the sources** in `sources/__init__.py`:

```python
SOURCES = {s.city: s for s in (
    taipei.Source(), newtaipei.Source(), kaohsiung.Source(),
    tainan.Source(), taoyuan.Source(), hsinchu.Source(),
)}
```

- [ ] **Step 5: Wire the scheduler** — `run_forever` calls `collect_all(conn, SOURCES.values(), ...)` and treats the tick as advanced if **any** source advanced. `MAX_EXHAUSTED_SLOTS` now counts slots in which *no* source advanced.

- [ ] **Step 6: Run the suite and commit**

```bash
python -m pytest
git add src/parkcast/ tests/
git commit -m "feat(collector): collect every city, isolating each one's failures"
```

---

### Task 11: per-city artifact shards

The load-bearing task. **Taipei's published bytes must not change.**

**Files:**
- Modify: `src/parkcast/artifacts.py:102-185` (`build_lots_json`, `publish`)
- Modify: `src/parkcast/scheduler.py:76-180` (`publish_artifacts`)
- Test: `tests/test_artifacts.py`, `tests/test_scheduler.py`

**Interfaces:**
- Produces: `artifacts.publish(out_dir, city: str, *, grid_blob, lots_blob) -> None` writing `grid-{city}.bin` and `lots-{city}.json`, **except for `city == "taipei"`, which keeps writing `grid.bin` and `lots.json`**; `artifacts.build_cities_json(entries) -> bytes`; `scheduler.publish_city(conn, city, lots, out_dir, uploader=None)`.

- [ ] **Step 1: Write the failing tests**

```python
def test_lots_json_publishes_bare_ids(...):
    blob = artifacts.build_lots_json([_lot("taipei:TPE0001")], generated_at=1, base_data_ts=1)
    # The shard names the city; the row keeps the id the app already stores in
    # its recents. A namespaced id here would change every published byte.
    assert json.loads(blob)["lots"][0]["id"] == "TPE0001"

def test_taipei_keeps_its_filenames(tmp_path):
    artifacts.publish(tmp_path, "taipei", grid_blob=b"g", lots_blob=b"l")
    assert (tmp_path / "grid.bin").read_bytes() == b"g"
    assert not (tmp_path / "grid-taipei.bin").exists()

def test_other_cities_are_sharded(tmp_path):
    artifacts.publish(tmp_path, "tainan", grid_blob=b"g", lots_blob=b"l")
    assert (tmp_path / "grid-tainan.bin").read_bytes() == b"g"
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement the encoder change**

`build_lots_json` writes `"id": ids.bare(lot.id)`.

`roster_id` hashes the **bare** ids too. A shard is always exactly one city, so a bare id is unique within the file the hash describes, and hashing the namespaced form would change Taipei's published `roster_id` — which the client compares between `grid.bin` and `lots.json`, and which Task 11's byte-identity test pins. Both encoders take the same `lot_ids` list, so pass bare ids into `encode_grid` and `build_lots_json` alike and keep the hash where it is; add one line to `roster_id`'s docstring saying the ids it hashes are bare, and why that is safe.

```python
def test_roster_id_is_unchanged_by_namespacing():
    """The client pairs grid.bin with lots.json on this value, and Taipei's
    published bytes must not move."""
    assert artifacts.roster_id(["TPE0001", "TPE0002"]) == artifacts.roster_id(
        [ids.bare("taipei:TPE0001"), ids.bare("taipei:TPE0002")]
    )
```

- [ ] **Step 4: Implement `publish` and `cities.json`.** `cities.json` carries `{"v": 1, "generated_at": …, "cities": [{"city", "lots", "base_data_ts", "bbox": [w, s, e, n]}]}`, the bbox computed from the shard's own lots.

- [ ] **Step 5: Split `publish_artifacts` into `publish_city`.** Every existing guard — the empty-roster refusal, the `latest_ts == 0` refusal, the `MIN_PUBLISH_LOT_FRACTION` floor — moves inside and is evaluated **per city against that city's own published header**. `publish_artifacts` becomes a loop over the cities present in `lots`, grouped by `ids.city_of`, followed by one `cities.json` write.

- [ ] **Step 6: The byte-identity test.** Before changing anything, capture the current output; afterwards, assert equality:

```python
def test_taipei_shard_is_byte_identical_to_the_pre_change_artifacts(tmp_path):
    """The live site must not notice this refactor. Same lots, same history,
    same generated_at -- the bytes must match what the single-city path wrote."""
```

Build it from the existing `tests/test_scheduler.py` fixture, pinning `generated_at`. If the bytes differ, the refactor is wrong — do not adjust the expectation.

- [ ] **Step 7: Run the suite and commit**

```bash
python -m pytest
git add src/parkcast/artifacts.py src/parkcast/scheduler.py tests/
git commit -m "feat(artifacts): publish one shard per city"
```

---

### Task 12: per-source health in the daily report

**Files:**
- Modify: `src/parkcast/report.py:63-130` (`build_report`, `format_report`)
- Test: `tests/test_report.py`

- [ ] **Step 1: Write the failing test** — a report built over a store with two cities shows a line per city with rows fetched, rows usable and the newest timestamp, and marks a city whose newest reading is older than one hour as stale.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement**

`DayReport` gains `sources: dict[str, dict]`, filled from `store.source_health(conn)`. `format_report` grows one aligned line per city:

```python
STALE_AFTER_SEC = 3600

def _source_line(city: str, health: dict, *, now: int) -> str:
    rows, usable = health["rows"], health["usable"]
    age_min = (now - health["last_ts"]) // 60 if health["last_ts"] else None
    if not health["ok"]:
        note = "FAILED"
    elif rows and not usable:
        # The failure this line exists to catch: HTTP 200, a full payload, and
        # not one usable count in it. Silence would read as health.
        note = "NO USABLE COUNTS"
    elif age_min is not None and age_min * 60 > STALE_AFTER_SEC:
        note = f"STALE ({age_min} min)"
    else:
        note = "ok"
    return f"  {city:<12} {usable:>5}/{rows:<5} rows usable   {note}"
```


- [ ] **Step 4: Run the suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(report): a line per source"`.

---

### Task 13: documentation

**Files:**
- Create: `docs/sources.md`
- Modify: `CLAUDE.md`, `docs/state-of-play.md`, `README.md`

- [ ] **Step 1: Write `docs/sources.md`** — one section per city: endpoint, transport quirk, field mapping, sentinel, timestamp kind, lot count, licence. State plainly that two of the six are a city's own map backend rather than a catalogued dataset, and that Taichung, Keelung and Chiayi are deliberately excluded and why.
- [ ] **Step 2: Update `CLAUDE.md`** — the collector is no longer one feed; namespaced ids in the store and bare ids in the artifacts; the shard filenames; `data_ts` is per observation.
- [ ] **Step 3: Update `docs/state-of-play.md`** — a "Nationwide collection" section with the real measured numbers after Task 11, and the corrected test counts.
- [ ] **Step 4: Update `README.md`** — the status line and the one-paragraph description.
- [ ] **Step 5: Commit** — `git commit -m "docs: record the nationwide collector"`.

---

## Rollout — after the plan, with the user

The plan stops at code. Turning cities on is a live operation against a running collector and a published site, and it is the user's call:

1. `python -m pytest` green, then restart the collector with **Taipei alone** still enabled. Confirm the live site is unchanged and `grid.bin` still republishes.
2. Enable **New Taipei only**. Let it run a day. Measure `data/cold/`'s growth and compare it against the spec's 150–400 MB/month estimate.
3. Enable the remaining four, one per tick-cycle, watching the per-source report.
4. The app still shows Taipei only — the shards exist but nothing reads them until the app spec ships.
