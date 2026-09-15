// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createLiveArtifacts, parseLiveOrigin } from "../dev/liveArtifacts";

const ORIGIN = "https://parkcast.example.workers.dev";

function fakeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    end(body?: Uint8Array | string) { this.body = body; },
  };
}

function setup(o: { refreshMs?: number; budgetPerHour?: number } = {}) {
  let clock = 1_000_000;
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3])));
  const mw = createLiveArtifacts({ origin: ORIGIN, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, ...o });
  const hit = async (url: string, method = "GET") => {
    const res = fakeRes();
    const next = vi.fn();
    await mw({ url, method }, res, next);
    return { res, next };
  };
  return { fetchImpl, hit, advance: (ms: number) => { clock += ms; } };
}

/** Like `setup`, but lets the caller control what `fetchImpl` does. */
function setupWithFetch(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  o: { refreshMs?: number; budgetPerHour?: number } = {},
) {
  let clock = 1_000_000;
  const fetchMock = vi.fn(fetchImpl);
  const mw = createLiveArtifacts({ origin: ORIGIN, fetchImpl: fetchMock as unknown as typeof fetch, now: () => clock, ...o });
  const hit = async (url: string, method = "GET") => {
    const res = fakeRes();
    const next = vi.fn();
    await mw({ url, method }, res, next);
    return { res, next };
  };
  return { fetchImpl: fetchMock, hit, advance: (ms: number) => { clock += ms; } };
}

describe("live artifacts middleware", () => {
  it("turns ten thousand local requests into at most two upstream requests", async () => {
    const { fetchImpl, hit } = setup();
    for (let i = 0; i < 5_000; i++) {
      await hit("/artifacts/grid.bin");
      await hit("/artifacts/lots.json?t=1");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves the copy with its type and nothing cached by the browser", async () => {
    const { hit } = setup();
    const { res } = await hit("/artifacts/lots.json");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("forwards no browser headers and refuses upstream redirects", async () => {
    const { fetchImpl, hit } = setup();
    await hit("/artifacts/grid.bin");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/artifacts/grid.bin`);
    expect(init).toEqual({ redirect: "error", headers: {} });
  });

  it("refuses anything but GET and HEAD, and ignores other paths", async () => {
    const { fetchImpl, hit } = setup();
    expect((await hit("/artifacts/latest", "PUT")).next).toHaveBeenCalled();
    const put = await hit("/artifacts/grid.bin", "PUT");
    expect(put.res.statusCode).toBe(405);
    expect((await hit("/src/main.tsx")).next).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops at the hourly budget and serves the last copy", async () => {
    const { fetchImpl, hit, advance } = setup({ refreshMs: 0, budgetPerHour: 5 });
    for (let i = 0; i < 100; i++) expect((await hit("/artifacts/grid.bin")).res.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    advance(3_600_000);
    await hit("/artifacts/grid.bin");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("answers 429 when the budget is spent before any copy exists", async () => {
    const { hit } = setup({ budgetPerHour: 0 });
    expect((await hit("/artifacts/grid.bin")).res.statusCode).toBe(429);
  });

  it("answers 503 and serves no copy when the upstream response is not ok and none exists yet", async () => {
    const { fetchImpl, hit } = setupWithFetch(async () => new Response("nope", { status: 500 }));
    const { res } = await hit("/artifacts/grid.bin");
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toBeInstanceOf(Uint8Array);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("answers 503 without throwing when the upstream fetch rejects and no copy exists yet", async () => {
    const { hit } = setupWithFetch(async () => {
      throw new Error("offline");
    });
    // If the middleware let the rejection propagate instead of resolving, this
    // `await` would throw and fail the test before reaching the assertion.
    const { res } = await hit("/artifacts/grid.bin");
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toBeInstanceOf(Uint8Array);
  });

  it("keeps serving the last good copy when a later refresh fails", async () => {
    const goodBytes = new Uint8Array([9, 9, 9]);
    let call = 0;
    const { fetchImpl, hit } = setupWithFetch(async () => {
      call++;
      return call === 1 ? new Response(goodBytes) : new Response("nope", { status: 500 });
    }, { refreshMs: 0 });

    const first = await hit("/artifacts/grid.bin");
    expect(first.res.statusCode).toBe(200);
    expect(first.res.body).toEqual(goodBytes);

    const second = await hit("/artifacts/grid.bin");
    expect(second.res.statusCode).toBe(200);
    expect(second.res.body).toEqual(goodBytes);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("answers a successful HEAD with the right type and no body", async () => {
    const { hit } = setup();
    const { res } = await hit("/artifacts/grid.bin", "HEAD");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.body).toBeUndefined();
  });

  it.each(["http://parkcast.example.workers.dev", `${ORIGIN}/path`, `${ORIGIN}/?q=1`, "not a url"])(
    "rejects live origin %s",
    (raw) => expect(() => parseLiveOrigin(raw)).toThrow(),
  );
});
