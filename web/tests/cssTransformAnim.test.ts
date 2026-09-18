import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

// jsdom does not run CSS animations or lay elements out, so nothing here can
// see the two visual bugs directly (a frozen shine band, an off-centre map
// hint). These are text-level regression guards against the specific
// collision that caused both: a positioning `transform` on the element's own
// rule getting permanently overwritten by an `animation` whose keyframes
// also touch `transform` (see components.css's `.map-hint` and
// `.pill--best.anim-shine::after` comments, and motion.css's `slide-down`
// and `shine` keyframes). A real check still requires eyeballing the dev
// server at 375px and desktop width, in light and dark -- see the report.
const componentsCss = readFileSync(join(WEB, "src", "styles", "components.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = componentsCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found in components.css: ${selector}`);
  return match[1]!;
}

describe(".map-hint centring", () => {
  it("centres without `transform`, so `.anim-slide-down`'s keyframes (which end at `transform: none`) can't uncentre it", () => {
    const body = rule(".map-hint");
    expect(body).not.toMatch(/transform\s*:/);
    // Auto margins against a pinned inset are what actually centre it now.
    expect(body).toMatch(/inset-inline\s*:\s*0/);
    expect(body).toMatch(/margin\s*:\s*0\s+auto/);
  });
});

describe(".pill--best.anim-shine::after sweep", () => {
  it("ends `forwards`, off past the pill's clipped edge, instead of reverting to its resting (visible) position", () => {
    const body = rule(".pill--best.anim-shine::after");
    expect(body).toMatch(/animation\s*:\s*shine\s+800ms\s+var\(--ease-out\)\s+1\s+forwards\s*;/);
    // Looping would breach "nothing animates at rest".
    expect(body).not.toMatch(/infinite/);
  });
});
