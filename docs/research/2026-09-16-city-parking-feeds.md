# Taiwan city/county off-street parking availability feeds — research findings

Date: 2026-09-16
Scope: free, no-API-key, real-time **off-street** (路外) parking availability feeds for New Taipei down through the smaller counties, following the Taipei `TCMSV_allavailable.json` / `TCMSV_alldesc.json` pattern. TDX is deliberately excluded except where noted as the only option. All endpoints below were fetched live with `curl -sS -m 20` (or the Claude Browser pane for JS-rendered pages) on 2026-09-16; HTTP status, size and a trimmed sample record are reported for each verified one.

No files under `D:\Projects\ParkCast\data\` were read. No other repo files were modified.

## Summary — verified, free, no-key, off-street feeds

| City | Endpoint | Car field | Motorcycle field | Lot-ID field | Cadence | ~Lots | Licence |
|---|---|---|---|---|---|---|---|
| 臺北市 (baseline, re-verified) | `https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json` | `availablecar` | `availablemotor` (populated on 471/1165 lots) | `id` | live, `UPDATETIME` field | 1,165 | 政府資料開放授權條款-第1版 |
| 桃園市 Taoyuan | `https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0381e141-f7ee-450e-99da-2240208d1773/download` | `surplusSpace` (car only) | none | `parkId` | "every minute" (stated); no per-record timestamp | 246 | 政府資料開放授權條款-第1版 |
| 臺中市 Taichung | `https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=4f9c4d26-d826-4277-8f8a-6d2469fe9653` | `AvailableCarRGB` (**colour status only, not a count**) | `AvailableMotorRGB` (**colour status only**) | `ID` | monthly-labelled dataset page, but payload itself updates live | 1,387 | 政府資料開放授權條款-第1版 |
| 臺南市 Tainan | `https://parkweb.tainan.gov.tw/api/parking.php` | `car` (avail) / `car_total` | `moto` (avail) / `moto_total` — populated on 20/268 lots | `id`, `code` | irregular (per-record `update_time`, ~1 min in practice) | 268 | 政府資料開放授權條款-第1版 |
| 高雄市 Kaohsiung | `POST https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLotPost` (empty JSON body) | `smallcarVacancy` / `volumnAuto` | `motorcycleVacancy` / `volumnScooter` — populated on 120/1447 lots | `id` (e.g. `PL_KHB00035`) | live, no per-record timestamp | 1,447 | not stated on the page (not a data.gov.tw-style dataset) |
| 基隆市 Keelung | `https://e-traffic.klcg.gov.tw/KeelungTraffic/pages/park.jsp/` (server-rendered **HTML table**, not JSON) | 2nd column (unlabelled, "剩餘停車格") | none | none (name only) | per-row timestamp, ~1–5 min | ~42 | none stated (page has no licence notice) |
| 新竹市 Hsinchu City | `https://hispark.hccg.gov.tw/OpenData/GetParkInfo` | `FREEQUANTITY` / `TOTALQUANTITY` | `FREEQUANTITYMOT` / `TOTALQUANTITYMOT` — populated on 17/55 lots | `PARKNO` | live, per-record `UPDATETIME` | 55 | 政府資料開放授權條款-第1版 (per data.gov.tw mirror, dataset 129136) |
| 嘉義市 Chiayi City | `https://iparking.chiayi.gov.tw/car/open` (server-rendered **HTML table**, not JSON) | "剩餘" column, format `NN成滿（count）` / `尚有空位（count）` / `滿場` | none | none (name only) | per-row timestamp, ~1 min | ~85 | none stated |
| 新北市 New Taipei | `POST https://www.parkinginfo.ntpc.gov.tw/parkinginfo/public/getSpot.ashx` (empty body, `Content-Length: 0` required) | `NowCarSpace` (live) | none live — `motoNum` is *capacity* only | `parkingLotId` | per-record `recdate`/`rectime`, ~1 min | 3,824 (1,920 with a live car count) | none stated (site's own endpoint; no robots.txt) |

7 of the 8 rows above (all but New Taipei) were fetched successfully and returned live, current-timestamped data at test time. New Taipei's URL pattern and field names are confirmed correct from the platform's own dataset catalogue, but the file itself could not be retrieved (see the New Taipei section).

Two of the "verified" feeds (Keelung, Chiayi City) are plain server-rendered HTML tables, not JSON/XML/CSV — they are real, free, live, off-street data, but need HTML scraping rather than a JSON parse, and neither carries a lot ID, coordinates, or capacity — only a name, an availability figure, and a timestamp.

Taichung's feed technically has "car" and "motorcycle" fields but they carry only a traffic-light colour (`G`/`Y`/`R`), never an exact count — it fails the "car spaces available" / "motorcycle spaces available" requirement as a *number*, so treat it as the weakest of the verified set.

---

## City-by-city detail

### 臺北市 Taipei (baseline — re-verified for context, not a new finding)

- Availability: `https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json` — HTTP 200, 422,009 bytes.
  Sample (trimmed): `{"data" : {"UPDATETIME" : "Wed Sep 16 09:03:00 CST 2026","park" : [ {"id" : "TPE0001","availablecar" : 15,"availablemotor" : -9,"availablebus" : -9,...`
- Metadata: `https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json` — HTTP 200, 2,884,397 bytes. Fields: `id, area, name, type, type2, ptype, summary, address, tel, payex, ...`.
- Fields: `id`; `availablecar`; `availablemotor`; also `availablebus`, `availablehandicap`, `availablepregnancy`, `availableheavymotor`. Sentinel `-9` = operator not reporting. 1,165 lots; motorcycle counts actually populated (≠ -9) on 471 of them.
- Update: live, `UPDATETIME` at top level (whole-feed timestamp, not per-lot).
- Licence: 政府資料開放授權條款-第1版 (government open data licence v1), no documented rate limit.
- Off-street only (correct scope).

### 新北市 New Taipei — RESOLVED 2026-09-16, via the city's own map endpoint

The open-data route is a dead end: `data.gov.tw` dataset 26701 is **delisted** ("資料集已下架，此為歷史資料留存"), and the platform copy at `data.ntpc.gov.tw/api/datasets/e09b35a5-.../json/file` is rejected by an F5 ASM WAF ("Request Rejected ... support ID") for that dataset id specifically — browser headers, a full cookie-bearing session, and a real browser navigation all fail alike, while other dataset ids on the same host serve fine.

**What works instead** — the endpoint behind 新北市公共停車場資訊查詢系統, the same shape as Kaohsiung's:

```
POST https://www.parkinginfo.ntpc.gov.tw/parkinginfo/public/getSpot.ashx
Content-Length: 0        # required -- without it the server answers 411
```

HTTP 200, 500,802 bytes, `text/plain; charset=utf-8`, a JSON array of **3,824 records**. Optional `?town=<district>` narrows it; no argument returns the whole city.

Fields: `parkingLotId`, `parkingLotName`, `owner`, `parkinglotAddress`, **`NowCarSpace`**, `businessHours`, `chargingstandard`, `RemarkRate`, `operationType`, **`recdate`** (ROC date, e.g. `1150916`), **`rectime`** (`HHMMSS`), **`Lat`**, **`Lng`** (WGS84 strings, no projection needed), `companyTel`, `message`, `parkingLotTel`, `dimensionType`, `parkingFee`, **`carNum`**, **`motoNum`**, `drawLots`, `titleHolder`, `company`.

- `NowCarSpace` is the live count: 1,930 records carry an integer, 1,894 carry `null` (no real-time reporting). Sentinels `-1` (7 lots) and `-2` (3 lots) — a *different* convention from Taipei's `-9`. 1,920 lots have a usable count ≥ 0.
- `carNum` / `motoNum` are **capacity**, not availability — present on all 3,824. So New Taipei gives motorcycle *capacity* but no live motorcycle count.
- `message` carries a capacity breakdown string including 機車位, 身障機車位, 重型機車位, 充電式機車位.
- `recdate`/`rectime` are **per record**, and were current at fetch time (09:45 for a 09:45 fetch) — better than Taipei, which has one timestamp for the whole feed.
- This is more coverage than the delisted dataset (3,824 records vs 1,249), because it includes private as well as public lots.
- No `robots.txt` on the host (404). No licence stated on the endpoint; the equivalent open dataset is 政府資料開放授權條款-第1版.

**Static metadata** (still on the open-data platform, active, fetches fine):
`https://data.ntpc.gov.tw/api/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68/csv/file` — 375,817 bytes, fields `ID, AREA, NAME, TYPE, SUMMARY, ADDRESS, TEL, PAYEX, SERVICETIME, TW97X, TW97Y, TOTALCAR, TOTALMOTOR, TOTALBIKE`. Coordinates are TWD97 TM2 (EPSG:3826), needing `pyproj`, which the project already depends on — but `getSpot.ashx` supplies WGS84 `Lat`/`Lng` directly, so this is only needed for lots absent from the live feed.

#### Superseded: the original open-data finding

### 新北市 New Taipei — found, URL/fields confirmed, but **currently unfetchable**

- Real-time dataset: 新北市公有路外停車場即時賸餘車位數, catalogued at `https://data.ntpc.gov.tw/datasets/e09b35a5-a738-48cc-b0f5-570b67ad9c78`, download pattern `https://data.ntpc.gov.tw/api/datasets/{id}/{csv|json|xml}/file`.
- Static metadata: 新北市路外公共停車場資訊, `https://data.ntpc.gov.tw/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68`, fields per the platform's own catalogue: `ID, AREA, NAME, TYPE, SUMMARY, ADDRESS, TEL, PAYEX, SERVICETIME, TW97X, TW97Y, TOTALCAR, TOTALMOTOR, TOTALBIKE`.
- Official field description for the real-time file (pulled from `https://data.ntpc.gov.tw/api/datasets/info/csv`, which **did** load successfully): "PARK:某停車場資料 ID:停車場編號 AVAILABLE:停車場目前之剩餘（汽車）車位數；部分停車場因更換營運廠商，尚無提供即時車位，其顯示數值將為-9。" — i.e. field `AVAILABLE`, car-only, sentinel `-9`, cadence "every 3 minutes."
- **Verification result: every fetch of both dataset IDs (`e09b35a5...` and `b1464ef0...`), in any format (csv/json), was rejected** by an Incapsula-style WAF with `Request Rejected / Your support ID is: ...`. This was tried via: plain `curl`, `curl` with full browser headers + referrer, `curl` with a session cookie harvested from the HTML dataset page, `WebFetch`, and a real headless-Chrome navigation (Claude Browser pane) — all five blocked identically.
- Control test: a different, unrelated dataset ID on the *same* platform (`394d1632-69fc-4792-a74d-88f5b1b46036/csv/file`) and the platform's own bulk dataset-list CSV (`/api/datasets/info/csv`) **both loaded fine** with plain curl — so this is not a general IP/network block, it is a rule targeting these two specific (heavily-scraped) parking dataset IDs specifically.
- Conclusion: label this **unverified** — the pattern and field names are correct and documented, but no client available to this task could actually pull current data today. A production collector may fare differently (different IP range, or the block may be intermittent), but do not assume it works without testing again from the deployment environment.
- Licence: 政府資料開放授權條款-第1版.

### 桃園市 Taoyuan — verified

- Endpoint: `https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0381e141-f7ee-450e-99da-2240208d1773/download` — HTTP 200, 179,203 bytes, 246 records.
- Sample (trimmed ~230 chars): `{"wgsY": "121.2985", "wgsX": "24.959", "areaId": "3", "address": "廣福路42號(廣福段258地號)", "parkName": "大湳公有停車場(桃交)", "areaName": "八德區", "totalSpace": "207", "chargingSpaces": "5", ...`
- This single feed combines static metadata *and* live availability — no separate dataset needed. Fields: `parkId, parkName, address, areaId, areaName, totalSpace, surplusSpace, chargingSpaces, payGuide, introduction, wgsX, wgsY, Display`.
- Note the coordinate fields are mislabelled/swapped: `wgsY` actually holds the **longitude** (~121.x) and `wgsX` holds the **latitude** (~24.x/25.x) in every record checked — the opposite of what the names imply.
- Car spaces available: `surplusSpace`. No motorcycle field at all (Taoyuan's public off-street dataset is car-only). No sentinel value observed — of the 246 records fetched, none had negative `surplusSpace`; unreported lots may simply be absent rather than flagged.
- No lot-level timestamp; API docs (`https://data.tycg.gov.tw/opendata/datalist/datasetMeta/outboundDesc?...`) claim "updated every minute."
- Licence: 政府資料開放授權條款-第1版. XML mirror also available at a sibling resource ID.
- Off-street only (dataset title is explicitly "路外停車資訊").

### 臺中市 Taichung — verified, but status-only (no exact counts)

- Endpoint: `https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=4f9c4d26-d826-4277-8f8a-6d2469fe9653` — HTTP 200, 365,020 bytes, 1,387 records. (Mirror at `https://motoretag.taichung.gov.tw/DataAPI/api/ParkingAPIV2/Opendata` also works, 352,829 bytes, same shape.)
- Sample (trimmed): `[{"ID":"1003","SeqNo":"1","Position":"南屯區-交通局-廣兼停158P","Lng":"120.642014","Lat":"24.1384048","AvailableCarRGB":"G","AvailableMotorRGB":"G","KeyWord":"南屯路","TotalCar":"20","TotalMotor":"0","EvRGB":"G","EvTotal":"0"},...`
- **Important limitation**: `AvailableCarRGB` and `AvailableMotorRGB` are traffic-light codes (`G`=有空位/green, presumably `Y`=將滿/yellow, `R`=已滿/red — only `G` was seen across a large sample) — there is **no numeric available-spaces field anywhere in this feed**. `TotalCar` / `TotalMotor` are capacities only. If ParkCast needs an actual number for Taichung, this dataset cannot supply it; Taichung's own `tcparking.taichung.gov.tw/ParkWeb/PublicService/ParkingRemainder` site was checked for a richer backing API but no JSON endpoint could be located (it appears to be a Vue app whose data call never fired in a quick headless check — worth a deeper look if Taichung numeric data becomes a priority, but out of scope here).
- Licence: 政府資料開放授權條款-第1版. data.gov.tw also lists a TDX mirror (`.../Parking/OffStreet/ParkingAvailability/City/Taichung`) which is explicitly out of scope per the task brief.
- Off-street only.

### 臺南市 Tainan — verified, best-fielded feed found

- Endpoint: `https://parkweb.tainan.gov.tw/api/parking.php` — HTTP 200, 137,178 bytes, 268 records.
- Sample (trimmed): `[{"typeId":"2","typeName":"公有收費停車場","id":"1","code":"B00001","name":"海安路地下停車場","zoneId":"1","zone":"中西區","address":"台南市中西區海安路188號B1","largeCar":0,"car":361,"carDis":0,"carWoman":0,"carGreen":0,"moto":0,"motoDis":0,"largeCar_total":0,"car_total":909,...`
- Fields: `id`, `code`, `name`, `typeId`/`typeName` (公有收費停車場 / 智慧停車 / 民營停車場), `zone`, `address`; availability: `car`/`car_total`, `moto`/`moto_total`, plus `largeCar`, `carDis`, `carWoman`, `carGreen` (each with a `_total` counterpart), `chargeTime`, `chargeFee`, `lnglat` ("lat,lng" string), and a per-record `update_time` (confirmed matching wall-clock at fetch time, e.g. `2026-09-16 08:54:02`).
- Motorcycle counts (`moto`/`moto_total`) are non-zero on 20 of 268 lots — the rest are car-only facilities (field present, legitimately zero).
- No documented sentinel for "not reporting" was found; unreported lots seem to just show 0/0.
- Static + real-time combined in one feed — no separate metadata dataset needed. This is the richest, best-structured feed of the ones found outside Taipei.
- Licence: 政府資料開放授權條款-第1版 (per the data.gov.tw-listed dataset "臺南市停車場即時剩餘車位資訊(JSON)", dataset ID 102772). Update frequency listed there as "不定期更新" but in practice it is close to real-time (record timestamps a few minutes old at most).
- Off-street only (also separately provides on-street via TDX/other datasets, not used here).

### 高雄市 Kaohsiung — verified, largest feed found

- Endpoint: `POST https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLotPost` with an empty JSON body (`{}`) and header `Content-Type: application/json` — HTTP 200, 1,623,589 bytes, 1,447 records under top-level key `parkingLots`. (Discovered by inspecting the public map page's own JS-referenced endpoint names — `ParkingLotPost` for off-street lots, `RoadSideParkingPost` for on-street, which was *not* used here.)
- Sample (trimmed): `{"parkingLots":[{"id":"PL_KHB00035","ownername":"平面","name":"華泰停車場","volumn":"22","leftspace":"-2","areaid":"KHB00035","areaname":"鼓山區","lat":"22.6707248677779","lng":"120.294041415651","location":"華泰路281號北側近華榮路","telephone":"0973-315349、0937-526524",...`
- Fields: `id`, `name`, `ownername`/`parkingLotType` (平面/機械/地下 etc.), `cate` (公有/私有民營/公辦民營), `areaid`/`areaname`, `lat`/`lng`, `location`, `telephone`, `businesshours`, `chargeway`, `chargingPileCount`; capacity: `volumn` (total), `volumnAuto`, `volumnTruck`, `volumnScooter`, `volumnBike`; availability: `leftspace` (overall), `smallcarVacancy`, `largecarVacancy`, `motorcycleVacancy`.
- **Sentinel values differ from Taipei/New Taipei**: this feed uses **-1** and **-2** (not -9) for "not reporting" — e.g. `largecarVacancy`/`motorcycleVacancy` frequently show `-1` even when `smallcarVacancy` has a real value, and `-2` appears on `leftspace` when the whole lot isn't reporting. Of 1,447 lots, 952 have a real (non-sentinel) `leftspace`, and 120 have a real (non-sentinel) `motorcycleVacancy`.
- Static + real-time combined in one feed. No separate metadata dataset needed.
- No update-frequency statement and no licence statement found on the page itself (this is not a data.gov.tw-catalogued dataset, it's the API backing the city's own map widget at `https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLocation`) — treat licence/reuse terms as unstated/unclear; there is also a static public/private lot list on data.gov.tw (`dataset/46944`, `dataset/47055`) under the standard 政府資料開放授權條款-第1版 if a documented-licence static fallback is wanted.
- Off-street only (on-street is the separate `RoadSideParkingPost` endpoint on the same host, not used).

### 基隆市 Keelung — verified (HTML table, not JSON)

- Endpoint: `https://e-traffic.klcg.gov.tw/KeelungTraffic/pages/park.jsp/` — HTTP 200, 5,629 bytes, plain server-rendered HTML (no JS/XHR involved — confirmed by plain `curl` returning the exact same live numbers as a browser render).
- Sample row (verbatim from the table, trimmed): `<td>基隆東岸停車場</td><td>323</td><td>2026-09-16 09:02</td>` — columns are 停車場名稱 (name) / 剩餘停車格 (available spaces) / 更新時間 (per-row update time, confirmed live).
- No JSON API, no lot ID, no coordinates, no capacity, and no motorcycle breakdown — just name + available count + timestamp, ~42 rows (mix of public 基隆市-prefixed lots and private operators like 力揚, 尚京典建設).
- Static metadata fallback: 基隆市公有路外停車場基本資料, `https://data.gov.tw/dataset/45757`, CSV at `https://www.klcg.gov.tw/wSite/public/Attachment/01602/f1728958369371.csv` — only 23 facilities (name, spaces, address, phone), and names don't obviously key-match the live table 1:1 (the live table includes many private operators absent from the static public-lot CSV).
- Licence: the static CSV carries 政府資料開放授權條款-第1版; the live HTML table page has no licence statement at all.
- Off-street only, in principle — table title says "停車場" generically and includes some names that read as street-side, but no on-street/roadside language was seen; treat as off-street.

### 新竹市 Hsinchu City — verified

- Endpoint: `https://hispark.hccg.gov.tw/OpenData/GetParkInfo` — HTTP 200, 34,334 bytes, 55 records.
- Sample (trimmed): `[{"PARKNO":"004","PARKINGNAME":"府後地下停車場","ADDRESS":"新竹市北區府後街42號","BUSINESSHOURS":"24H","WEEKDAYS":"汽車：20元/H","HOLIDAY":"汽車：20元/H...充電設備資訊...","FREEQUANTITYBIG":0,"TOTALQUANTITYBIG":0,"FREEQUANTITY":54,"TOTALQUANTITY":287,"FREEQUANTITYMOT":0,"TOTALQUANTITYMOT":0,...`
- Fields: `PARKNO` (lot id), `PARKINGNAME`, `ADDRESS`, `BUSINESSHOURS`, `WEEKDAYS`/`HOLIDAY` (pricing text), `LONGITUDE`/`LATITUDE`, per-record `UPDATETIME` (confirmed live, e.g. `2026-09-16T09:01:45.08`); capacity/availability pairs: `FREEQUANTITY`/`TOTALQUANTITY` (car), `FREEQUANTITYMOT`/`TOTALQUANTITYMOT` (motorcycle), plus `FREEQUANTITYBIG`/`TOTALQUANTITYBIG` (large vehicle), `FREEQUANTITYDIS`/`TOTALQUANTITYDIS` (disabled), `FREEQUANTITYCW`/`TOTALQUANTITYCW` (women/child), `FREEQUANTITYECAR`/`TOTALQUANTITYECAR` (EV), `FREEQUANTITYFDY`/`TOTALQUANTITYFDY`.
- Motorcycle field populated (non-zero total) on 17 of 55 lots; the rest are car-only facilities.
- No sentinel value for non-reporting was identified (small dataset, didn't observe any obviously-invalid values — everything looked like plausible real counts).
- Static + real-time combined; data.gov.tw lists this as dataset 129136 ("新竹市剩餘停車位資訊") under 政府資料開放授權條款-第1版, though the data.gov.tw page itself confusingly states update frequency "每1年" (once a year) — clearly wrong for a feed that timestamps every record to the minute; trust the per-record `UPDATETIME`, not the catalogue metadata.
- Off-street only.

### 嘉義市 Chiayi City — verified (HTML table, not JSON)

- Endpoint: `https://iparking.chiayi.gov.tw/car/open` — HTTP 200, 79,365 bytes, plain server-rendered HTML (confirmed via `curl` alone, no JS needed — the 停車場/成滿/剩餘 strings are present in the raw response body).
- Sample row (verbatim, trimmed): `西市場大樓停車場 / 133 / 5成滿（54） / 2026-09-16 09:05:12` — columns are 停車場名稱 (name) / 總車位 (total) / 剩餘 (availability, formatted as "`N`成滿（`count`）" e.g. "50% full (54 left)", or "尚有空位（`count`）" = "spaces available (`count`)", or "滿場" = full) / 最後更新時間 (per-row timestamp, confirmed live).
- ~85 lots, mixing public (西市場, 中正公園地下, 市府地下汽車 etc.) and several private chains (嘟嘟房, 城市車旅, 俥亭, 宜舍, 兆盈, DS Parking-style operators).
- No lot ID, no coordinates, no motorcycle breakdown in this feed; the "剩餘" text needs light parsing to pull the parenthesised integer out (percent-full descriptor is not itself useful, but the exact count in parentheses is present on every non-full row).
- Static metadata fallback: 嘉義市公有路外停車場資訊, `https://data.chiayi.gov.tw/opendata/dataset/preview?oid=d206db33-3ae7-489e-b709-5555222fb767&rid=4e0c8e01-9844-4da6-991b-a3382b51b71b` — fields include 大型車/小型車/身障/婦幼/機車/身障機車 capacity columns, static only, no live URL surfaced (page didn't expose a machine-readable download link in the fetch).
- Licence: no licence statement seen on the live iparking page. Static dataset likely under the usual 政府資料開放授權條款-第1版 (not confirmed in this pass).
- Off-street only.

---

## Cities/counties with nothing free found (off-street, real-time, no key)

For all of these, the standard TDX `Parking/OffStreet/ParkingAvailability/City/{City}` endpoint is presumably the only comprehensive option, and per the task brief that requires a paid-tier key beyond casual use — so they're listed here as "nothing free" even though TDX itself technically has the data.

- **新竹縣 Hsinchu County** — `hcpark.hchg.gov.tw/web/Parking` lists 41 lots with address/hours/rates but no live space counts and no discoverable API (confirmed 404 on the same `/ParkingLocation/ParkingLotPost` pattern that worked for Kaohsiung/Yunlin).
- **苗栗縣 Miaoli** — `miaoliparking.jotangi.com.tw` only offers a licence-plate fee/violation lookup (`/ParkingFeeInquiry/...`); no location/availability listing found.
- **彰化縣 Changhua** — `chpark.chcg.gov.tw` ("彰化縣路邊停車資訊網") is explicitly **on-street (路邊)** only; no off-street real-time source found.
- **南投縣 Nantou** — county government's own text (found via search) states outright it has no complete/valid off-street parking dataset to open; it only contracted for a paid-parking management system in 2022. Nothing to link.
- **雲林縣 Yunlin** — `parking.yunlin.gov.tw/ParkingLocation/ParkingLotPost` (same vendor pattern as Kaohsiung) returns only 3 lots, all static (no availability field at all — fields are `carParkID, carParkName, geometry, description, telephone, positionLat, positionLon, email, address, fareDescription, ...`, no leftspace-equivalent). The county's other site, `yltraffic.yunlin.gov.tw/dashboard/parking`, renders an empty shell with no data in a quick headless check — likely needs deeper JS interaction than was justified here. Not counted as a working feed.
- **嘉義縣 Chiayi County** — 嘉義縣路外停車場資訊 dataset (`data.gov.tw/dataset/134172`) is static-only (CSV at `ws-tm.cyhg.gov.tw`), fields limited to type/capacity by vehicle class, no live availability.
- **屏東縣 Pingtung** — county has a "智慧停車控制中心" (smart parking control centre) feeding the private Qparking app and roadside digital signs, but no public API or open dataset was found.
- **宜蘭縣 Yilan** — `park.e-land.gov.tw` ("宜蘭縣路邊收費停車場") is a fee/receipt lookup system only; no availability data, and it's roadside (路邊) branded anyway.
- **花蓮縣 Hualien** — `110traffic.hl.gov.tw` ("花蓮交通e點通") has a "動態停車場資訊" (dynamic parking info) view that sounded promising, but on inspection it only lists lot name/total-capacity/price/address — no live available-space number anywhere in the rendered output despite the "dynamic" label. Not counted as a working feed.
- **臺東縣 Taitung** — no dedicated site or dataset found at all beyond being listed as a TDX-contributing county.
- **澎湖縣 Penghu** — `penghu.gov.tw` links its "本縣地下停車場剩餘車位即時資訊" (underground-lot real-time info) out to a third-party operator site, `zytparking.com`, whose TLS certificate has **expired** — the link is dead as of this research.
- **金門縣 Kinmen** — `kmpark.guoyun.com.tw` is a fee/violation lookup only; live availability is only mentioned as existing inside a mobile app ("金好停"), no web API found.
- **連江縣 Lienchiang (Matsu)** — no site, dataset, or app reference found at all; not even a static lot list turned up in search.

---

## On-street vs off-street note

Every feed listed in the summary table above is off-street (路外), matching the task's scope. Endpoints that were explicitly identified as **on-street/roadside (路邊)** and excluded from the table include: 新北市路邊停車空位查詢 (`data.gov.tw/dataset/122901`), 彰化縣路邊停車資訊網 (`chpark.chcg.gov.tw`), 宜蘭縣路邊收費停車場 (`park.e-land.gov.tw`), 金門縣公有路邊停車 (`kmpark.guoyun.com.tw`), and Kaohsiung's sibling `RoadSideParkingPost` endpoint on the same `kpp.tbkc.gov.tw` host used for the off-street feed above.

## Summary answer

**7 cities have a verified, currently-working, free, no-key off-street availability feed found in this pass** (Taoyuan, Taichung, Tainan, Kaohsiung, Keelung, Hsinchu City, Chiayi City), on top of the pre-existing Taipei baseline (8 total). New Taipei's feed is documented but not fetchable today (WAF-blocked from every tool tried). **3 of the 8 working feeds report real, non-sentinel motorcycle counts on at least some lots** (Taipei, Tainan, Kaohsiung, Hsinchu City — that's actually 4; Taichung exposes a motorcycle field but only as a colour status, not a count). 13 of the 21 target regions have nothing free at all.

The biggest surprise was Kaohsiung: its live feed isn't on any of the usual open-data portals at all — it's the undocumented internal API (`POST /ParkingLocation/ParkingLotPost`) behind the city's own interactive parking map, discovered only by grepping the map page's HTML for endpoint-name strings, and it turned out to be both the largest (1,447 lots) and one of the richest (car/large-vehicle/motorcycle splits, EV charger counts, operator category) feeds of the whole set — with its own distinct sentinel convention (-1/-2) that differs from Taipei/New Taipei's -9. Also notable: two cities' "real-time" pages (Keelung, Chiayi City) turn out to be plain server-rendered HTML with no backing JSON API at all, which still counts as free/live/scrapable but needs HTML parsing rather than `json.loads`; and Taichung's much-referenced open dataset — despite having fields literally named `AvailableCarRGB`/`AvailableMotorRGB` — never exposes an actual number, only a traffic-light colour, which would silently fail if ParkCast expected a Taipei-style integer.
