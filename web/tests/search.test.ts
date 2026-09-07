/**
 * The roster search, tested as the pure function it is.
 *
 * The fixture is a slice of the real roster -- real ids, real names, real
 * districts -- because every interesting case here is a property of how the
 * Taipei feed actually spells things, and a made-up name would test nothing.
 * In particular the four Taipei Main Station car parks are spelled with 臺 by
 * three of their operators and 台 by the fourth, which is the whole reason
 * `searchKey` exists.
 */
import { describe, expect, it } from "vitest";
import { SEARCH_LIMIT, searchKey, searchLots } from "../src/search";
import type { Lot } from "../src/types";

/** Everything but the four fields the search reads is scaffolding. */
function lot(i: number, id: string, n: string, a: string): Lot {
  return { i, id, n, a, y: 25.04, x: 121.52, c: 50, t: "民營停車場", p: { k: "unknown" } };
}

/**
 * Sixteen real rows from the published `lots.json` (2026-09-07).
 *
 * The four 車站 rows are the measured 臺/台 split; 松壽廣場 and 府前廣場 are the
 * two car parks by Taipei City Hall, which is why `市政府` finds nothing.
 */
const ROSTER: Lot[] = [
  lot(0, "TPE0047", "臺北車站東區地下停車場", "中正區"),
  lot(1, "TPE0085", "臺北車站西側地上停車場", "中正區"),
  lot(2, "TPE0446", "台北車站K區地下街停車場", "中正區"),
  lot(3, "TPE0871", "臺北車站西區地下停車場", "中正區"),
  lot(4, "TPE0575", "萬華車站地下停車場", "萬華區"),
  lot(5, "TPE0374", "台北101停車場", "信義區"),
  lot(6, "TPE1667", "詮營信義101停車場", "信義區"),
  lot(7, "TPE0070", "松壽廣場地下停車場", "信義區"),
  lot(8, "TPE0096", "府前廣場地下停車場", "信義區"),
  lot(9, "TPE0334", "信義廣場地下停車場", "信義區"),
  lot(10, "TPE0020", "USPACE宏泰世界大樓停車場", "松山區"),
  lot(11, "TPE1053", "USPACE交易一號停車場", "信義區"),
  lot(12, "TPE1054", "USPACE交易二號停車場", "信義區"),
  lot(13, "TPE1760", "皇翔臺北廣場停車場", "大同區"),
  lot(14, "TPE0263", "微風廣場地下停車場", "松山區"),
  lot(15, "TPE0851", "松山車站地下停車場", "信義區"),
];

/** Ids of every hit, in the order the search returned them. */
const idsOf = (rows: readonly Lot[]) => rows.map((row) => row.id);

describe("matching", () => {
  it("matches a substring anywhere in the name, not just at the start", () => {
    // Chinese has no word boundaries, so prefix-only matching would miss most
    // of the roster: 車站 is in the middle of every station car park's name.
    const hits = searchLots(ROSTER, "車站", 20);
    expect(idsOf(hits)).toContain("TPE0575");
    expect(idsOf(hits)).toContain("TPE0851");
    expect(hits).toHaveLength(6);
  });

  it("matches Latin text case-insensitively", () => {
    // 33 lots on the live roster are named `USPACE...`; a user types `uspace`.
    expect(idsOf(searchLots(ROSTER, "uspace", 20))).toEqual(["TPE0020", "TPE1053", "TPE1054"]);
    expect(idsOf(searchLots(ROSTER, "USPACE", 20))).toEqual(["TPE0020", "TPE1053", "TPE1054"]);
  });

  it("matches the district too, so a district name finds its lots", () => {
    expect(idsOf(searchLots(ROSTER, "松山區", 20))).toEqual(["TPE0020", "TPE0263"]);
  });

  it("returns a lot that matches on both name and district exactly once", () => {
    const ids = idsOf(searchLots(ROSTER, "信義", 20));
    expect(ids.filter((id) => id === "TPE0334")).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds nothing for a landmark that is not a car park name", () => {
    // Measured over the live roster: `市政府` returns 0. The car parks by
    // Taipei City Hall are 松壽廣場 and 府前廣場. This searches car park names,
    // and the honest answer to `市政府` is that it does not know the place --
    // not a guess, and not an invented landmark table.
    expect(searchLots(ROSTER, "市政府", 20)).toEqual([]);
  });

  it("returns nothing for an empty or whitespace-only query", () => {
    // A blank query must not mean "everything": the listbox would open on
    // focus with an arbitrary handful of the roster in it.
    expect(searchLots(ROSTER, "", 20)).toEqual([]);
    expect(searchLots(ROSTER, "   ", 20)).toEqual([]);
    expect(searchLots(ROSTER, "\t\n ", 20)).toEqual([]);
  });

  it("ignores whitespace around a real query", () => {
    expect(idsOf(searchLots(ROSTER, "  101  ", 20))).toEqual(["TPE0374", "TPE1667"]);
  });
});

/**
 * The one real defect in the feed's own spelling, measured 2026-09-07 over the
 * 1,075 published lots: 76 names use 臺, 108 use 台, and **no name uses both**.
 * Without folding, the variant a driver happens to type decides which half of
 * the roster they are allowed to see -- `台北車站` found one of the four Taipei
 * Main Station car parks, and `台北` found 40 of 104.
 */
describe("the 臺/台 variants", () => {
  it("finds all four Taipei Main Station car parks from either spelling", () => {
    const typedCommon = searchLots(ROSTER, "台北車站", 20);
    const typedFormal = searchLots(ROSTER, "臺北車站", 20);

    expect(idsOf(typedCommon)).toEqual(["TPE0047", "TPE0085", "TPE0446", "TPE0871"]);
    // Both spellings are one query. Not "similar results" -- the same results.
    expect(idsOf(typedFormal)).toEqual(idsOf(typedCommon));
  });

  it("folds in both directions, not just one", () => {
    // One assertion per direction, because a fold applied to only one side of
    // the comparison passes the first and fails the second.
    expect(idsOf(searchLots(ROSTER, "台北廣場", 20))).toEqual(["TPE1760"]); // 台 query, 臺 name
    expect(idsOf(searchLots(ROSTER, "臺北101", 20))).toEqual(["TPE0374"]); // 臺 query, 台 name
  });

  it("leaves the displayed name byte-identical to the feed", () => {
    // The name has to match the sign on the building, so the fold lives in the
    // search key and nowhere near what the UI renders.
    expect(searchLots(ROSTER, "臺北車站K區", 20)[0]?.n).toBe("台北車站K區地下街停車場");
    expect(searchLots(ROSTER, "台北車站東區", 20)[0]?.n).toBe("臺北車站東區地下停車場");
  });

  it("folds 臺 to 台 and case-folds Latin, and changes nothing else", () => {
    expect(searchKey("臺北車站")).toBe("台北車站");
    expect(searchKey("USPACE")).toBe("uspace");
    // Variant normalisation, not simplification: 灣 and 車 are Traditional and
    // are left exactly as they are.
    expect(searchKey("臺灣車站")).toBe("台灣車站");
  });
});

describe("ordering and the cap", () => {
  it("puts name matches ahead of lots that only match on district", () => {
    // 信義 is both a district and part of two lot names. Someone typing it
    // most likely means the place, so the two named lots lead.
    const hits = searchLots(ROSTER, "信義", 20);
    expect(idsOf(hits).slice(0, 2)).toEqual(["TPE0334", "TPE1667"]);
    expect(idsOf(hits)).toContain("TPE0070");
    expect(hits).toHaveLength(8);
  });

  it("puts an earlier match in the name ahead of a later one", () => {
    const ids = idsOf(searchLots(ROSTER, "廣場", 20));
    // 信義廣場 matches at index 2; 皇翔臺北廣場 at index 4.
    expect(ids.indexOf("TPE0334")).toBeLessThan(ids.indexOf("TPE1760"));
    expect(ids.at(-1)).toBe("TPE1760");
  });

  it("orders identically on repeated calls and independently of input order", () => {
    const forwards = idsOf(searchLots(ROSTER, "停車場", 20));
    const backwards = idsOf(searchLots([...ROSTER].reverse(), "停車場", 20));
    expect(idsOf(searchLots(ROSTER, "停車場", 20))).toEqual(forwards);
    expect(backwards).toEqual(forwards);
  });

  it("caps the result list at the limit it is given", () => {
    expect(searchLots(ROSTER, "停車場", 3)).toHaveLength(3);
    expect(idsOf(searchLots(ROSTER, "停車場", 3))).toEqual(
      idsOf(searchLots(ROSTER, "停車場", 20)).slice(0, 3),
    );
    expect(searchLots(ROSTER, "停車場", 20)).toHaveLength(ROSTER.length);
  });

  it("defaults to SEARCH_LIMIT results", () => {
    expect(searchLots(ROSTER, "停車場")).toHaveLength(SEARCH_LIMIT);
    expect(SEARCH_LIMIT).toBeLessThan(ROSTER.length);
  });
});

describe("an empty roster", () => {
  it("returns nothing rather than throwing", () => {
    expect(searchLots([], "台北車站", 20)).toEqual([]);
  });
});
