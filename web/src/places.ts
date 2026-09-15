/**
 * Finding a destination by name: the roster first, the offline index second.
 *
 * `search.ts` already answers "I am going to 台北車站" against the ~1,075 named
 * car parks in `lots.json`, in memory, with no network request. That is
 * correct as far as it goes, but it only goes as far as a car park's own
 * name and district -- `市政府` finds nothing, because the two car parks by
 * Taipei City Hall are called 松壽廣場 and 府前廣場, and a driver does not
 * always know that. `scripts/build-place-index.mjs` fixes the gap the same
 * way `search.ts` fixed geocoding: it reads stations, landmarks, streets and
 * neighbourhoods out of the basemap tiles already shipped for the map, once,
 * offline, into `public/places/taipei.json`, so this module can search
 * *that* too. Still no geocoder, still no key, still nothing that leaves the
 * phone -- the index is a build artifact, not an API.
 *
 * The two sources rank differently on purpose. A car park is where the trip
 * ends, so a car park hit always outranks a landmark hit for the same
 * query; a station or a named place beats a street, and a street beats the
 * neighbourhood it sits in, because the more specific match is the more
 * useful one. `searchPlaces` merges `Place[]` from both sources -- see
 * `lotsAsPlaces` for the roster and `parsePlaceIndex` for the index -- and
 * applies one ordering to the combined list, so neither source has to know
 * the other exists.
 */
import type { Lot } from "./types";

export type PlaceKind = "carpark" | "station" | "landmark" | "street" | "area";

export interface Place {
  name: string;
  en: string;
  kind: PlaceKind;
  /** The raw kind from the tiles ("station", "minor_road", "locality"…) or "carpark". */
  detail: string;
  lat: number;
  lon: number;
  /** District for a car park, nearest locality for anything else, "" when none. */
  qualifier: string;
  lotId?: string;
  /**
   * `foldKey(name)`, precomputed by whoever built the row.
   *
   * Optional because it is an optimisation, not part of what a place *is*: a
   * `Place` assembled by hand (a recent read back out of `localStorage`, a
   * fixture) is still searchable, and `searchPlaces` folds it on first use.
   */
  nameKey?: string;
  /** `foldKey(en)`, or `""` when there is no English name. Same contract as `nameKey`. */
  enKey?: string;
}

export interface PlaceIndexDoc { v: number; built: number; source: string; rows: unknown[] }

/**
 * How many results the listbox offers.
 *
 * Ten rather than `search.ts`'s eight: the combined roster-plus-index list has
 * more near-ties to show (a station and the car parks around it, say), and the
 * ordering below is still total, so the ten shown are the same ten every time.
 */
export const SEARCH_LIMIT = 10;
/** How many recent picks are kept, newest first. */
export const RECENT_LIMIT = 5;
/** localStorage key for recent picks. Versioned so a shape change can start clean. */
export const RECENT_KEY = "parkcast.recent.v1";
const INDEX_VERSION = 1;

/** Mirrors STATION_KINDS + LANDMARK_KINDS + ROAD_KINDS + area kinds in scripts/build-place-index.mjs. */
const PROMINENCE = [
  "station", "subway_entrance",
  "aerodrome", "bus_station", "ferry_terminal", "terminal", "university", "hospital", "mall",
  "department_store", "stadium", "museum", "arts_centre", "theatre", "attraction", "park",
  "townhall", "government", "library", "college", "school", "hotel", "place_of_worship",
  "marketplace", "supermarket", "cinema", "sports_centre", "swimming_pool", "garden", "viewpoint",
  "monument", "memorial", "courthouse", "police", "fire_station", "post_office",
  "community_centre", "clinic", "parking",
  "highway", "major_road", "minor_road",
  "macrohood", "neighbourhood", "locality",
];
const STATION = new Set(["station", "subway_entrance"]);
const STREET = new Set(["highway", "major_road", "minor_road"]);
const AREA = new Set(["macrohood", "neighbourhood", "locality"]);
const TIER: Record<PlaceKind, number> = { carpark: 0, station: 1, landmark: 2, street: 3, area: 4 };

/**
 * The form a query and a name are compared in. Never what the UI displays.
 *
 * Same two folds as `search.ts`'s `searchKey` -- 臺→台 because the basemap, like
 * the roster, is inconsistent about the two characters; `toLowerCase` rather
 * than `toLocaleLowerCase` so a Turkish-locale phone does not turn `I` into a
 * dotless `ı` and break Latin matching -- plus a third fold this module needs
 * that `search.ts` does not: whitespace is removed, because "USPACE 信義" in
 * the roster and a driver typing "uspace信義" should still meet in the middle.
 */
export function foldKey(text: string): string {
  return text.replaceAll("臺", "台").toLowerCase().replace(/\s+/g, "");
}

/** Raw tile kind -> the coarse group the UI and the ranking both key off. */
export function kindOf(detail: string): PlaceKind {
  if (detail === "carpark") return "carpark";
  if (STATION.has(detail)) return "station";
  if (STREET.has(detail)) return "street";
  if (AREA.has(detail)) return "area";
  return "landmark";
}

/** Where a kind sits in `PROMINENCE`; a car park is always first, an unknown kind always last. */
export function prominence(detail: string): number {
  if (detail === "carpark") return -1;
  const at = PROMINENCE.indexOf(detail);
  return at < 0 ? 1000 : at;
}

function isRow(row: unknown): row is [string, string, string, number, number, string] {
  return Array.isArray(row) && row.length === 6 && typeof row[0] === "string" && typeof row[1] === "string"
    && typeof row[2] === "string" && Number.isFinite(row[3]) && Number.isFinite(row[4]) && typeof row[5] === "string";
}

/** Validates and unpacks a fetched `PlaceIndexDoc`; throws rather than serving a document it cannot read. */
export function parsePlaceIndex(doc: unknown): Place[] {
  if (typeof doc !== "object" || doc === null) throw new Error("place index is not an object");
  const d = doc as Partial<PlaceIndexDoc>;
  if (d.v !== INDEX_VERSION || !Array.isArray(d.rows)) throw new Error(`place index v${String(d.v)} is not readable`);
  return d.rows.map((row) => {
    if (!isRow(row)) throw new Error("place index row is malformed");
    const [name, en, detail, lat, lon, qualifier] = row;
    return { name, en, kind: kindOf(detail), detail, lat, lon, qualifier };
  });
}

/** The live roster, reshaped into `Place`s so `searchPlaces` can treat it like any other source. */
export function lotsAsPlaces(lots: readonly Lot[]): Place[] {
  return lots.map((lot) => ({ name: lot.n, en: "", kind: "carpark", detail: "carpark", lat: lot.y, lon: lot.x, qualifier: lot.a, lotId: lot.id }));
}

/**
 * The folded name and English name a row is matched on, computed once per row
 * rather than once per keystroke.
 *
 * `searchPlaces` runs over the whole roster *plus* the whole index -- ~30,000
 * rows -- on every character typed, and folding two strings per row per
 * keystroke is the one piece of real work in this module. A `WeakMap` rather
 * than a field written back onto the row: it holds nothing alive on its own,
 * and it means a `Place` from anywhere (parsed index, roster, `localStorage`, a
 * test fixture) gets the same treatment without anyone having to remember to
 * precompute. A row that *did* arrive precomputed is taken at its word.
 */
const foldedKeys = new WeakMap<Place, { name: string; en: string }>();

function keysFor(place: Place): { name: string; en: string } {
  const cached = foldedKeys.get(place);
  if (cached !== undefined) return cached;
  const computed = {
    name: place.nameKey ?? foldKey(place.name),
    en: place.enKey ?? (place.en === "" ? "" : foldKey(place.en)),
  };
  foldedKeys.set(place, computed);
  return computed;
}

/** A hit, plus the numbers that order it. */
interface Hit {
  place: Place;
  /** 0 (car park) through 4 (area) -- see `TIER`. */
  tier: number;
  /** Where the query landed in whichever of name/English matched. */
  at: number;
}

/**
 * Every place whose name, English name, or (for a car park) district
 * contains `query`, best first, capped.
 *
 * Ordering is total, so the result is a function of the inputs alone:
 *
 *   1. **Tier.** Car park, then station, then landmark, then street, then
 *      area -- the trip ends at a car park, so it always wins; a named place
 *      beats the street it is on, which beats the neighbourhood it is in.
 *   2. **Match position.** The earlier the query lands in the name (or the
 *      English name, whichever is earlier), the more the name *is* the
 *      query. This is what puts 忠孝東路四段 above its own 216巷: both
 *      match at position 0, but 忠孝東路四段216巷 only ties on this key and
 *      falls back to the next ones. A car park matched only by district
 *      sorts after every name match, at `at: 1000`.
 *   3. **Prominence.** Within a tier and match position, the more prominent
 *      raw kind first -- a station outranks a subway entrance, a mall a
 *      supermarket -- from the same table `scripts/build-place-index.mjs`
 *      sorts the index by.
 *   4. **Name, `zh-Hant` collation, then latitude, then longitude.** A
 *      stable tiebreak that cannot depend on array order.
 */
export function searchPlaces(places: readonly Place[], query: string, limit: number = SEARCH_LIMIT): Place[] {
  const needle = foldKey(query);
  // An empty query means "nothing yet", never "everything".
  if (needle === "") return [];

  const hits: Hit[] = [];
  for (const place of places) {
    const folded = keysFor(place);
    const inName = folded.name.indexOf(needle);
    const inEn = folded.en === "" ? -1 : folded.en.indexOf(needle);
    const at = inName >= 0 && inEn >= 0 ? Math.min(inName, inEn) : Math.max(inName, inEn);
    if (at >= 0) {
      hits.push({ place, tier: TIER[place.kind], at });
      continue;
    }
    // A car park also answers to its district, behind every name match.
    if (place.kind === "carpark" && foldKey(place.qualifier).indexOf(needle) >= 0) {
      hits.push({ place, tier: TIER.carpark, at: 1000 });
    }
  }
  hits.sort((a, b) =>
    a.tier - b.tier || a.at - b.at || prominence(a.place.detail) - prominence(b.place.detail)
    || a.place.name.localeCompare(b.place.name, "zh-Hant") || a.place.lat - b.place.lat || a.place.lon - b.place.lon);
  return hits.slice(0, limit).map((h) => h.place);
}

const cache = new Map<string, Promise<Place[]>>();

/** Test-only: drops every cached/in-flight load, so each test starts clean. */
export function resetPlaceIndexCache(): void {
  cache.clear();
}

/**
 * The index, fetched once per page and shared by every caller that asks for
 * the same url. A failure -- bad status, unparsable body, a document
 * `parsePlaceIndex` refuses -- resolves to `[]` rather than rejecting, so a
 * missing index degrades the search to the roster alone instead of crashing
 * the box that asks for it; the failed attempt is dropped from the cache so
 * the next call tries again rather than replaying the same failure forever.
 */
export function loadPlaceIndex(url: string, fetchImpl: typeof fetch = fetch): Promise<Place[]> {
  const pending = cache.get(url);
  if (pending) return pending;
  const attempt = (async () => {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parsePlaceIndex(await res.json());
    } catch {
      cache.delete(url);
      return [];
    }
  })();
  cache.set(url, attempt);
  return attempt;
}

/**
 * Recent picks, newest first. On-device only: nothing here is sent anywhere,
 * and a `storage` that is missing (SSR, a locked-down browser) or throws
 * (private browsing, quota) yields `[]` rather than breaking the caller --
 * recents are a convenience, never a requirement.
 */
export function readRecent(storage: Storage | null): Place[] {
  try {
    const raw = storage?.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredPlace) : [];
  } catch {
    return [];
  }
}

/**
 * Whether a stored entry is a place this module will hand back.
 *
 * Storage is the one input here that nothing validated on the way in: an older
 * build's shape, an entry half-written when the tab closed, or a hand-edited
 * key. The coordinates are checked as well as the name because a recent is
 * chosen as a *destination*: a `lat` of `null` reaches `rankLots` as a NaN
 * distance on every car park in the roster, which is a list that silently
 * orders itself by nothing rather than an error anyone can see.
 */
function isStoredPlace(value: unknown): value is Place {
  if (typeof value !== "object" || value === null) return false;
  const place = value as Partial<Place>;
  return typeof place.name === "string" && Number.isFinite(place.lat) && Number.isFinite(place.lon);
}

/** Adds `place` to the front of the recent list, de-duplicated, capped at `RECENT_LIMIT`. */
export function pushRecent(storage: Storage | null, place: Place): Place[] {
  const same = (a: Place, b: Place) => a.name === b.name && a.kind === b.kind && a.lat === b.lat && a.lon === b.lon;
  const next = [place, ...readRecent(storage).filter((p) => !same(p, place))].slice(0, RECENT_LIMIT);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full: recents are a convenience, never a requirement.
  }
  return next;
}

/** Clears the recent list. Same failure handling as `readRecent`/`pushRecent`. */
export function clearRecent(storage: Storage | null): void {
  try {
    storage?.removeItem(RECENT_KEY);
  } catch {
    // Same as above.
  }
}
