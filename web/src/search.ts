/**
 * Finding a destination by name, in memory, over the roster we already hold.
 *
 * The obvious way to answer "I am going to 台北車站" is a geocoding API, and it
 * is the wrong one here: it costs money at volume, needs a key a static
 * front-end has nowhere to hide, adds a third-party origin to an app that
 * currently contacts none, and -- the part that actually matters -- it sends the
 * driver's destination to somebody else. `lots.json` is already in memory and
 * already holds ~1,075 named, positioned places, so this searches those. No
 * network request, no index to build, no dependency.
 *
 * That trade has an honest cost, and the UI states it rather than papering over
 * it: this searches **car park names and districts**, not addresses and not
 * landmarks. `市政府` matches nothing, because the two car parks by Taipei City
 * Hall are called 松壽廣場 and 府前廣場. A landmark table would fix that query and
 * quietly invent a dozen wrong answers elsewhere.
 *
 * Substring rather than prefix, because Chinese has no word boundaries: 車站 is
 * in the middle of every station car park's name, and a prefix search would
 * find none of them.
 */
import type { Lot } from "./types";

/**
 * How many results the listbox offers.
 *
 * Eight rows fit above the fold on a 360 px phone without burying the map, and
 * past the first handful the ordering is doing no work a user reads -- `信義`
 * matches 97 lots on the live roster and typing one more character is faster
 * than scrolling any of them. The cap is on the *list*; the ordering below is
 * total, so the eight shown are the same eight every time.
 */
export const SEARCH_LIMIT = 8;

/**
 * The form a query and a name are compared in. Never what the UI displays.
 *
 * Two folds, and both are measured rather than assumed:
 *
 *   - **臺 → 台.** The feed is inconsistent about the two: 76 published names
 *     use 臺, 108 use 台, and no single name uses both (2026-09-07, 1,075
 *     lots). So without this the variant the driver happens to type decides
 *     which half of the roster they are allowed to see -- `台北車站` found 1 of
 *     the 4 Taipei Main Station car parks, `台北` 40 of 104. Both characters are
 *     Traditional; this is variant normalisation, not Simplified conversion,
 *     and nothing else in the string is touched.
 *   - **Case.** 33 lots are named `USPACE...` and nobody types that in caps.
 *     `toLowerCase`, not `toLocaleLowerCase`: the locale-aware version maps
 *     `I` to a dotless `ı` under a Turkish locale, which would silently break
 *     Latin matching for a user whose phone is set to `tr`.
 *
 * The **displayed** name stays byte-identical to the feed, because it has to
 * match the sign on the building the driver is looking for.
 */
export function searchKey(text: string): string {
  return text.replaceAll("臺", "台").toLowerCase();
}

/** A hit, plus the two numbers that order it. */
interface Hit {
  lot: Lot;
  /** 0 when the name matched, 1 when only the district did. */
  tier: number;
  /** Where the query landed in whichever string matched. */
  at: number;
}

/**
 * Every lot whose name or district contains `query`, best first, capped.
 *
 * Ordering is a total order on three keys, so the result is a function of the
 * inputs alone and not of the roster's array order:
 *
 *   1. **Name matches before district-only matches.** Someone typing 信義
 *      probably means the place; the other 95 lots in Xinyi follow it.
 *   2. **Earlier match position first.** `101` puts 台北101停車場 (index 2)
 *      above 詮營信義101停車場 (index 4) -- the more the name *is* the query,
 *      the higher it sits, with no scoring heuristic to argue about.
 *   3. **Feed id.** A stable tiebreak, and the only one that cannot depend on
 *      where a row happened to sit in `lots.json`.
 *
 * A lot is returned whole rather than by array position: its grid row is
 * `Lot.i`, and positions are exactly what `fetchLots` may have shifted.
 */
export function searchLots(
  lots: readonly Lot[],
  query: string,
  limit: number = SEARCH_LIMIT,
): Lot[] {
  const needle = searchKey(query.trim());
  // An empty query means "nothing yet", never "everything": a listbox that
  // opens on focus with an arbitrary eight of the roster in it is noise.
  if (needle === "") return [];

  const hits: Hit[] = [];
  for (const lot of lots) {
    const inName = searchKey(lot.n).indexOf(needle);
    if (inName >= 0) {
      hits.push({ lot, tier: 0, at: inName });
      continue;
    }
    const inArea = searchKey(lot.a).indexOf(needle);
    if (inArea >= 0) hits.push({ lot, tier: 1, at: inArea });
  }

  hits.sort(
    (a, b) => a.tier - b.tier || a.at - b.at || (a.lot.id < b.lot.id ? -1 : a.lot.id > b.lot.id ? 1 : 0),
  );
  return hits.slice(0, limit).map((hit) => hit.lot);
}
