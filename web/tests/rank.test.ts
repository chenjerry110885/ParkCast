import { describe, expect, it } from "vitest";
import { rankLots } from "../src/rank";

const lot = (id: string, lat: number, p: unknown) =>
  ({ i: 0, id, n: id, a: "中正區", y: lat, x: 121.52, c: 50, t: "民營停車場", p }) as never;

const at = { lat: 25.05, lon: 121.52 };

describe("rankLots", () => {
  it("prefers a likelier space over a marginally closer one", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("far-likely", 25.0505, { k: "exact", lo: 50, hi: 50 }),
             lot("near-full", 25.0501, { k: "exact", lo: 50, hi: 50 })],
      probability: (i) => (i === 0 ? 0.95 : 0.05),
    });
    expect(out[0]!.id).toBe("far-likely");
  });

  it("does not reward a lot for having no price", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("unpriced", 25.05, { k: "unknown" }),
             lot("cheap", 25.05, { k: "exact", lo: 10, hi: 10 })],
      probability: () => 0.9,
    });
    expect(out[0]!.id).toBe("cheap");
  });

  it("marks an unpriced lot so the UI can say so", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("unpriced", 25.05, { k: "unknown" })],
      probability: () => 0.9,
    });
    expect(out[0]!.priceKnown).toBe(false);
    expect(out[0]!.hourly).toBeNull();
  });

  it("uses the midpoint of a price range", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("ranged", 25.05, { k: "range", lo: 20, hi: 40 })],
      probability: () => 0.9,
    });
    expect(out[0]!.hourly).toBe(30);
    expect(out[0]!.priceKnown).toBe(true);
  });

  it("keeps a lot whose probability is unknown, ranked last, not dropped", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("noprob", 25.05, { k: "exact", lo: 10, hi: 10 }),
             lot("known", 25.05, { k: "exact", lo: 10, hi: 10 })],
      probability: (i) => (i === 0 ? null : 0.5),
    });
    expect(out.map((r) => r.id)).toEqual(["known", "noprob"]);
    expect(out[1]!.probability).toBeNull();
  });

  it("exposes the components rather than only a score", () => {
    const out = rankLots({
      destination: at, horizonMin: 15,
      lots: [lot("a", 25.0505, { k: "exact", lo: 50, hi: 50 })],
      probability: () => 0.8,
    });
    expect(out[0]).toMatchObject({
      probability: 0.8, hourly: 50, priceKnown: true,
    });
    expect(out[0]!.walkMin).toBeGreaterThan(0);
    expect(out[0]!.meters).toBeGreaterThan(0);
  });
});
