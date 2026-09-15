/**
 * The bilingual layer. ParkCast's users are bilingual, and so is the app.
 *
 * The translatable boundary is fixed by the upstream feed, which is 100% Chinese
 * for every user-facing field -- there is no English anywhere in it:
 *
 *   - UI chrome (this file's `Strings`)        -- we author it, so: translate
 *   - Districts, `area` (12 distinct values)    -- a small closed set: translate
 *   - Operator types, `type2` (8 distinct)      -- a small closed set: translate
 *   - Lot names (~1,750 distinct)               -- NEVER translated, see below
 *
 * Lot names stay in Chinese under the English UI **on purpose**. They match the
 * physical signage a driver reads on arrival at the car park; translating or
 * transliterating them would make the app harder to use at the exact moment it
 * matters, not easier. Do not "fix" this -- there is nothing to fix.
 *
 * `Strings` is an interface, and both dictionaries are typed as `Strings`, so a
 * missing or misspelled key is a compile error, not a blank space in the
 * running UI. `districtName` and `lotTypeName` fall back to the source string
 * for anything unrecognised -- the feed can add a district or an operator type
 * at any time, and showing the Chinese is far better than showing `undefined`.
 */

export type Lang = "en" | "zh";

export interface Strings {
  /** The app's name, shown in the header. */
  appName: string;
  /** Button label: use the device's geolocation instead of picking a point. */
  useMyLocation: string;
  /** Unit suffix for an hourly rate, e.g. "NT$60 per hour". */
  perHour: string;
  /**
   * Unit suffix for a flat per-visit fee, e.g. "NT$50 per entry".
   *
   * 21 lots charge 計次 -- once per entry, not per hour. Without this string the
   * UI would have to fall back to `priceUnknown` for every one of them, which
   * would be a lie: their price is known, it is just not hourly.
   */
  perEntry: string;
  /** Shown instead of a price when the feed's free-text fare couldn't be parsed. */
  priceUnknown: string;
  /** Shown instead of a probability when the grid has no forecast for a lot. */
  noData: string;
  /**
   * Shown instead of a probability for a car park whose feed is not updating:
   * the same reading, or none at all, for at least a day. Deliberately not
   * "offline" or "lost connection" -- for most of these lots the feed still
   * sends a number, and all we can see is that it stopped changing.
   */
  notUpdating: string;
  /** Under `notUpdating`, e.g. "No change in 30 h". Carries `{n}`, whole hours. */
  unchangedForTemplate: string;
  /** Shown while geolocation is being requested. */
  locating: string;
  /** Shown when geolocation was denied or failed. */
  locationUnavailable: string;
  /** Unit suffix for a duration in minutes, e.g. "12 min" / "12 分鐘". */
  minutesUnit: string;
  /** Unit suffix for a distance under a kilometre, e.g. "320 m". */
  metersUnit: string;
  /** Unit suffix for a distance of a kilometre or more, e.g. "1.4 km". */
  kilometersUnit: string;
  /**
   * The staleness line, e.g. "data from 3 min ago". Contains a `{n}`
   * placeholder for the minute count -- substitute it with `fillTemplate`.
   */
  stalenessTemplate: string;
  /** Shown while the two artifacts are downloading. */
  loading: string;
  /** Shown when the artifacts could not be fetched or did not parse. */
  loadFailed: string;
  /** Label on the button that retries a failed load. */
  retry: string;
  /**
   * Shown over the map before a destination is known -- the list has nothing to
   * rank against yet. Names the two ways in that are visible at that moment:
   * the search box in front of the user, and the map filling the screen behind
   * it. (Geolocation is the third, and the one an icon button already offers.)
   */
  startPromptMap: string;
  /** Visible label on the place search box. */
  searchLabel: string;
  /** Example queries in the search box, shown while it is empty -- one of each kind it can find. */
  searchPlaceholder: string;
  /**
   * What the search can and cannot find.
   *
   * Load-bearing rather than decorative. `PlaceSearch` merges the live roster
   * with an offline place index (see `../places`), so this now finds car
   * parks, landmarks, MRT and rail stations, streets down to the lane, and
   * neighbourhoods -- but never a house number, because the index built by
   * `scripts/build-place-index.mjs` has none to search. A search box with no
   * such caption reads as a full address lookup and earns every "it can't
   * find anything" the limitation would otherwise get.
   */
  searchHint: string;
  /** Accessible name for the results listbox when it holds search matches (recent picks use `recentSearches` instead). */
  searchResultsLabel: string;
  /** Announced when results change, e.g. "8 matching places". Carries `{n}`. */
  searchResultsTemplate: string;
  /** Shown under the box when a query matches no place at all -- roster or index. */
  searchNoMatch: string;
  /**
   * Shown under the results while the offline place index is still loading,
   * for a query the live roster alone hasn't already answered. The index is
   * fetched lazily on the search box's first focus, so a driver who searches
   * right away can see this for a moment before the fuller, grouped results
   * arrive.
   */
  loadingPlaces: string;
  /** Heading over the on-device recent-picks list, shown when the search box is empty and focused. Also that list's accessible name. */
  recentSearches: string;
  /** Button label that clears the on-device recent-picks list. */
  clearRecent: string;
  /** Group heading over car park results in the search list. */
  groupCarParks: string;
  /** Group heading over MRT and rail station results in the search list. */
  groupStations: string;
  /** Group heading over landmark results in the search list. */
  groupLandmarks: string;
  /** Group heading over street and lane results in the search list. */
  groupStreets: string;
  /** Group heading over neighbourhood/area results in the search list. */
  groupAreas: string;
  /** Accessible label for the button that clears the search box's query. */
  clearSearch: string;
  /** Heading over the ranked list. */
  rankedForArrival: string;
  /**
   * Heading over the list once the forecast has expired: the rows are still
   * ordered, but by walk and price alone, so the heading must stop promising
   * that the order has anything to do with the arrival time.
   */
  nearbyCarParks: string;
  /**
   * Shown when the reading behind the grid is older than the grid's own span,
   * so no arrival time the user can pick has a forecast behind it any more.
   * Says what expired and, just as importantly, what did not.
   */
  forecastTooOld: string;
  /**
   * Shown when the destination is outside the area the roster covers.
   *
   * `rankLots` has no distance cutoff -- it will happily rank Taipei car parks
   * for a driver in Kaohsiung, 291 km and a confident probability away. This is
   * the string that says so instead. Carries `{km}` for the radius, so the
   * sentence cannot drift from `COVERAGE_RADIUS_M`.
   */
  outsideCoverage: string;
  /** Accessible name for the map region. The map itself carries no text. */
  mapLabel: string;
  /**
   * Shown in the map's place while its chunk downloads.
   *
   * MapLibre is 333 KB gzipped and is loaded lazily so the ranked list -- the
   * app's actual answer -- paints without waiting for it. This is a *loading*
   * state, not a failure: nothing has gone wrong, the picture is simply still
   * on its way, and `mapUnavailable` is the string for the case that has.
   */
  mapLoading: string;
  /**
   * Shown in place of the map when the device gives us no WebGL context.
   *
   * The ranked list is the app's actual output, so a map that cannot be drawn
   * is a missing illustration, not a broken app -- and this says so instead of
   * leaving a blank rectangle.
   */
  mapUnavailable: string;
  /** Unit label under the ring's percentage, e.g. "space" / "有車位". */
  spaceLabel: string;
  /** Badge on the top-ranked car park's card. */
  bestPick: string;
  /** Label on the confidence pill, in front of the level word. */
  confidence: string;
  /** Confidence level: mostly the live reading (within `HIGH_MAX_MIN`). */
  confidenceHigh: string;
  /** Confidence level: a blend of the live reading and the usual pattern. */
  confidenceMedium: string;
  /** Confidence level: mostly the usual pattern for this time of week. */
  confidenceLow: string;
  /** The pill's popover text for `confidenceHigh`. */
  confidenceWhyHigh: string;
  /** The pill's popover text for `confidenceMedium`. */
  confidenceWhyMedium: string;
  /** The pill's popover text for `confidenceLow`. */
  confidenceWhyLow: string;
  /** Appended to the freshness badge once its reading has actually expired. */
  expired: string;
  /** Accessible label prefix for the freshness badge, e.g. "Data age: …". */
  freshnessLabel: string;
  /** Label on the card's walking-time fact tile. */
  walkTile: string;
  /** Label on the card's predicted-arrival fact tile. */
  arrivalTile: string;
  /** The observed-spaces fact when the lot has a capacity, e.g. "38 / 400 free · 4 min ago". Carries `{f}`, `{c}`, `{n}`. */
  spacesNowTemplate: string;
  /** The observed-spaces fact when the lot has no published capacity, e.g. "38 free · 4 min ago". Carries `{f}`, `{n}`. */
  spacesNowNoCapacityTemplate: string;
  /** Label on the card's observed-spaces fact tile. */
  spacesNowLabel: string;
  /** Accessible name suffix for a card's tap target, after the lot's own name. */
  selectCard: string;
  /** Label in front of the arrival strip's clock-time readout, e.g. "Arrive at 18:35". */
  arrivalLabel: string;
  /** Lead time under the readout, e.g. "in 15 min". Carries `{n}`, minutes from now. */
  inMinutesTemplate: string;
  /** The strip's tail text once its options run out or the forecast has expired. */
  noForecastBeyond: string;
  /** Accessible name for the arrival strip's radiogroup. */
  arrivalGroupLabel: string;
  /** Accessible label for the bottom sheet's grip button when tapping it would open the sheet to `full`. */
  expandList: string;
  /** Accessible label for the bottom sheet's grip button when tapping it would collapse the sheet. */
  collapseList: string;
}

const en: Strings = {
  appName: "ParkCast",
  useMyLocation: "Use my location",
  perHour: "per hour",
  perEntry: "per entry",
  priceUnknown: "Price unknown",
  noData: "No data",
  notUpdating: "Not updating",
  unchangedForTemplate: "No change in {n} h",
  locating: "Locating…",
  locationUnavailable: "Location unavailable",
  minutesUnit: "min",
  metersUnit: "m",
  kilometersUnit: "km",
  stalenessTemplate: "data from {n} min ago",
  loading: "Loading forecast…",
  loadFailed: "Couldn't load the forecast.",
  retry: "Try again",
  startPromptMap: "Search a place, or tap the map where you're going",
  searchLabel: "Where are you going?",
  searchPlaceholder: "e.g. 台北101, 忠孝東路四段216巷, 西門町",
  searchHint: "Finds car parks, landmarks, MRT stations, streets down to the lane, and neighbourhoods — not house numbers.",
  searchResultsLabel: "Matching places",
  searchResultsTemplate: "{n} matching places",
  searchNoMatch: "Nothing matches that. Try a landmark, a street, or tap the map.",
  loadingPlaces: "loading places…",
  recentSearches: "Recent",
  clearRecent: "Clear",
  groupCarParks: "Car parks",
  groupStations: "Stations",
  groupLandmarks: "Landmarks",
  groupStreets: "Streets & lanes",
  groupAreas: "Areas",
  clearSearch: "Clear search",
  rankedForArrival: "Ranked for your arrival",
  nearbyCarParks: "Car parks nearby",
  forecastTooOld:
    "This forecast is too old to answer for your arrival time, so no chance of a space is shown. Names, walking distances and prices are still correct.",
  outsideCoverage:
    "ParkCast covers Taipei, and no car park it knows is within {km} km of here, so there is nothing worth ranking. The map still works — pick somewhere in the city.",
  mapLabel: "Map of car parks",
  mapLoading: "Loading map…",
  mapUnavailable: "This device can't draw the map. The ranked list still works.",
  spaceLabel: "space",
  bestPick: "Best pick",
  confidence: "Confidence",
  confidenceHigh: "High",
  confidenceMedium: "Medium",
  confidenceLow: "Low",
  confidenceWhyHigh: "Based mostly on the live reading.",
  confidenceWhyMedium: "A mix of the live reading and the usual pattern for this time.",
  confidenceWhyLow: "Mostly the usual pattern for this time of week.",
  expired: "expired",
  freshnessLabel: "Data age",
  walkTile: "Walk",
  arrivalTile: "Arrival",
  spacesNowTemplate: "{f} / {c} free · {n} min ago",
  spacesNowNoCapacityTemplate: "{f} free · {n} min ago",
  spacesNowLabel: "Observed spaces",
  selectCard: "Show on map",
  arrivalLabel: "Arrive at",
  inMinutesTemplate: "in {n} min",
  noForecastBeyond: "no forecast beyond this yet",
  arrivalGroupLabel: "Arrival time",
  expandList: "Expand the list",
  collapseList: "Collapse the list",
};

const zh: Strings = {
  appName: "停車先知",
  useMyLocation: "使用目前位置",
  perHour: "每小時",
  perEntry: "每次",
  priceUnknown: "價格未知",
  noData: "無資料",
  notUpdating: "資料未更新",
  unchangedForTemplate: "已 {n} 小時未變動",
  locating: "定位中…",
  locationUnavailable: "無法取得目前位置",
  minutesUnit: "分鐘",
  metersUnit: "公尺",
  kilometersUnit: "公里",
  stalenessTemplate: "{n} 分鐘前的資料",
  loading: "載入預報中…",
  loadFailed: "無法載入預報。",
  retry: "重試",
  startPromptMap: "搜尋地點，或點選地圖上的目的地",
  searchLabel: "要去哪裡？",
  searchPlaceholder: "例如：台北101、忠孝東路四段216巷、西門町",
  searchHint: "可搜尋停車場、地標、捷運站、路名與巷弄、以及地區，但不含門牌號碼。",
  searchResultsLabel: "符合的地點",
  searchResultsTemplate: "{n} 個符合的地點",
  searchNoMatch: "沒有符合的地點。可改試地標、路名，或直接點選地圖。",
  loadingPlaces: "載入地點中…",
  recentSearches: "最近搜尋",
  clearRecent: "清除",
  groupCarParks: "停車場",
  groupStations: "捷運與車站",
  groupLandmarks: "地標",
  groupStreets: "路名與巷弄",
  groupAreas: "地區",
  clearSearch: "清除搜尋",
  rankedForArrival: "依抵達時間排序",
  nearbyCarParks: "附近的停車場",
  forecastTooOld: "預報資料已過舊，無法推估您抵達時的狀況，因此不顯示有位機率。名稱、步行距離與價格仍然正確。",
  outsideCoverage:
    "停車先知涵蓋的範圍是臺北市，此處 {km} 公里內沒有本站收錄的停車場，因此沒有可排序的結果。地圖仍可使用，請改選市區內的地點。",
  mapLabel: "停車場地圖",
  mapLoading: "載入地圖中…",
  mapUnavailable: "此裝置無法顯示地圖，排序清單仍可使用。",
  spaceLabel: "有車位",
  bestPick: "最佳選擇",
  confidence: "信心",
  confidenceHigh: "高",
  confidenceMedium: "中",
  confidenceLow: "低",
  confidenceWhyHigh: "主要依據最新讀數。",
  confidenceWhyMedium: "綜合最新讀數與此時段的平常狀況。",
  confidenceWhyLow: "主要依據此時段每週的平常狀況。",
  expired: "已過期",
  freshnessLabel: "資料時間",
  walkTile: "步行",
  arrivalTile: "預計抵達",
  spacesNowTemplate: "現在 {f} / {c} 位 · {n} 分鐘前",
  spacesNowNoCapacityTemplate: "現在 {f} 位 · {n} 分鐘前",
  spacesNowLabel: "觀測空位",
  selectCard: "在地圖上顯示",
  arrivalLabel: "抵達",
  inMinutesTemplate: "{n} 分鐘後",
  noForecastBeyond: "之後尚無預測",
  arrivalGroupLabel: "抵達時間",
  expandList: "展開清單",
  collapseList: "收合清單",
};

const DICTS: Record<Lang, Strings> = { en, zh };

/** The UI-chrome dictionary for `lang`. */
export function t(lang: Lang): Strings {
  return DICTS[lang];
}

/**
 * Substitute `{key}` placeholders in a template string, e.g. for
 * `Strings.stalenessTemplate`. Missing keys are left as empty strings rather
 * than throwing -- a slightly wrong staleness line is better than a crash.
 */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined ? "" : String(value);
  });
}

/**
 * English names for the 12 Taipei districts the feed's `area` field uses,
 * matching Taipei City Government's own English district names. Traditional
 * Chinese is the identity mapping -- the feed already spells `area` in
 * Traditional Chinese, so there is nothing to translate on that side.
 */
const DISTRICT_EN: Record<string, string> = {
  中正區: "Zhongzheng District",
  大同區: "Datong District",
  中山區: "Zhongshan District",
  松山區: "Songshan District",
  大安區: "Da'an District",
  萬華區: "Wanhua District",
  信義區: "Xinyi District",
  士林區: "Shilin District",
  北投區: "Beitou District",
  內湖區: "Neihu District",
  南港區: "Nangang District",
  文山區: "Wenshan District",
};

/**
 * `area` (a district name) in `lang`. Falls back to the source string for a
 * district the feed hasn't published yet -- an unrecognised district in
 * Chinese is far more useful than `undefined`.
 */
export function districtName(area: string, lang: Lang): string {
  if (lang === "zh") return area;
  return DISTRICT_EN[area] ?? area;
}

/**
 * English descriptions of the feed's 8 `type2` operator categories. These
 * describe who runs the car park (private operator, city bureau, a city or
 * national agency/school, in-house vs. outsourced) -- translated for meaning,
 * not word-for-word, since a literal gloss of e.g. "本處自營" is opaque to an
 * English reader who has never heard of the issuing bureau.
 */
const LOT_TYPE_EN: Record<string, string> = {
  民營停車場: "Private lot",
  本處委外停車場: "City-outsourced lot",
  市屬機關學校委外: "City agency/school lot (outsourced)",
  "本處自營停車場(委託路邊兼開)": "City-operated lot (also manages curbside parking)",
  市屬機關學校自營: "City agency/school lot (self-operated)",
  中央機關學校委外: "National agency/school lot (outsourced)",
  本處自營停車場: "City-operated lot",
  中央機關學校自營: "National agency/school lot (self-operated)",
};

/**
 * `type2` (an operator category) in `lang`. Falls back to the source string
 * for a category the feed hasn't published yet, same rationale as `districtName`.
 */
export function lotTypeName(type2: string, lang: Lang): string {
  if (lang === "zh") return type2;
  return LOT_TYPE_EN[type2] ?? type2;
}

/**
 * The user's preferred language from the browser, defaulting to `zh` --
 * ParkCast's primary audience is Taipei drivers, so an unrecognised or absent
 * locale should read as Chinese, not English.
 */
export function detectLang(): Lang {
  const lang = typeof navigator === "undefined" ? "" : navigator.language;
  return lang.toLowerCase().startsWith("en") ? "en" : "zh";
}
