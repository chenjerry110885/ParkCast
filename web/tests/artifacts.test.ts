import { describe, expect, it } from "vitest";
import { HEADER_SIZE, UNKNOWN, parseGrid, probabilityAt } from "../src/artifacts";

/** Build a grid the same way the Python encoder does: little-endian, no padding. */
function makeGrid(nLots: number, nHorizons: number, fill: number[], rosterId = 42): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + nLots * nHorizons);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode("PCG1"), 0);
  dv.setUint8(4, 1);
  dv.setUint32(5, 1788675094, true);
  dv.setUint32(9, 1788674880, true);
  dv.setUint16(13, nLots, true);
  dv.setUint8(15, nHorizons);
  dv.setUint8(16, 5);
  dv.setUint32(17, rosterId, true);
  new Uint8Array(buf).set(fill, HEADER_SIZE);
  return buf;
}

describe("parseGrid", () => {
  it("reads the header little-endian, matching the Python encoder", () => {
    const g = parseGrid(makeGrid(2, 3, [100, 90, 80, 0, 50, UNKNOWN]));
    expect(g.magic).toBe("PCG1");
    expect(g.nLots).toBe(2);
    expect(g.nHorizons).toBe(3);
    expect(g.stepMin).toBe(5);
    expect(g.rosterId).toBe(42);
    expect(g.cells.length).toBe(6);
  });

  it("rejects a file whose magic is wrong", () => {
    const buf = makeGrid(1, 1, [50]);
    new Uint8Array(buf).set(new TextEncoder().encode("XXXX"), 0);
    expect(() => parseGrid(buf)).toThrow();
  });

  it("rejects a body whose length disagrees with the header", () => {
    const buf = makeGrid(2, 3, [1, 2, 3, 4, 5, 6]).slice(0, HEADER_SIZE + 5);
    expect(() => parseGrid(buf)).toThrow();
  });

  it("keeps generatedAt and baseDataTs distinct", () => {
    const g = parseGrid(makeGrid(1, 1, [50]));
    expect(g.generatedAt).not.toBe(g.baseDataTs);
    expect(g.generatedAt).toBeGreaterThan(g.baseDataTs);
  });
});

describe("probabilityAt", () => {
  it("is row-major: row i is lot i", () => {
    const g = parseGrid(makeGrid(2, 3, [100, 90, 80, 10, 20, 30]));
    expect(probabilityAt(g, 0, 5)).toBe(1.0);
    expect(probabilityAt(g, 1, 5)).toBe(0.1);
  });

  it("indexes horizons by minutes, not by slot number", () => {
    const g = parseGrid(makeGrid(1, 3, [100, 90, 80]));
    expect(probabilityAt(g, 0, 5)).toBe(1.0);
    expect(probabilityAt(g, 0, 10)).toBe(0.9);
    expect(probabilityAt(g, 0, 15)).toBe(0.8);
  });

  it("returns null for UNKNOWN, never 0", () => {
    const g = parseGrid(makeGrid(1, 1, [UNKNOWN]));
    expect(probabilityAt(g, 0, 5)).toBeNull();
  });

  it("distinguishes UNKNOWN from a genuine zero", () => {
    const g = parseGrid(makeGrid(2, 1, [0, UNKNOWN]));
    expect(probabilityAt(g, 0, 5)).toBe(0);
    expect(probabilityAt(g, 1, 5)).toBeNull();
  });

  it("clamps an out-of-range horizon to the nearest available one", () => {
    const g = parseGrid(makeGrid(1, 3, [100, 90, 80]));
    expect(probabilityAt(g, 0, 1)).toBe(1.0);
    expect(probabilityAt(g, 0, 999)).toBe(0.8);
  });
});
