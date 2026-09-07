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
  /** Label in front of the arrival-time control, e.g. "Arriving in 15 min". */
  arrivingIn: string;
  /** Label over the headline probability, e.g. "Chance of a space: 82%". */
  chanceOfSpace: string;
  /** Label in front of the walking-time column. */
  walk: string;
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
  /** Shown before a destination is known -- the list has nothing to rank against. */
  startPrompt: string;
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
  /** Shown when nothing ranked at all -- an empty heading explains nothing. */
  noLotsNearby: string;
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
}

const en: Strings = {
  appName: "ParkCast",
  useMyLocation: "Use my location",
  arrivingIn: "Arriving in",
  chanceOfSpace: "Chance of a space",
  walk: "Walk",
  perHour: "per hour",
  perEntry: "per entry",
  priceUnknown: "Price unknown",
  noData: "No data",
  locating: "Locating…",
  locationUnavailable: "Location unavailable",
  minutesUnit: "min",
  metersUnit: "m",
  kilometersUnit: "km",
  stalenessTemplate: "data from {n} min ago",
  loading: "Loading forecast…",
  loadFailed: "Couldn't load the forecast.",
  retry: "Try again",
  startPrompt: "Tap the map where you're headed, or “Use my location”, to rank the car parks around it.",
  rankedForArrival: "Ranked for your arrival",
  nearbyCarParks: "Car parks nearby",
  forecastTooOld:
    "This forecast is too old to answer for your arrival time, so no chance of a space is shown. Names, walking distances and prices are still correct.",
  noLotsNearby: "No car parks to rank here. Try another point on the map.",
  mapLabel: "Map of car parks",
  mapLoading: "Loading map…",
  mapUnavailable: "This device can't draw the map. The ranked list still works.",
};

const zh: Strings = {
  appName: "停車先知",
  useMyLocation: "使用目前位置",
  arrivingIn: "抵達時間",
  chanceOfSpace: "有位機率",
  walk: "步行",
  perHour: "每小時",
  perEntry: "每次",
  priceUnknown: "價格未知",
  noData: "無資料",
  locating: "定位中…",
  locationUnavailable: "無法取得目前位置",
  minutesUnit: "分鐘",
  metersUnit: "公尺",
  kilometersUnit: "公里",
  stalenessTemplate: "{n} 分鐘前的資料",
  loading: "載入預報中…",
  loadFailed: "無法載入預報。",
  retry: "重試",
  startPrompt: "點選地圖上的目的地，或「使用目前位置」，排序附近的停車場。",
  rankedForArrival: "依抵達時間排序",
  nearbyCarParks: "附近的停車場",
  forecastTooOld: "預報資料已過舊，無法推估您抵達時的狀況，因此不顯示有位機率。名稱、步行距離與價格仍然正確。",
  noLotsNearby: "此處沒有可排序的停車場，請改點選地圖上的其他位置。",
  mapLabel: "停車場地圖",
  mapLoading: "載入地圖中…",
  mapUnavailable: "此裝置無法顯示地圖，排序清單仍可使用。",
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
