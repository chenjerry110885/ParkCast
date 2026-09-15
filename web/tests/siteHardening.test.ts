import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(WEB, "public");
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

describe("site hardening", () => {
  it("sends a strict Content-Security-Policy on every static file", () => {
    const headers = read(PUBLIC, "_headers");
    const csp = headers.match(/Content-Security-Policy: (.*)/)?.[1] ?? "";
    for (const directive of [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "worker-src 'self'",
      "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/worker-src[^;]*blob:/);
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toMatch(/^\/sw\.js\r?\n\s+Cache-Control: no-cache/m);
  });

  it("has no inline style or inline script in index.html", () => {
    const html = read(WEB, "index.html");
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).toContain('href="/fallback.css"');
  });

  it("precaches the fallback stylesheet", () => {
    expect(read(PUBLIC, "sw.js")).toContain('"./fallback.css"');
  });

  it("keeps crawlers out of the forecast files", () => {
    expect(read(PUBLIC, "robots.txt")).toMatch(/^Disallow: \/artifacts\/$/m);
  });

  it("ships a bilingual 404 page with no inline style", () => {
    const html = read(PUBLIC, "404.html");
    expect(html).toContain('lang="zh-Hant"');
    expect(html).not.toMatch(/\sstyle=/);
  });
});
