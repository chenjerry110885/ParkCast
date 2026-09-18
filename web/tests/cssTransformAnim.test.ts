import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

// Both reported bugs came from one collision: a positioning `transform` on an
// element's own rule, permanently replaced by a filled `animation` whose
// keyframes also set `transform`. A fix therefore has two halves and needs both
// -- the declaration in `components.css`, and the keyframe *end state* in
// `motion.css` that the fill-mode holds the element at -- so both are asserted
// here, against both files. Pinning only the declaration leaves the bug one
// keyframe edit away: `shine` ending at `translateX(0%)` parks the band over
// the badge again, now held there by the very `forwards` that fixed it.
//
// What this cannot see: whether the result *looks* right. jsdom loads no
// stylesheet, runs no animation and lays nothing out, so every assertion below
// is on CSS as text. The end states are checked against a bound derived from
// the geometry (see each test), not against the exact values in the file --
// a duration, an easing or a tuned percentage is free to change without
// failing here, which is the point. The visual check is a real browser at
// 375 px and desktop width, in light and dark -- see the report.
const componentsCss = readFileSync(join(WEB, "src", "styles", "components.css"), "utf8");
const motionCss = readFileSync(join(WEB, "src", "styles", "motion.css"), "utf8");

function ruleIn(css: string, file: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found in ${file}: ${selector}`);
  return match[1]!;
}

const rule = (selector: string) => ruleIn(componentsCss, "components.css", selector);
const motionRule = (selector: string) => ruleIn(motionCss, "motion.css", selector);

/** The body of `@keyframes <name>`, brace-matched so reformatting cannot break it. */
function keyframes(name: string): string {
  const at = motionCss.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  if (at < 0) throw new Error(`@keyframes not found in motion.css: ${name}`);
  const open = motionCss.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < motionCss.length; i += 1) {
    if (motionCss[i] === "{") depth += 1;
    else if (motionCss[i] === "}" && (depth -= 1) === 0) return motionCss.slice(open + 1, i);
  }
  throw new Error(`unterminated @keyframes: ${name}`);
}

/** The `transform` an animation leaves the element at, or `null` if it sets none. */
function endTransform(name: string): string | null {
  const body = keyframes(name);
  const step = body.match(/(?:\bto\b|100%)\s*\{([^}]*)\}/);
  if (!step) throw new Error(`@keyframes ${name} has no end step`);
  return step[1]!.match(/transform\s*:\s*([^;}]+)/)?.[1]?.trim() ?? null;
}

describe(".map-hint centring", () => {
  it("centres without `transform`, so `.anim-slide-down`'s keyframes can't uncentre it", () => {
    const body = rule(".map-hint");
    expect(body).not.toMatch(/transform\s*:/);
    // Auto margins against a pinned inset are what actually centre it now.
    expect(body).toMatch(/inset-inline\s*:\s*0/);
    expect(body).toMatch(/margin\s*:\s*0\s+auto/);
  });

  it("ends its entrance at the identity, where layout already put it", () => {
    // The other half. `.anim-slide-down` is filled, so whatever `slide-down`
    // ends at is where the hint stays -- and the hint's own rule now sets no
    // transform to argue with it. Any end state but the identity is therefore
    // a permanent offset from the centre the auto margins computed: exactly
    // the reported bug, reached from the keyframe side instead.
    expect(motionRule(".anim-slide-down")).toMatch(/animation\s*:[^;]*\bslide-down\b[^;]*\bboth\b/);
    expect(endTransform("slide-down")).toBe("none");
  });
});

describe(".pill--best.anim-shine::after sweep", () => {
  it("fills forwards, so the sweep is not left mid-pill, and never loops", () => {
    const body = rule(".pill--best.anim-shine::after");
    expect(body).toMatch(/animation\s*:[^;]*\bshine\b/);
    // Without a fill the band reverts to its resting position -- the badge's
    // left 40% -- the instant the single iteration ends. The duration and the
    // easing in this shorthand are deliberately not pinned.
    expect(body).toMatch(/animation\s*:[^;]*\bforwards\b/);
    // Looping would breach "nothing animates at rest".
    expect(body).not.toMatch(/infinite/);
  });

  it("ends with the band clear of the pill it is clipped by", () => {
    // The band is `width: 40%` of the pill and starts at `left: 0`, so a
    // `translateX(P%)` -- P being a percentage of the *band's* own width --
    // puts its bright centre at (0.4·P + 20)% across the pill. Clear of the
    // right edge therefore means P >= 200. This is the geometry, not the
    // current number: 220% passes, and so would any other honest value. What
    // fails is parking the band back over the badge (P = 0, the report) or
    // stopping it half way (P = 100, centre still at 60% of the pill).
    const end = endTransform("shine");
    const percent = Number(end?.match(/translateX\(\s*(-?[\d.]+)%\s*\)/)?.[1]);
    expect(percent).toBeGreaterThanOrEqual(200);
    expect(rule(".pill")).toMatch(/overflow\s*:\s*hidden/);
  });
});

describe(".lot-card's hover lift and press", () => {
  it("survives `.anim-rise`, which no longer occupies `transform`", () => {
    // The third instance of the same collision, and the one 4dfdc14's audit
    // missed by reasoning about resting states only: `transform: none` does
    // match a card's resting state, but a *filled* animation holds it there at
    // the animation origin, above `:hover` and `:active`. Both rules were dead
    // -- verified in a browser rather than argued: a real card whose `rise` had
    // finished stayed at matrix(1,0,0,1,0,0) under a rule of the same weight as
    // the hover rule, while an identical card with its animation cancelled took
    // matrix(1,0,0,1,0,-2).
    expect(rule(".lot-card:hover")).toMatch(/transform\s*:/);
    expect(rule(".lot-card:active")).toMatch(/transform\s*:/);
    expect(motionRule(".anim-rise")).toMatch(/animation\s*:[^;]*\brise\b[^;]*\bboth\b/);
    // `translate` composes with `transform` rather than replacing it, so the
    // entrance can move the card and the affordance can still answer a finger.
    expect(keyframes("rise")).not.toMatch(/transform\s*:/);
    expect(keyframes("rise")).toMatch(/translate\s*:/);
  });
});
