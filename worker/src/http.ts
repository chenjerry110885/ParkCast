/** Headers on every response the Worker generates; `_headers` does not reach these. */
const SECURITY: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export const TEXT: Readonly<Record<string, string>> = { "Content-Type": "text/plain; charset=utf-8" };

export function respond(status: number, body: BodyInit | null, headers: Record<string, string> = {}): Response {
  // SECURITY is spread last so no caller can weaken it.
  return new Response(body, { status, headers: { "Cache-Control": "no-store", ...headers, ...SECURITY } });
}

export const notFound = (): Response => respond(404, "Not found", TEXT);
