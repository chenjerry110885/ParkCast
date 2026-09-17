# Sources

ParkCast collects six cities behind one `Source` protocol (`src/parkcast/sources/__init__.py`) and
one shared HTTP transport (`sources/http.py`): `city: str` plus `fetch(*, now: int) -> SourceTick`,
one adapter module per city, registered in `SOURCES`. This is the per-city reference — endpoint,
transport quirks, field mapping, not-reporting sentinel, which of the three timestamp kinds it
produces, its lot count and its licence — for anyone adding a seventh city or debugging one of the
six. See `CLAUDE.md`'s "The nationwide collector" section for the shared design (identity, shards,
`data_ts`, the startup migration); this page is the field-level detail underneath it.

Every count below was measured **live while writing this page (2026-09-16)**, by fetching each feed
with the project's own `User-Agent` and, for five of the six, running the actual shipped
`sources.<city>.parse` against the response — not by re-reading the research pass. Counts move
tick to tick; treat the percentages as "this is the shape of the data", not a number to assert in a
test. The original survey (broader, more cities considered) is
[`docs/research/2026-09-16-city-parking-feeds.md`](research/2026-09-16-city-parking-feeds.md); the
design tradeoffs are [`docs/superpowers/specs/2026-09-16-nationwide-collector-design.md`](superpowers/specs/2026-09-16-nationwide-collector-design.md).

## The shared rule: parse by rule, not by enumerated sentinel

Every adapter reads every count field through `quality.clean_count`: any negative integer and any
non-numeric value (a missing key, `null`, or text that fails `int()`) becomes `None`; a real `0`
survives, because a full lot is a fact, not an absence. No adapter enumerates its city's specific
sentinel values — and that paid off twice on this branch with zero adapter changes needed:

- **Kaohsiung** also uses `-3` in `motorcycleVacancy`, undocumented anywhere (11 of 1,447 records,
  live-verified 2026-09-16 — a live re-fetch the same day also turned up an unrelated `-979` in one
  `smallcarVacancy` record, `PL_KHB00344`, which no enumerated sentinel list would ever have
  anticipated either).
- **Taoyuan** puts the literal status text `開放中` ("open") in `surplusSpace` on roughly a fifth of
  its lots instead of a count — **50 of 246 live records (20.3%), verified 2026-09-16**. `int("開放中")`
  raises `ValueError` exactly like a missing key, so `clean_count` already turns it into `None` with
  no special case. One consequence worth remembering on its own: **Taoyuan's usable yield is about
  80%, not 100%** — a fifth of its lots never report a number at all, live or otherwise.

Enumerating each city's known sentinels instead of trusting the rule would have missed both of these
and published a fabricated count where the feed actually meant "not reporting."

## Coordinates: resolved at runtime, never trusted by name

Two of the six feeds contradict their own field names on every record checked:

- **Tainan**'s `lnglat` is a single `"lat,lng"` string despite the name implying the opposite order.
- **Taoyuan**'s `wgsX`/`wgsY` are swapped relative to the usual X=longitude/Y=latitude convention:
  `wgsX` holds latitude, `wgsY` holds longitude.

This is not a new pattern the nationwide work invented: Taipei's own metadata already needed the same
discipline (`geo.py`'s `_from_entrance`: *"Despite the names, Xcod is LATITUDE and Ycod is
LONGITUDE"*) — though Taipei's path hard-codes that known swap rather than testing for it, since it
predates this branch.

**Three of the six adapters — Tainan, Taoyuan, Hsinchu — actually try both orderings at runtime**:
each parses both candidate values and asks `sources.geo.in_taiwan` which ordering, if either, lands
inside the Taiwan bounding box, dropping the lot only if neither does. Hsinchu's own field names are
correct today (verified on all 55 live records) and it still runs the dual check, on the reasoning
that a measurement is not a guarantee. **New Taipei and Kaohsiung do not** — their `Lat`/`Lng` and
`lat`/`lng` fields are unambiguous, and each adapter validates the one expected ordering against
`geo.in_taiwan` directly, dropping the lot if it fails, with no swap attempt (grep for `in_taiwan` in
`sources/*.py`: two calls per city in the three dual-check adapters, one call in each of the other
three). Whether a given city's adapter pays for the second `in_taiwan` call is a per-adapter choice,
not a rule this page can promise holds for a seventh city — check the adapter, not this generalisation.
What matters everywhere it *is* applied: nothing hard-codes an ordering from a field's name once the
name has been shown to lie. A silent swap does not raise or produce an obviously wrong number — it
puts a whole city's lots in the sea (or somewhere on land but wrong) and every distance the ranker
computes for that city becomes nonsense while still looking like data.

## Summary

| City | Adapter | Method | Lots (live) | Usable car counts | Usable motor counts | `ts_kind` | Licence |
|---|---|---|---|---|---|---|---|
| 臺北市 Taipei | `taipei.py` | GET | 1,178 | 1,091 (92.6%) | 472 (40.1%) | `feed` | 政府資料開放授權條款-第1版 |
| 新北市 New Taipei | `newtaipei.py` | POST, empty body, explicit `Content-Length: 0` | 1,373 distinct (3,824 raw records — see below) | 416 (30.3% of distinct) | none (capacity only) | `record` / `fetch` | none stated on the endpoint |
| 高雄市 Kaohsiung | `kaohsiung.py` | POST, body `{}` | 1,447 | 956 (66.1%) | 110 (7.6%) | `fetch` | none stated |
| 臺南市 Tainan | `tainan.py` | GET | 268 | 268 (100%, real zeros included) | 268 (100%, real zeros included) | `record` / `fetch` | 政府資料開放授權條款-第1版 |
| 桃園市 Taoyuan | `taoyuan.py` | GET | 246 | 196 (79.7%) | none (no field) | `fetch` | 政府資料開放授權條款-第1版 |
| 新竹市 Hsinchu | `hsinchu.py` | GET | 55 | 55 (100%, real zeros included) | 55 (100%, real zeros included) | `record` / `fetch` | 政府資料開放授權條款-第1版 |

"Usable" means `clean_count` returned a non-`None` value, i.e. `free_car`/`free_motor` is present in
the store as a real reading rather than a `NULL`; 100% for Tainan and Hsinchu means every record
parses to *some* integer (frequently a legitimate `0`), not that every lot has spaces.

## 臺北市 Taipei

- **Endpoint:** `GET https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json`
  (`config.AVAILABILITY_URL`). Plain GET, no quirks.
- **Roster/metadata is separate:** `config.METADATA_URL` (`TCMSV_alldesc.json`), parsed by
  `metadata.parse_metadata`, not by `sources/taipei.py` — `SourceTick.lots` is always `None` for
  Taipei, unlike every other city.
- **Fields:** `data.UPDATETIME` (one stamp for the whole payload, e.g.
  `"Wed Sep 16 14:53:00 CST 2026"`) → every observation's `data_ts`; `park[].id` (e.g. `"TPE0001"`)
  → `lot_id`; `availablecar` → `free_car`; `availablemotor` → `free_motor`.
- **Sentinel:** `-9` on both fields (Taipei's own convention; `clean_count`'s general negative-value
  rule handles it without naming it).
- **`ts_kind`:** always `TS_FEED` — one timestamp for the whole tick.
- **Lots:** **1,178** live records, 2026-09-16 (`sources.taipei.parse` run against a fresh fetch);
  1,091 (92.6%) with a usable `free_car`, 472 (40.1%) with a usable `free_motor`. The roster grows
  over time — the design-time research pass measured 1,165/471 two fetches earlier the same day; see
  `CLAUDE.md`'s existing note that the metadata roster grows during a day.
- **Licence:** 政府資料開放授權條款-第1版 (government open data licence v1).

## 新北市 New Taipei

- **Endpoint:** `POST https://www.parkinginfo.ntpc.gov.tw/parkinginfo/public/getSpot.ashx`, empty
  body. **Must send an explicit `Content-Length: 0`** — verified live: a POST that omits it gets
  `411 Length Required`; the same request with the header gets `200`. `sources.http.post_json`
  always sends `Content-Length` (even `0` for an empty body) for exactly this reason, so this
  adapter needs no special case, just a call with no `body` argument.
- **One feed answers both roster and live counts** — `SourceTick.lots` is never `None` here.
- **Fields:** `parkingLotId` (bare numeric, e.g. `"010001"`) → `lot_id`; `NowCarSpace` → `free_car`;
  `recdate` (ROC date, `"1150916"`) + `rectime` (`"HHMMSS"`) → `data_ts`, Taipei local time; `Lat`/
  `Lng` → coordinates (already WGS84, correctly ordered, still passed through `geo.in_taiwan`);
  `carNum` → `capacity_car`/`serves_cars`; `free_motor` is **always `None`** — the feed publishes
  motorcycle *capacity* (`motoNum`) but never a live count.
- **Sentinel:** `null`, `-1`, `-2` on `NowCarSpace`, all mapped to `None` by the same negative/
  non-numeric rule. Live 2026-09-16 raw records: 1,894 `null`, 7 at `-1`, 0 at `-2` (fluctuates;
  the design-time pass saw 3 at `-2`).
- **`ts_kind`:** `TS_RECORD` when `recdate`/`rectime` parse, else `TS_FETCH`. Verified live: on every
  one of the 3,824 raw records, `recdate is None` exactly when `NowCarSpace is None` — a
  non-reporting record carries neither a count nor a timestamp, they are the same absence, not two
  independent ones.
- **Lots — a raw-record count is the wrong number to quote here.** The endpoint returns **3,824 raw
  records** for **1,373 distinct `parkingLotId`s** — one lot appears up to 12 times (`"040014"`,
  綠寶石區停車場). The adapter's existing `seen`-set dedupe (keeps the first record for a given id,
  the same rule every adapter uses) already handles this correctly with no code change — a
  first-record-wins duplicate test was made to actually discriminate first-kept from last-kept for
  this city and Kaohsiung's, so it is not merely coincidental that it held up here. It means
  **New Taipei's true lot count is 1,373, not 3,824**, and citing the raw figure (as the design-time
  research and spec both do, in "lots" columns that actually mean "records") overstates it by 2.8x.
  Of the 1,373 distinct lots, **416 (30.3%)**
  carry a usable live car count right now — materially lower than a naive `1,930 usable raw records /
  3,824 = 50%` would suggest, because non-reporting lots are duplicated less often than reporting
  ones in this feed.
- **Licence:** none stated on the live endpoint. The equivalent open dataset once catalogued on
  `data.ntpc.gov.tw` (now delisted, and separately WAF-blocked for this dataset id — see the research
  doc) carried 政府資料開放授權條款-第1版; treat that as informative, not binding, for the endpoint
  this adapter actually calls.

## 高雄市 Kaohsiung

- **Endpoint:** `POST https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLotPost`, body `{}`,
  `Content-Type: application/json` — matches what `sources.kaohsiung.Source.fetch` sends. (The
  endpoint also accepts a POST with no body at all and just `Content-Length: 0`, verified live; the
  adapter sends `{}` regardless, which is what the code actually does and is safe to keep doing.)
- **One feed answers both roster and live counts.**
- **Fields:** `parkingLots[].id` (e.g. `"PL_KHB00035"`) → `lot_id`; `smallcarVacancy` → `free_car`;
  `motorcycleVacancy` → `free_motor` — one of the four cities with a *real* live motorcycle count,
  reported independently of the car field; `volumnAuto` (falling back to `volumn` when blank) →
  `capacity_car`/`serves_cars`; `lat`/`lng` → coordinates (correctly ordered, still resolved through
  `geo.in_taiwan`); `name`, `areaname`, `ownername`, `businesshours`, `chargeway` → the rest of `Lot`.
- **Sentinel:** documented `-1`/`-2`; this branch found `motorcycleVacancy` also uses **`-3`**
  (undocumented anywhere, 11 of 1,447 records live 2026-09-16), and a live re-fetch the same day
  turned up a `-979` in one `smallcarVacancy` record — both absorbed with no adapter change because
  `clean_count` treats every negative as "not reporting," not just the documented ones.
- **`ts_kind`:** always `TS_FETCH` — the feed carries no timestamp anywhere, per-record or
  per-payload.
- **Lots:** **1,447** live records, 2026-09-16, no raw duplication (1,447 distinct ids); 956 (66.1%)
  with a usable `free_car`, 110 (7.6%) with a usable `free_motor`.
- **Licence:** not stated anywhere on the page. This is the backend of the city's own interactive
  parking map (`kpp.tbkc.gov.tw/ParkingLocation/ParkingLocation`), not a catalogued data.gov.tw
  dataset — see "Two of six are a map backend, not a dataset" below. A static public/private lot list
  does exist on data.gov.tw under the standard licence, as a documented-licence fallback for
  metadata only, not used here.

## 臺南市 Tainan

- **Endpoint:** `GET https://parkweb.tainan.gov.tw/api/parking.php`. Plain GET, no quirks.
- **One feed answers both roster and live counts.**
- **Fields:** `id` (bare numeric, e.g. `"1"`; `code`, e.g. `"B00001"`, is not used as the identity)
  → `lot_id`; `car` → `free_car`; `moto` → `free_motor` — independently reported, one of the four
  cities with a real live motorcycle count; `car_total` → `capacity_car`/`serves_cars`; `lnglat`
  (a single `"lat,lng"` string, see "Coordinates" above) → coordinates, resolved at runtime; `name`,
  `zone`, `typeName`, `chargeFee` → the rest of `Lot`; `service_time` is left `""` (no field in this
  feed maps to it).
- **Sentinel:** none documented or observed — every field checked on every live record is a plain
  non-negative int, including legitimate zeros. `clean_count` still runs unconditionally, as the
  general rule, not because this feed needs it today.
- **`ts_kind`:** `TS_RECORD` from `update_time` (`"%Y-%m-%d %H:%M:%S"`, Taipei local), falling back to
  `TS_FETCH` when unparseable.
- **Lots:** **268** live records, 2026-09-16, no raw duplication; every record parses to a usable
  int on both `car` and `moto` (100%, many legitimately `0`); 17 lots report a non-zero `moto` right
  now (the design-time pass saw 20 — this moves).
- **Licence:** 政府資料開放授權條款-第1版 (dataset 102772 on data.gov.tw).

## 桃園市 Taoyuan

- **Endpoint:** `GET https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0381e141-f7ee-450e-99da-2240208d1773/download`.
  Plain GET, no quirks.
- **One feed answers both roster and live counts.**
- **Fields:** `parkId` (e.g. `"P-BD-001"`) → `lot_id`; `surplusSpace` (arrives as a JSON *string*,
  e.g. `"207"`) → `free_car`; no motorcycle field of any kind → `free_motor` is always `None`;
  `wgsX`/`wgsY` (swapped, see "Coordinates" above) → coordinates, resolved at runtime; `totalSpace`
  → `capacity_car`/`serves_cars`; `parkName`, `areaName`, `payGuide` → the rest of `Lot`; `lot_type`
  is left `""` (no field maps to it).
- **Sentinel:** none documented; the one this branch found is **textual, not numeric** —
  `surplusSpace` holds the literal string `開放中` ("open") instead of a count on **50 of 246 live
  records (20.3%)**, verified 2026-09-16. `int("開放中")` raises exactly like a missing key, so
  `clean_count`'s existing exception handling absorbs it for free. See "The shared rule" above.
- **`ts_kind`:** always `TS_FETCH` — no timestamp anywhere in the feed.
- **Lots:** **246** live records, 2026-09-16, no raw duplication; 196 (79.7%) with a numeric,
  usable `free_car` — Taoyuan's usable yield is about 80%, not 100%.
- **Licence:** 政府資料開放授權條款-第1版. An XML mirror exists at a sibling resource id on the same
  dataset.

## 新竹市 Hsinchu City

- **Endpoint:** `GET https://hispark.hccg.gov.tw/OpenData/GetParkInfo`. Plain GET, no quirks.
- **One feed answers both roster and live counts.**
- **Fields:** `PARKNO` (bare, e.g. `"004"`) → `lot_id`; `FREEQUANTITY` → `free_car`;
  `FREEQUANTITYMOT` → `free_motor` — independently reported, one of the four cities with a real live
  motorcycle count; `TOTALQUANTITY` → `capacity_car`/`serves_cars`; `LATITUDE`/`LONGITUDE` →
  coordinates — correctly ordered on every live record checked, and still resolved by trying both
  orderings against `geo.in_taiwan` at runtime rather than trusted, on the same principle as Tainan
  and Taoyuan (see "Coordinates" above); `PARKINGNAME`, `WEEKDAYS` → the rest of `Lot`; `area`,
  `service_time` and `lot_type` are left `""` (no fields map to them).
- **Sentinel:** none documented or observed — every field checked on every live record is a plain
  non-negative int.
- **`ts_kind`:** `TS_RECORD` from `UPDATETIME` (an ISO-ish string with a variable-width fractional
  second, e.g. `"2026-09-16T09:01:45.08"`, parsed with `datetime.fromisoformat`), falling back to
  `TS_FETCH` when unparseable.
- **Lots:** **55** live records, 2026-09-16, no raw duplication; every record parses to a usable int
  on both fields (100%, several legitimately `0`); 13 report a non-zero `FREEQUANTITYMOT` right now
  (the design-time pass saw 17 — this moves).
- **Licence:** 政府資料開放授權條款-第1版 (dataset 129136 on data.gov.tw). The data.gov.tw page's own
  "once a year" update-frequency label is wrong for a feed that timestamps every record to the
  second — trust `UPDATETIME`, not the catalogue metadata.

## Timestamps are bounded on the way in

Counts go through `quality.clean_count` and coordinates through `sources.geo.in_taiwan`; since the
final fix round, `data_ts` goes through `quality.data_ts_plausible`, applied once in
`collector.collect_once` (see `collector.bound_data_ts` for why there and not in each adapter or in
`store.insert_snapshot`). A stamp outside **`now − 48 h` to `now + 15 min`** is not stored: the
observation is dropped, counted on `TickResult.rejected_ts`, and logged with the worst offset and
the lot that produced it.

**This is live, not hypothetical.** One fetch of Tainan on 2026-09-16 returned **16 of 268 records
stamped more than 48 h old, the worst by 2.3 years.** Stored, those rows insert and then prune inside
the same slot — never compacted, a hole in the corpus with nothing in the log — and their lots can
never pass the publish filter. A stamp in the *future* is worse and unrecoverable: one record 400
days ahead pins `store.latest_data_ts` to itself forever, so the city reads stalled on every healthy
tick and is retried four times a slot, `base_data_ts` publishes 400 days ahead, and `store.free_at`
matches only that one lot, taking the observed count off every other card in the city.

The row is **rejected, not rebased onto the fetch time**. `TS_FETCH` would keep it, but rebasing a
reading stamped 2.3 years ago to "now" does not record that we are unsure when it was taken — it
asserts it was taken now, which then publishes as the lot's current observed count and lands in the
wrong time-of-week climatology bucket. A lot with no reading is something `liveness` already handles
honestly.

## Known limits — read before trusting a number

Four things that are **true today and easy to trip over**. The first three are deliberately not
fixed; the fourth (TLS) was fixed on 2026-09-17 and is kept here because the shape of the fix is
something anyone reading a certificate error later needs to know. None is a bug in an adapter; each
is a place where a measurement means less than it looks like it does.

- **`evaluate.py` is not scoped per city.** Its origin selection and its labels run over the whole
  store. With realistic clock phases across six cities it selected **only Kaohsiung origins and
  scored zero Taipei predictions** — Kaohsiung and Taoyuan stamp `data_ts = now`, so they always hold
  the global maximum, exactly the defect `forecast.by_city` exists to fix on the publishing side.
  **Anyone re-running the evaluation must scope it to one city first**, or the resulting skill number
  is about a different city than the one they think they are measuring. It is not a number to quote
  until that is done.
- **`liveness`'s cadence constants are Taipei's.** `NOT_UPDATING_MIN_COVERAGE` counts readings
  against 5-minute slots (`liveness.SLOT_SECONDS`, from `POLL_PERIOD_MIN`). For a lot whose own stamp
  cadence is slower than roughly 10 minutes, a genuinely unchanged run never reaches half its slots,
  so `last_update` falls back to the newest reading and **not-updating withholding never fires for
  that lot**. That is the conservative direction — a forecast is published where one might have been
  withheld — but it means "0 lots withheld" in a per-record city is not evidence the feed is moving.
- **Kaohsiung and Taoyuan have no staleness signal at any layer.** Their feeds carry no timestamp, so
  their adapters stamp `data_ts = now`; `sources.last_ts` is therefore always the last successful
  fetch and `report._source_line`'s age is always ~0. A payload frozen for a week and a live one are
  identical in every field recorded. Closing this needs something outside the feed — the feed
  learning to stamp its records, or a per-fetch content hash (an unchanged hash over N consecutive
  polls is the evidence a record timestamp would give directly). `ok=False` on an outright failure is
  the only thing those two lines can honestly report.
- **Three of six feeds need a per-source TLS policy to verify at all — fixed 2026-09-17, but the
  relaxation is a standing thing to know about.** All six now verify from inside the collector image
  (python 3.13.15, OpenSSL 3.5.7, certifi 2026.07.22), each by the narrowest fix that works. **No
  feed is fetched unverified; there is no `verify=False` anywhere, and `tests/test_sources_tls.py`
  fails the suite if anyone adds one.** Measured in-container 2026-09-17 — every line below is a
  reproduced result, not an inference:

  | Host | Without a policy | What it gets, and why |
  |---|---|---|
  | `kpp.tbkc.gov.tw` (kaohsiung) | `certificate verify failed: Missing Subject Key Identifier` | `TlsPolicy(x509_strict=False)` — clears **only** `ssl.VERIFY_X509_STRICT`, which alone makes it verify |
  | `hispark.hccg.gov.tw` (hsinchu) | same | same |
  | `www.parkinginfo.ntpc.gov.tw` (newtaipei) | `unable to get local issuer certificate` | `TlsPolicy(extra_ca_file=…)` — the server sends **only its leaf**; clearing the strict flag does **not** help. Strict stays **on** |

  ### The SKI failure is not a misconfigured city server. Do not report it to them.

  **The certificate missing its Subject Key Identifier is `TWCA Global Root CA` — a root in
  certifi's own bundle, the trust anchor at the top of both chains.** Every certificate the two
  servers actually send carries an SKI: all five from `kpp.tbkc.gov.tw`, both from
  `hispark.hccg.gov.tw` (enumerated 2026-09-17). The chains are fine. The anchor is a 2010-vintage
  root that predates the RFC 5280 formality Python 3.13 began enforcing when it turned
  `VERIFY_X509_STRICT` on by default in `create_default_context()` — a rule browsers and `curl` have
  never applied, which is why `curl` succeeded against all three during the 2026-09-16 host review.

  So this is not "two municipal servers are misconfigured". It is "**a root in the public trust store
  predates a requirement Python 3.13 now enforces, and no site chaining to that root can verify from
  modern Python**" — Kaohsiung and Hsinchu are simply two such sites. **Neither city can fix it**;
  nothing they could change about their own certificates or server configuration would help, and
  emailing a city government about their TLS setup would waste a day and be wrong. It resolves by
  itself only when Mozilla rotates or removes that root and certifi ships the change.

  Clearing the flag drops that encoding formality and nothing else: hostname checking,
  `CERT_REQUIRED`, signatures, validity, basic constraints and the path to a trusted root all still
  apply, and `tests/test_sources_tls.py` proves each policy still rejects an untrusted certificate.
  **The relaxation is per source.** Taipei, Tainan and Taoyuan declare no policy and reach `requests`
  on the untouched default path; there is no global switch to reach for.

  New Taipei's intermediate ships as [`src/parkcast/sources/twca-ssl-ca-2023.pem`](../src/parkcast/sources/twca-ssl-ca-2023.pem),
  whose own header block carries the provenance and the chain proof. It **adds no trust anchor**: its
  issuer, `TWCA CYBER Root CA`, is already a certifi root, so it only lets a path complete — and it is
  loaded *in addition to* certifi's bundle, never instead of it (121 CAs → 122, asserted by test).
  It needs `[tool.setuptools.package-data]` in `pyproject.toml` to reach the image: the container
  imports `parkcast` out of site-packages, not out of `/app/src`, so `COPY src ./src` alone puts the
  file in the image and still out of reach.

  **What breaks, and how you will hear about it.** The intermediate expires 2033-02-23; a test
  asserts its validity window, so it fails the suite before it fails a fetch. If it is rotated,
  swapped or expires unnoticed, or if a chain breaks, the fetch raises `requests.exceptions.SSLError`,
  `collect_all` records `ok=False`, and the source reads **`FAILED`** on its per-source health line.
  There is no path by which it degrades to unverified.

  **After any dependency bump — `certifi` above all, but also `requests`, `urllib3` or the base
  Python image — re-run the five-city check inside the container.** The expiry test is a tripwire for
  the shipped intermediate only; it says nothing about the trust store around it, and every reason
  these three feeds need a policy lives in that store. A certifi update can move this picture in
  either direction: dropping or rotating `TWCA Global Root CA` would break Kaohsiung and Hsinchu
  outright (or make their relaxation unnecessary), and adding `TWCA SSL Certification Authority` as a
  root would make the shipped intermediate redundant. Nothing in the unit suite can see any of that,
  because none of it can reach the real feeds. The check is the script in the rollout notes; all five
  must read `OK`.

## Turning cities on: `PARKCAST_CITIES`

`SOURCES` holds all six adapters; **`PARKCAST_CITIES` decides which of them this container actually
collects.** Comma-separated city keys (`taipei`, `newtaipei`, `kaohsiung`, `tainan`, `taoyuan`,
`hsinchu`); unset or empty means all six, so an operator who sets nothing gets the registry exactly
as it reads. An unknown name **stops the boot** with a message naming the typo and every valid
choice — collecting a set the operator did not ask for while they believe otherwise leaves a gap in
the corpus that cannot be backfilled. Order and duplicates in the value are ignored; request order
within a tick is `SOURCES`' own. The boot log says what was selected:

    collecting 2 of 6 cities: taipei, newtaipei (set PARKCAST_CITIES to change)

This is what makes the spec's staged rollout (§9) possible without editing source and rebuilding the
image between each step.

## Two of six are a city's own map backend, not a catalogued dataset

New Taipei's `getSpot.ashx` and Kaohsiung's `ParkingLotPost` are not versioned, catalogued open-data
files. They are the literal API the city's own interactive parking map calls from the browser,
found by reading the map page's own JavaScript rather than by browsing data.gov.tw. Neither publishes
a schema, a change-log, or a licence.

Two consequences worth remembering:

- **No deprecation cycle.** The payload shape can change the moment the map page's own frontend
  changes, with no notice, because there is no public contract to begin with — either of these
  adapters is one frontend redesign away from breaking, unlike the four cities publishing an actual
  catalogued dataset.
- **They get the same courtesy as an open-data file, deliberately, not more caution.** The spec is
  explicit about this (§2, Constraints): "Two of these endpoints are a city's own map backend rather
  than a published dataset; they get the same courtesy as an open-data file, and cadence no faster
  than the data changes." No adapter here polls more gently or announces itself differently than the
  four catalogued cities — one request per city per tick, the same `parkcast-collector/1`
  `User-Agent`, the same back-off on failure.

## Deliberately excluded: Taichung, Keelung, Chiayi

- **臺中市 Taichung.** Its live feed's `AvailableCarRGB`/`AvailableMotorRGB` fields are a
  traffic-light colour (`G`/`Y`/`R`), never a count — there is no numeric available-spaces field
  anywhere in the feed. Storing a three-level status in an integer column would quietly poison the
  corpus with values that look like real counts but are not.
- **基隆市 Keelung and 嘉義市 Chiayi City.** Both have real, free, live data, but as plain
  server-rendered HTML tables with no backing JSON/XML/CSV API, and neither carries a lot id,
  coordinates, or capacity — only a name, an availability figure, and a timestamp. HTML scraping is
  real, separate work (a different transport, a different fragility, and a per-lot identity that
  would have to be invented from names alone), worth doing only once the six JSON cities here are in
  and stable.
- **On-street parking (路邊停車格), everywhere**, is out of scope regardless of city: a different
  data model, typically metered/timed rather than lot-based, with no capacity concept the same way.
- **TDX** (the national transit/parking aggregator) is deliberately excluded even though it
  technically covers every county: full access needs a paid tier beyond casual/free use, which
  conflicts with this project's "free only, no account" constraint. See the research doc's TDX
  arithmetic.
