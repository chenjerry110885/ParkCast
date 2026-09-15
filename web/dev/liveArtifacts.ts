/**
 * Dev only: serve the two forecast files from the LIVE site through one shared
 * copy, so local testing uses today's data but cannot use up the live site's
 * daily Worker limit, even if code under edit loops (spec §7, §6.1 T14).
 *
 * Deliberately free of Node types, so the app's tests can import it.
 */
export interface DevRequest { url?: string; method?: string }
export interface DevResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: Uint8Array | string): unknown;
}
export type Next = () => void;

export const ARTIFACT_TYPES: ReadonlyMap<string, string> = new Map([
  ["/artifacts/grid.bin", "application/octet-stream"],
  ["/artifacts/lots.json", "application/json; charset=utf-8"],
]);

export interface LiveOptions {
  origin: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshMs?: number;
  budgetPerHour?: number;
}

export function parseLiveOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("PARKCAST_LIVE_ORIGIN must be an https origin with no path, e.g. https://parkcast.<name>.workers.dev");
  }
  return url.origin;
}

export function createLiveArtifacts(options: LiveOptions) {
  const origin = parseLiveOrigin(options.origin);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? 60_000;
  const budget = options.budgetPerHour ?? 120;
  const copies = new Map<string, { body: Uint8Array; at: number }>();
  const inflight = new Map<string, Promise<void>>();
  let windowStart = now();
  let used = 0;

  async function refresh(path: string): Promise<void> {
    if (now() - windowStart >= 3_600_000) {
      windowStart = now();
      used = 0;
    }
    if (used >= budget) return;
    used++;
    const upstream = await fetchImpl(origin + path, { redirect: "error", headers: {} });
    if (!upstream.ok) return;
    copies.set(path, { body: new Uint8Array(await upstream.arrayBuffer()), at: now() });
  }

  return async function liveArtifacts(req: DevRequest, res: DevResponse, next: Next): Promise<void> {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const type = ARTIFACT_TYPES.get(path);
    if (type === undefined) return next();
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end();
      return;
    }
    const copy = copies.get(path);
    if (copy === undefined || now() - copy.at >= refreshMs) {
      let pending = inflight.get(path);
      if (pending === undefined) {
        pending = refresh(path)
          .catch(() => undefined)
          .finally(() => inflight.delete(path));
        inflight.set(path, pending);
      }
      await pending;
    }
    const served = copies.get(path);
    if (served === undefined) {
      res.statusCode = used >= budget ? 429 : 503;
      res.end("live forecast unavailable");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    res.end(req.method === "HEAD" ? undefined : served.body);
  };
}
