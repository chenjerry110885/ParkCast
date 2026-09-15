import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_KEY, RECENT_LIMIT, SEARCH_LIMIT, clearRecent, foldKey, kindOf, loadPlaceIndex, lotsAsPlaces, parsePlaceIndex,
  pushRecent, readRecent, resetPlaceIndexCache, searchPlaces, type Place,
} from "../src/places";
import type { Lot } from "../src/types";

const lot = (id: string, n: string, a = "信義區"): Lot => ({ i: 0, id, n, a, y: 25.03, x: 121.56, c: 10, t: "民營停車場", p: { k: "unknown" } });
const place = (name: string, detail: string, extra: Partial<Place> = {}): Place => ({
  name, en: "", kind: kindOf(detail), detail, lat: 25.04, lon: 121.55, qualifier: "", ...extra,
});

describe("foldKey", () => {
  it("folds 臺 to 台, lowercases, and ignores spaces", () => {
    expect(foldKey("臺北車站")).toBe("台北車站");
    expect(foldKey("USPACE 信義")).toBe("uspace信義");
  });
});

describe("kindOf", () => {
  it("groups raw tile kinds", () => {
    expect(kindOf("locality")).toBe("area");
    expect(kindOf("minor_road")).toBe("street");
    expect(kindOf("subway_entrance")).toBe("station");
    expect(kindOf("hospital")).toBe("landmark");
    expect(kindOf("carpark")).toBe("carpark");
  });
});

describe("parsePlaceIndex", () => {
  it("reads the row tuples and refuses a document it does not understand", () => {
    const rows = parsePlaceIndex({ v: 1, built: 1, source: "20260914", rows: [["台北101", "Taipei 101", "attraction", 25.0339, 121.5645, "信義"]] });
    expect(rows).toEqual([{ name: "台北101", en: "Taipei 101", kind: "landmark", detail: "attraction", lat: 25.0339, lon: 121.5645, qualifier: "信義" }]);
    expect(() => parsePlaceIndex({ v: 2, rows: [] })).toThrow();
    expect(() => parsePlaceIndex({ v: 1, rows: [["x", "", "park", "no", 1, ""]] })).toThrow();
    expect(() => parsePlaceIndex(null)).toThrow();
  });
});

describe("searchPlaces", () => {
  const roster = lotsAsPlaces([lot("TPE1", "台北101停車場"), lot("TPE2", "臺北車站停車場", "中正區")]);
  const index = [
    place("台北101", "attraction", { en: "Taipei 101" }),
    place("台北101/世貿", "station"),
    place("忠孝東路四段", "major_road", { qualifier: "大安" }),
    place("忠孝東路四段216巷", "minor_road"),
    place("信義區", "locality"),
    place("台北市立圖書館", "library"),
  ];
  const all = [...roster, ...index];

  it("returns nothing for an empty query", () => {
    expect(searchPlaces(all, "  ")).toEqual([]);
  });

  it("ranks car parks, then stations, landmarks, streets and areas", () => {
    const names = searchPlaces(all, "台北").map((p) => p.name);
    expect(names.slice(0, 2)).toEqual(["台北101停車場", "臺北車站停車場"]);
    expect(names.indexOf("台北101/世貿")).toBeLessThan(names.indexOf("台北101"));
    expect(names.indexOf("台北101")).toBeLessThan(names.indexOf("台北市立圖書館"));
  });

  it("folds 臺 and 台 both ways and matches English names", () => {
    expect(searchPlaces(all, "臺北101").map((p) => p.name)).toContain("台北101");
    expect(searchPlaces(all, "taipei").map((p) => p.name)).toContain("台北101");
  });

  it("orders streets by match position, so the section comes before its lanes", () => {
    const names = searchPlaces(all, "忠孝東路四段").map((p) => p.name);
    expect(names).toEqual(["忠孝東路四段", "忠孝東路四段216巷"]);
  });

  it("matches a car park by its district too, after name matches", () => {
    expect(searchPlaces(all, "中正").map((p) => p.name)).toEqual(["臺北車站停車場"]);
  });

  it("uses a row's precomputed fold key, and folds a row that carries none", () => {
    // Both paths in one search: the index may arrive with `nameKey` already
    // folded, while a recent read back out of storage (or any hand-built row)
    // does not -- and neither may quietly stop matching.
    const precomputed: Place = { ...place("臺北小巨蛋", "attraction"), nameKey: foldKey("臺北小巨蛋") };
    const plain = place("台北車站", "station");
    expect(searchPlaces([precomputed, plain], "台北").map((p) => p.name)).toEqual(["台北車站", "臺北小巨蛋"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => place(`公園${i}`, "park"));
    expect(searchPlaces(many, "公園").length).toBe(SEARCH_LIMIT);
    expect(searchPlaces(many, "公園", 3).length).toBe(3);
  });
});

describe("loadPlaceIndex", () => {
  beforeEach(resetPlaceIndexCache);

  it("fetches once per url and shares the promise", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ v: 1, built: 1, source: "x", rows: [["西門町", "", "locality", 25.04, 121.5, ""]] })));
    const a = loadPlaceIndex("/places/taipei.json", fetchImpl as unknown as typeof fetch);
    const b = loadPlaceIndex("/places/taipei.json", fetchImpl as unknown as typeof fetch);
    expect(await a).toEqual(await b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await a)[0]!.kind).toBe("area");
  });

  it("resolves empty on failure and tries again next time", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(await loadPlaceIndex("/places/taipei.json", fetchImpl as unknown as typeof fetch)).toEqual([]);
    await loadPlaceIndex("/places/taipei.json", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("recent searches", () => {
  function fakeStorage(): Storage {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;
  }

  it("keeps the last five, newest first, without duplicates", () => {
    const s = fakeStorage();
    for (let i = 0; i < 7; i++) pushRecent(s, place(`p${i}`, "park"));
    pushRecent(s, place("p6", "park"));
    const names = readRecent(s).map((p) => p.name);
    expect(names).toEqual(["p6", "p5", "p4", "p3", "p2"]);
    expect(names.length).toBe(RECENT_LIMIT);
    clearRecent(s);
    expect(readRecent(s)).toEqual([]);
  });

  it("drops a stored entry whose coordinates are not numbers", () => {
    // Storage is the one input nothing validated on the way in. A recent with a
    // null `lat` would be handed back and chosen as a destination, which ranks
    // the whole roster at a NaN distance rather than failing where it is seen.
    const s = fakeStorage();
    pushRecent(s, place("西門町", "locality"));
    const stored = JSON.parse(s.getItem(RECENT_KEY) ?? "[]") as Place[];
    s.setItem(RECENT_KEY, JSON.stringify([{ ...stored[0], lat: null }, { ...stored[0], name: "板橋", lon: "x" }]));
    expect(readRecent(s)).toEqual([]);
  });

  it("survives a storage that throws or is missing", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} } as unknown as Storage;
    expect(readRecent(broken)).toEqual([]);
    expect(() => pushRecent(broken, place("x", "park"))).not.toThrow();
    expect(readRecent(null)).toEqual([]);
  });
});
