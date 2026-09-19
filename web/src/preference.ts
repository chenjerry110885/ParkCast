/**
 * Remembering which way the driver asked the ranking to lean.
 *
 * The preference itself lives in `rank.ts`, beside the cost model it is a
 * parameter of -- see `Preference` and `PREFERENCES`. This module is only about
 * keeping it between visits, and it is deliberately the same shape as
 * `places.ts`'s recent list, because it makes the same promise about the same
 * unreliable API: `localStorage` is a convenience, never a requirement.
 *
 * A private window, a browser with site data blocked, an origin over quota, a
 * render with no `window` at all -- in every one of those the accessor is
 * missing or throws, and in every one of them the app must go on ranking by
 * `DEFAULT_PREFERENCE` rather than failing to start. The same goes for a value
 * that *is* there and makes no sense: an older build's shape, a key half
 * written when the tab closed, a hand-edited one. It reads as Balanced. There
 * is no state of the browser in which choosing a preference can break the app,
 * and no stored string that can reach `rankLots` without being recognised
 * first.
 *
 * Nothing here leaves the device. One word, in one key, read by the ranker on
 * this phone: not in a URL, not in a request, not in the published artifacts.
 */
import { DEFAULT_PREFERENCE, PREFERENCES, type Preference } from "./rank";

/**
 * localStorage key for the chosen preference. Versioned like
 * `places.RECENT_KEY`, so a later change of shape can start clean instead of
 * having to interpret whatever this version wrote.
 */
export const PREFERENCE_KEY = "parkcast.preference.v1";

/**
 * Whether an arbitrary value is a preference the ranker has prices for.
 *
 * The one place an untrusted string becomes a `Preference`, so it is written to
 * be exactly as narrow as `PREFERENCES` is: `Object.hasOwn` rather than an
 * `in`, a truthiness test, or a lookup compared against `undefined`, all three
 * of which walk the prototype chain and would cheerfully accept `"toString"`
 * and hand `rankLots` a function where a pair of prices should be.
 *
 * Driven off the table rather than a list repeated here, so a fourth preset
 * cannot be added to the ranker and silently fail to survive a reload.
 */
export function isPreference(value: unknown): value is Preference {
  return typeof value === "string" && Object.hasOwn(PREFERENCES, value);
}

/**
 * The stored preference, or `DEFAULT_PREFERENCE` when there is nothing stored,
 * nowhere to store it, or nothing recognisable there.
 *
 * Takes the `Storage` rather than reaching for `window.localStorage` itself:
 * the caller owns that decision (`PlaceSearch` does the same), which is what
 * makes both the SSR case and the test case a `null` instead of a special
 * case.
 */
export function readPreference(storage: Storage | null): Preference {
  try {
    const raw = storage?.getItem(PREFERENCE_KEY);
    return isPreference(raw) ? raw : DEFAULT_PREFERENCE;
  } catch {
    // Reading `localStorage` can throw outright when site data is blocked.
    return DEFAULT_PREFERENCE;
  }
}

/**
 * Remembers `preference` for next time.
 *
 * Stored as the plain word rather than as JSON: there is one value, it is
 * already a string, and `JSON.parse` would only add a second way for a corrupt
 * key to throw on the way back in.
 */
export function writePreference(storage: Storage | null, preference: Preference): void {
  try {
    storage?.setItem(PREFERENCE_KEY, preference);
  } catch {
    // Blocked or full. The choice still applies to this session -- it just will
    // not survive a reload, which is a far better outcome than throwing out of
    // a tap handler.
  }
}
