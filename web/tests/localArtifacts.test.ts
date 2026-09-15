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
});
