// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalArtifacts } from "../dev/localArtifacts";

function fakeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    end(body?: Uint8Array | string) { this.body = body; },
  };
}

describe("local artifacts middleware", () => {
  let dir: string;
  const gridBytes = new Uint8Array([7, 8, 9]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parkcast-local-artifacts-"));
    writeFileSync(join(dir, "grid.bin"), gridBytes);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves an existing file with its type and no caching", async () => {
    const mw = createLocalArtifacts(dir);
    const res = fakeRes();
    const next = vi.fn();
    await mw({ url: "/artifacts/grid.bin", method: "GET" }, res, next);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Array.from(res.body as Uint8Array)).toEqual(Array.from(gridBytes));
    expect(next).not.toHaveBeenCalled();
  });

  it("answers a successful HEAD with the right type and no body", async () => {
    const mw = createLocalArtifacts(dir);
    const res = fakeRes();
    const next = vi.fn();
    await mw({ url: "/artifacts/grid.bin", method: "HEAD" }, res, next);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.body).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 404 when the file is missing from the local directory", async () => {
    const mw = createLocalArtifacts(dir);
    const res = fakeRes();
    const next = vi.fn();
    await mw({ url: "/artifacts/lots.json", method: "GET" }, res, next);
    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes an unrelated path to next()", async () => {
    const mw = createLocalArtifacts(dir);
    const res = fakeRes();
    const next = vi.fn();
    await mw({ url: "/other", method: "GET" }, res, next);
    expect(next).toHaveBeenCalled();
  });

  /**
   * The dev loop's fixture for the branch neither the dev roster nor the live
   * site reaches -- and which the live site will be *entirely* made of until
   * the rebuilt collector publishes. See `LocalOptions.stripAmenities`.
   */
  describe("with PARKCAST_DEV_NO_AMENITIES", () => {
    const ROSTER = {
      v: 1,
      roster_id: 4242,
      n_lots: 2,
      lots: [
        { i: 0, id: "TPE0001", n: "甲", m: 40, e: 2 },
        { i: 1, id: "TPE0002", n: "乙", m: 0, e: 0 },
      ],
    };

    beforeEach(() => {
      writeFileSync(join(dir, "lots.json"), JSON.stringify(ROSTER));
    });

    it("serves the roster with both keys gone, including the reported zeroes", async () => {
      const mw = createLocalArtifacts(dir, { stripAmenities: true });
      const res = fakeRes();
      await mw({ url: "/artifacts/lots.json", method: "GET" }, res, vi.fn());
      const doc = JSON.parse(res.body as string) as typeof ROSTER;
      // Absent, not zeroed: a `0` left behind would be the collapse the whole
      // feature refuses, arrived at from the other end.
      for (const lot of doc.lots) {
        expect(lot).not.toHaveProperty("m");
        expect(lot).not.toHaveProperty("e");
      }
      // Everything else is the roster the grid is paired with, untouched.
      expect(doc.roster_id).toBe(ROSTER.roster_id);
      expect(doc.lots.map((l) => l.id)).toEqual(["TPE0001", "TPE0002"]);
      expect(doc.lots[0]!.n).toBe("甲");
      expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    });

    it("leaves the grid alone, and leaves the roster alone when it is off", async () => {
      const stripped = createLocalArtifacts(dir, { stripAmenities: true });
      const gridRes = fakeRes();
      await stripped({ url: "/artifacts/grid.bin", method: "GET" }, gridRes, vi.fn());
      expect(Array.from(gridRes.body as Uint8Array)).toEqual(Array.from(gridBytes));

      const plain = createLocalArtifacts(dir);
      const res = fakeRes();
      await plain({ url: "/artifacts/lots.json", method: "GET" }, res, vi.fn());
      expect(JSON.parse(new TextDecoder().decode(res.body as Uint8Array)).lots[0].m).toBe(40);
    });
  });
});
