import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEADER_SIZE,
  UNKNOWN,
  artifactsBase,
  loadArtifacts,
  parseGrid,
  probabilityAt,
} from "../src/artifacts";
import type { Lot, LotsDoc } from "../src/types";

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

/**
 * The join between the deployment base and the artifact directory.
 *
 * `BASE_URL` is a URL prefix, not a path, and the difference only shows when it
 * is absolute -- which is exactly the case dev never exercises and a CDN deploy
 * always does.
 */
describe("artifactsBase", () => {
  it("joins a root base without doubling the separator", () => {
    expect(artifactsBase("/")).toBe("/artifacts");
  });

  it("joins a sub-path base, for a project site served under a repo name", () => {
    expect(artifactsBase("/ParkCast/")).toBe("/ParkCast/artifacts");
  });

  it("leaves the scheme of an absolute base intact", () => {
    // The bug this replaces collapsed every `//`, making this `https:/cdn...`
    // -- a URL that resolves relative to the page and 404s on every fetch.
    expect(artifactsBase("https://cdn.example/")).toBe("https://cdn.example/artifacts");
    expect(artifactsBase("https://cdn.example/parkcast/")).toBe(
      "https://cdn.example/parkcast/artifacts",
    );
  });

  it("tolerates a base that does not end in a slash", () => {
    expect(artifactsBase("https://cdn.example")).toBe("https://cdn.example/artifacts");
  });
});

/**
 * A row whose coordinates are missing.
 *
 * Nothing in the shipped feed has one, so this is robustness rather than a
 * repair -- but the failure is silent and geographic: JSON `null` coerces to 0
 * and puts a Taipei car park in the Gulf of Guinea at the top of every ranking,
 * and `undefined` yields `NaN` metres and a `NaN` sort key, which makes the
 * order of the whole list depend on the order it started in.
 */
describe("fetchLots coordinate validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const lot = (i: number, over: Partial<Lot> = {}): Lot =>
    ({
      i,
      id: `TPE${i}`,
      n: `停車場${i}`,
      a: "中正區",
      y: 25.04,
      x: 121.52,
      c: 40,
      t: "民營停車場",
      p: { k: "exact", lo: 30, hi: 30 },
      ...over,
    }) as Lot;

  /** Load a roster of four lots, `bad` of which is malformed. */
  async function loadWith(bad: Partial<Lot>) {
    const doc = makeLotsDoc(42, {
      n_lots: 4,
      lots: [lot(0), lot(1, bad), lot(2), lot(3)],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.endsWith("grid.bin")
          ? Promise.resolve(bufferResponse(makeGrid(4, 1, [10, 20, 30, 40])))
          : Promise.resolve(jsonResponse(doc)),
      ),
    );
    return loadArtifacts("https://example.test/artifacts");
  }

  it("drops a lot whose latitude is null rather than placing it at 0, 0", async () => {
    const { lots } = await loadWith({ y: null as unknown as number });
    expect(lots.lots.map((l) => l.id)).toEqual(["TPE0", "TPE2", "TPE3"]);
  });

  it("drops a lot whose longitude is missing rather than ranking it on NaN", async () => {
    const { lots } = await loadWith({ x: undefined as unknown as number });
    expect(lots.lots.map((l) => l.id)).toEqual(["TPE0", "TPE2", "TPE3"]);
  });

  it("leaves the survivors carrying their own grid rows, not their new positions", async () => {
    // The whole reason dropping a row is safe: `i` still names the forecast.
    const { lots } = await loadWith({ y: Number.NaN });
    expect(lots.lots.map((l) => l.i)).toEqual([0, 2, 3]);
    // `n_lots` still describes the roster the grid was built against.
    expect(lots.n_lots).toBe(4);
  });

  it("keeps a well-formed roster identical, allocating nothing", async () => {
    const doc = makeLotsDoc(42, { n_lots: 2, lots: [lot(0), lot(1)] });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.endsWith("grid.bin")
          ? Promise.resolve(bufferResponse(makeGrid(2, 1, [10, 20])))
          : Promise.resolve(jsonResponse(doc)),
      ),
    );
    const { lots } = await loadArtifacts("https://example.test/artifacts");
    expect(lots).toBe(doc);
  });

  it("still throws on a truncated download, which is an error and not a bad row", async () => {
    // The length check runs first, on purpose: a file that arrived incomplete
    // and a row we chose to drop must not look the same.
    const doc = makeLotsDoc(42, { n_lots: 3, lots: [lot(0), lot(1)] });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.endsWith("grid.bin")
          ? Promise.resolve(bufferResponse(makeGrid(3, 1, [10, 20, 30])))
          : Promise.resolve(jsonResponse(doc)),
      ),
    );
    await expect(loadArtifacts("https://example.test/artifacts")).rejects.toThrow(/n_lots/);
  });
});
