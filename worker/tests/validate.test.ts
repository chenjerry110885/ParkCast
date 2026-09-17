import { describe, expect, it } from "vitest";
import {
  checkOrder,
  checkWeekRoster,
  parseGridHeader,
  parseWeekHeader,
  validatePair,
  validateWeek,
} from "../src/validate";
import { makePair, makeWeek, metaFor } from "./fakes";

const NOW = 1_789_352_400;
const enc = new TextEncoder();

function mutateLots(lots: Uint8Array, change: (doc: any) => void): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(lots));
  change(doc);
  return enc.encode(JSON.stringify(doc));
}

/** A `week.bin` built field-by-field, independent of `makeWeek`'s "always
 * well-formed" fixture -- so a single mutated field can be tested in
 * isolation, with the body re-sized to match whatever bucket count/lot count
 * is under test. Without that, a wrong-nBuckets fixture built by slicing a
 * good blob would *also* fail the body-length check, and the test would stay
 * green even if the nBuckets check itself were deleted. */
function buildWeek(o: {
  magic?: [number, number, number, number];
  version?: number;
  builtTs?: number;
  nLots?: number;
  nBuckets?: number;
  bucketMin?: number;
  rosterId?: number;
  bodyLength?: number;
}): Uint8Array {
  const nLots = o.nLots ?? 3;
  const nBuckets = o.nBuckets ?? 336;
  const bodyLength = o.bodyLength ?? nLots * nBuckets * 2;
  const week = new Uint8Array(18 + bodyLength);
  const dv = new DataView(week.buffer);
  week.set(o.magic ?? [0x50, 0x43, 0x57, 0x31], 0); // "PCW1"
  dv.setUint8(4, o.version ?? 1);
  dv.setUint32(5, o.builtTs ?? NOW - 3600, true);
  dv.setUint16(9, nLots, true);
  dv.setUint16(11, nBuckets, true);
  dv.setUint8(13, o.bucketMin ?? 30);
  dv.setUint32(14, o.rosterId ?? 42, true);
  return week;
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

describe("validateWeek", () => {
  it("accepts a well-formed week blob", () => {
    const week = makeWeek({ builtTs: NOW - 3600 });
    expect(validateWeek(week.week).ok).toBe(true);
  });

  it.each<[string, () => Uint8Array]>([
    ["bad magic", () => buildWeek({ magic: [0x51, 0x43, 0x57, 0x31] })],
    ["unknown schema version", () => buildWeek({ version: 2 })],
    ["truncated body", () => buildWeek({ bodyLength: 3 * 336 * 2 - 1 })],
    ["oversized body", () => buildWeek({ bodyLength: 3 * 336 * 2 + 1 })],
    // Body re-sized to match the wrong bucket count/size, so only the field
    // under test -- never the body-length check -- can catch it.
    ["wrong bucket count", () => buildWeek({ nBuckets: 300, bodyLength: 3 * 300 * 2 })],
    ["wrong bucket size in minutes", () => buildWeek({ bucketMin: 60 })],
    ["zero lots", () => buildWeek({ nLots: 0, bodyLength: 0 })],
  ])("rejects %s", (_label, build) => {
    expect(validateWeek(build()).ok).toBe(false);
  });

  it("round-trips the header fields validateWeek confirms", () => {
    const week = makeWeek({ builtTs: NOW - 3600, nLots: 5, rosterId: 99 });
    const result = validateWeek(week.week);
    expect(result.ok).toBe(true);
    expect(result.ok && result.header).toEqual({
      version: 1, builtTs: NOW - 3600, nLots: 5, nBuckets: 336, bucketMin: 30, rosterId: 99,
    });
  });
});

describe("checkWeekRoster", () => {
  const week = makeWeek({ builtTs: NOW - 3600, rosterId: 42 });
  const header = parseWeekHeader(week.week)!;

  it("accepts a roster that matches what is stored", () => {
    expect(checkWeekRoster(header, 42)).toBeNull();
  });

  it("rejects a roster that disagrees with what is stored", () => {
    expect(checkWeekRoster(header, 7)).toBe("roster-mismatch");
  });

  it("rejects when no roster is stored yet", () => {
    expect(checkWeekRoster(header, null)).toBe("roster-mismatch");
  });
});
