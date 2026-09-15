import { describe, expect, it } from "vitest";
import { checkOrder, parseGridHeader, validatePair } from "../src/validate";
import { makePair, metaFor } from "./fakes";

const NOW = 1_789_352_400;
const enc = new TextEncoder();

function mutateLots(lots: Uint8Array, change: (doc: any) => void): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(lots));
  change(doc);
  return enc.encode(JSON.stringify(doc));
}

describe("validatePair", () => {
  const pair = makePair({ baseDataTs: NOW - 240 });

  it("accepts a well-formed pair", () => {
    expect(validatePair(pair.grid, pair.lots).ok).toBe(true);
  });

  it.each<[string, () => [Uint8Array, Uint8Array]]>([
    ["bad magic", () => { const g = pair.grid.slice(); g[0] = 0x51; return [g, pair.lots]; }],
    ["truncated grid", () => [pair.grid.slice(0, -1), pair.lots]],
    ["wrong horizon count", () => { const g = pair.grid.slice(); g[15] = 12; return [g, pair.lots]; }],
    ["invalid UTF-8", () => [pair.grid, new Uint8Array([0xff, 0xfe])]],
    ["JSON array", () => [pair.grid, enc.encode("[]")]],
    ["roster mismatch", () => [pair.grid, mutateLots(pair.lots, (d) => { d.roster_id = 1; })]],
    ["stamp mismatch", () => [pair.grid, mutateLots(pair.lots, (d) => { d.generated_at += 1; })]],
    ["row index shifted", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[1].i = 2; })]],
    ["row outside Taipei", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].y = 0; })]],
    ["201-character name", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].n = "x".repeat(201); })]],
    ["unknown fare kind", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].p = { k: "free" }; })]],
    ["fractional u", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].u = 1.5; })]],
    ["negative capacity", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].c = -1; })]],
    ["fractional f", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].f = 1.5; })]],
    ["negative f", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].f = -1; })]],
    ["string f", () => [pair.grid, mutateLots(pair.lots, (d) => { d.lots[0].f = "12"; })]],
  ])("rejects %s", (_label, build) => {
    const [grid, lots] = build();
    expect(validatePair(grid, lots).ok).toBe(false);
  });

  it("accepts the observed free count as an integer or null", () => {
    const withCounts = mutateLots(pair.lots, (d) => { d.lots[0].f = 12; d.lots[1].f = null; });
    expect(validatePair(pair.grid, withCounts).ok).toBe(true);
  });
});

describe("checkOrder", () => {
  const pair = makePair({ baseDataTs: NOW - 240, generatedAt: NOW - 30 });
  const header = parseGridHeader(pair.grid)!;
  const older = makePair({ baseDataTs: NOW - 540, generatedAt: NOW - 330 });
  const stored = (o = {}) => metaFor(older, { uploadedAt: NOW - 300, ...o });

  it.each<[string, () => string | null, string | null]>([
    ["first upload", () => checkOrder(header, null, NOW), null],
    ["newer than stored", () => checkOrder(header, stored(), NOW), null],
    ["replay of what is stored", () => checkOrder(header, metaFor(pair), NOW), "stale"],
    ["too soon after the last write", () => checkOrder(header, stored({ uploadedAt: NOW - 60 }), NOW), "too-soon"],
    ["future-dated reading", () => checkOrder({ ...header, baseDataTs: 4_294_967_295 }, null, NOW), "future"],
    ["stored future value is void", () => checkOrder(header, stored({ baseDataTs: 4_294_967_295 }), NOW), null],
    ["reading older than six hours", () => checkOrder(header, null, NOW + 7 * 3600), "too-old"],
    ["roster collapse", () => checkOrder({ ...header, nLots: 1 }, stored({ nLots: 1000 }), NOW), "roster-shrink"],
    ["roster collapse after a day of silence", () => checkOrder({ ...header, nLots: 1 }, stored({ nLots: 1000, uploadedAt: NOW - 25 * 3600 }), NOW), null],
    ["same reading, newer generation (PC clock behind)", () => checkOrder({ ...header, generatedAt: pair.generatedAt + 5 }, metaFor(pair, { uploadedAt: NOW - 300 }), NOW), null],
  ])("%s", (_label, run, want) => {
    expect(run()).toBe(want);
  });
});
