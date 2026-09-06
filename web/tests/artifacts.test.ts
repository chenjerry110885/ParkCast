import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER_SIZE, UNKNOWN, loadArtifacts, parseGrid, probabilityAt } from "../src/artifacts";
import type { LotsDoc } from "../src/types";

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

/** Build a minimal, schema-valid `lots.json` document with a given roster id. */
function makeLotsDoc(rosterId: number, overrides: Partial<LotsDoc> = {}): LotsDoc {
  return {
    v: 1,
    generated_at: 1788675094,
    base_data_ts: 1788674880,
    n_lots: 0,
    roster_id: rosterId,
    lots: [],
    ...overrides,
  };
}

function jsonResponse(doc: LotsDoc): Response {
  return { ok: true, status: 200, json: async () => doc } as unknown as Response;
}

function bufferResponse(buf: ArrayBuffer): Response {
  return { ok: true, status: 200, arrayBuffer: async () => buf } as unknown as Response;
}

describe("loadArtifacts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a matched pair from exactly two fetches when rosterId agrees", async () => {
    const gridBuf = makeGrid(2, 3, [100, 90, 80, 0, 50, UNKNOWN], 42);
    const lotsDoc = makeLotsDoc(42);
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("grid.bin")) return Promise.resolve(bufferResponse(gridBuf));
      if (url.endsWith("lots.json")) return Promise.resolve(jsonResponse(lotsDoc));
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadArtifacts("https://example.test/artifacts");

    expect(result.grid.rosterId).toBe(42);
    expect(result.lots.roster_id).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("on a rosterId mismatch, re-fetches only lots.json (bypassing cache), not grid.bin", async () => {
    const gridBuf = makeGrid(1, 1, [50], 7);
    const staleLots = makeLotsDoc(999);
    const freshLots = makeLotsDoc(7);
    let lotsCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("grid.bin")) return Promise.resolve(bufferResponse(gridBuf));
      if (url.endsWith("lots.json")) {
        lotsCalls += 1;
        return Promise.resolve(jsonResponse(lotsCalls === 1 ? staleLots : freshLots));
      }
      return Promise.reject(new Error(`unexpected url ${url} with init ${JSON.stringify(init)}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadArtifacts("https://example.test/artifacts");

    expect(result.lots.roster_id).toBe(7);
    const gridCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("grid.bin"));
    const lotsFetchCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("lots.json"));
    expect(gridCalls.length).toBe(1);
    expect(lotsFetchCalls.length).toBe(2);
    expect(lotsFetchCalls[1]?.[1]).toMatchObject({ cache: "reload" });
  });

  it("throws rather than returning a mismatched pair when the retry still disagrees", async () => {
    const gridBuf = makeGrid(1, 1, [50], 7);
    const staleLots = makeLotsDoc(999);
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("grid.bin")) return Promise.resolve(bufferResponse(gridBuf));
      if (url.endsWith("lots.json")) return Promise.resolve(jsonResponse(staleLots));
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadArtifacts("https://example.test/artifacts")).rejects.toThrow(/roster mismatch/);
  });

  it("pairs on rosterId, not generatedAt: differing timestamps with matching rosterId need no retry", async () => {
    const gridBuf = makeGrid(1, 1, [50], 42); // generatedAt baked into makeGrid is 1788675094
    const lotsDoc = makeLotsDoc(42, { generated_at: 1_000_000 }); // deliberately different
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("grid.bin")) return Promise.resolve(bufferResponse(gridBuf));
      if (url.endsWith("lots.json")) return Promise.resolve(jsonResponse(lotsDoc));
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadArtifacts("https://example.test/artifacts");

    expect(result.grid.generatedAt).not.toBe(result.lots.generated_at);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a network failure fetching grid.bin instead of yielding a half-loaded state", async () => {
    const lotsDoc = makeLotsDoc(42);
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("grid.bin")) return Promise.reject(new Error("network down"));
      if (url.endsWith("lots.json")) return Promise.resolve(jsonResponse(lotsDoc));
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadArtifacts("https://example.test/artifacts")).rejects.toThrow("network down");
  });

  it("propagates a network failure fetching lots.json instead of yielding a half-loaded state", async () => {
    const gridBuf = makeGrid(1, 1, [50], 42);
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("grid.bin")) return Promise.resolve(bufferResponse(gridBuf));
      if (url.endsWith("lots.json")) return Promise.reject(new Error("network down"));
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadArtifacts("https://example.test/artifacts")).rejects.toThrow("network down");
  });
});
