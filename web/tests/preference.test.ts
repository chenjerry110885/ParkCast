import { describe, expect, it } from "vitest";
import { PREFERENCE_KEY, isPreference, readPreference, writePreference } from "../src/preference";
import { DEFAULT_PREFERENCE, PREFERENCES, type Preference } from "../src/rank";

/**
 * A `Storage` that works, backed by a Map -- the same shape `places.test.ts`
 * uses for recents, because this module makes the same promise about the same
 * unreliable browser API.
 */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

/** Private browsing, blocked site data, a quota'd-out origin: the accessor throws. */
const brokenStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {},
} as unknown as Storage;

describe("readPreference / writePreference", () => {
  it("defaults to balanced when the driver has never chosen", () => {
    // Balanced is the shipped pair, so a first visit ranks exactly as the app
    // ranked before this feature existed. See `rank.test.ts`.
    expect(DEFAULT_PREFERENCE).toBe("balanced");
    expect(readPreference(fakeStorage())).toBe("balanced");
  });

  it("round-trips every preset the ranker offers", () => {
    // Driven off `PREFERENCES` rather than a list typed out here, so a fourth
    // preset cannot be added to the ranker and silently go unstored.
    const storage = fakeStorage();
    for (const preference of Object.keys(PREFERENCES) as Preference[]) {
      writePreference(storage, preference);
      expect(readPreference(storage)).toBe(preference);
    }
  });

  it("reads an unrecognised or corrupt stored value as balanced, never as a crash", () => {
    // Storage is the one input nothing validated on the way in: an older build's
    // shape, a half-written key, a hand-edited one. Note `toString` and
    // `constructor` -- an existence check that walked the prototype chain would
    // accept both and hand the ranker a function as a preference.
    const storage = fakeStorage();
    for (const raw of ["", "closest", "CHEAPER", " closer ", "null", "0", '{"preference":"closer"}',
                       "toString", "constructor", "__proto__", "[object Object]"]) {
      storage.setItem(PREFERENCE_KEY, raw);
      expect(readPreference(storage)).toBe("balanced");
    }
  });

  it("keeps the app working when storage throws or is not there at all", () => {
    // A preference is a convenience, never a requirement: a private window must
    // leave the driver ranking by Balanced, not looking at a blank screen.
    expect(readPreference(brokenStorage)).toBe("balanced");
    expect(() => writePreference(brokenStorage, "closer")).not.toThrow();
    expect(readPreference(null)).toBe("balanced");
    expect(() => writePreference(null, "closer")).not.toThrow();
  });

  it("stores one word under one versioned key, and nothing else", () => {
    // Plain text rather than JSON: there is nothing here to parse, and
    // `JSON.parse` is one more thing that can throw on a corrupt value.
    const storage = fakeStorage();
    writePreference(storage, "closer");
    expect(storage.getItem(PREFERENCE_KEY)).toBe("closer");
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe(PREFERENCE_KEY);
    expect(PREFERENCE_KEY).toMatch(/^parkcast\..*\.v\d+$/);
  });
});

describe("isPreference", () => {
  it("accepts exactly the presets the ranker has a cost model for", () => {
    // The one place an untrusted string becomes a `Preference`. Anything it lets
    // through indexes `PREFERENCES` and must find a real pair of prices there.
    for (const preference of Object.keys(PREFERENCES)) {
      expect(isPreference(preference)).toBe(true);
    }
    for (const value of ["closest", "Balanced", "", "toString", "constructor",
                         null, undefined, 0, {}, ["closer"]]) {
      expect(isPreference(value)).toBe(false);
    }
  });
});
