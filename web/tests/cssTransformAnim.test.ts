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
// the badge again -- and now that the sweep repeats with the pause written into
// those same keyframes, the declaration and the keyframes decide the timing
// between them and neither file can be read alone.
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

/** What `{ ... }` encloses from the first brace at or after `at`, brace-matched. */
function blockAt(css: string, at: number, what: string): string {
  const open = css.indexOf("{", at);
  if (open < 0) throw new Error(`no block for ${what}`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}" && (depth -= 1) === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated block: ${what}`);
}

/** The body of `@keyframes <name>`, brace-matched so reformatting cannot break it. */
function keyframes(name: string): string {
  const at = motionCss.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  if (at < 0) throw new Error(`@keyframes not found in motion.css: ${name}`);
  return blockAt(motionCss, at, `@keyframes ${name}`);
}

/** The body of motion.css's reduced-motion block, so a rule can be read *inside* it. */
function reducedMotion(): string {
  const at = motionCss.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
  if (at < 0) throw new Error("motion.css has no prefers-reduced-motion block");
  return blockAt(motionCss, at, "@media (prefers-reduced-motion: reduce)");
}

/**
 * The steps of `@keyframes <name>` as `[offset %, declarations]`, in order.
 *
 * Offsets, not just the end state, because a repeating animation's *shape* is
 * what says whether it sweeps or strobes: one step shared by several offsets
 * (`16%, to { ... }`) is a hold, and where that hold starts is the whole of the
 * pause. `from`/`to` are spelled as 0 and 100 so the two notations compare.
 */
function keyframeSteps(name: string): Array<[number, string]> {
  const steps: Array<[number, string]> = [];
  for (const step of keyframes(name).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    for (const selector of step[1]!.split(",")) {
      const token = selector.trim().toLowerCase();
      const offset = token === "from" ? 0 : token === "to" ? 100 : Number.parseFloat(token);
      if (Number.isFinite(offset)) steps.push([offset, step[2]!]);
    }
  }
  if (steps.length === 0) throw new Error(`@keyframes ${name} has no steps`);
  return steps.sort((a, b) => a[0] - b[0]);
}

/** The `transform` a step declares, or `null` if it sets none. */
function transformIn(declarations: string): string | null {
  return declarations.match(/transform\s*:\s*([^;}]+)/)?.[1]?.trim() ?? null;
}

/** The `transform` an animation leaves the element at, or `null` if it sets none. */
function endTransform(name: string): string | null {
  const steps = keyframeSteps(name);
  const end = steps[steps.length - 1]!;
  if (end[0] !== 100) throw new Error(`@keyframes ${name} has no end step`);
  return transformIn(end[1]);
}

/** The earliest offset at which the element is already at its end transform. */
function settleOffset(name: string): number {
  const end = endTransform(name);
  const settled = keyframeSteps(name).find(([, declarations]) => transformIn(declarations) === end);
  if (settled === undefined) throw new Error(`@keyframes ${name} never reaches its end transform`);
  return settled[0];
}

/** An `animation` shorthand with its functional values blanked, for scanning. */
function shorthand(declarations: string): string {
  return (declarations.match(/animation\s*:\s*([^;]+)/)?.[1] ?? "").replace(/[\w-]+\([^)]*\)/g, " ");
}

/** The `<time>` values in an `animation` shorthand, in order, in seconds. */
function animationTimes(declarations: string): number[] {
  return [...shorthand(declarations).matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/g)].map(
    ([, value, unit]) => (unit === "ms" ? Number(value) / 1000 : Number(value)),
  );
}

/** The iteration count in an `animation` shorthand: a number, or `Infinity`. */
function iterations(declarations: string): number {
  const text = shorthand(declarations);
  if (/\binfinite\b/.test(text)) return Number.POSITIVE_INFINITY;
  // Whatever is left that is a bare number: the times above all carry units.
  const count = text.match(/(?<![\w.-])(\d*\.?\d+)(?![\w.%-])/);
  return count === null ? 1 : Number(count[1]);
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

/**
 * This block used to assert `not.toMatch(/infinite/)`, on the grounds that a
 * looping highlight breached "nothing animates at rest". The owner overruled
 * that from their own testing -- "what I expected is that the shining animation
 * will continue, not just once" -- and they are right about the badge: a sweep
 * that fires once is over before a driver glancing at the sheet has looked up,
 * which is the opposite of what a "best pick" mark is for.
 *
 * What the old assertion was *protecting* is still real, though, and is not the
 * loop: it is that the band must never be somewhere visible when nothing is
 * happening. So the bound moved rather than being deleted. The sweep still has
 * to end clear of the pill (unchanged below, and now load-bearing for 84% of
 * every cycle rather than for the moment after one iteration), and the repeat
 * has to be a sweep every few seconds rather than a strobe -- which is a claim
 * about the *ratio* of the hold in `shine`'s keyframes to the duration in the
 * declaration, so both files are read to check it.
 */
describe(".pill--best.anim-shine::after sweep", () => {
  it("repeats, and spends most of each cycle holding still", () => {
    const body = rule(".pill--best.anim-shine::after");
    expect(body).toMatch(/animation\s*:[^;]*\bshine\b/);
    // Keeps shining: the reported complaint, and a single iteration fails here.
    expect(iterations(body)).toBeGreaterThan(1);
    const cycle = animationTimes(body)[0];
    expect(cycle).toBeDefined();
    // The pause is in the keyframes, so the cycle splits at the offset where
    // the band is already parked past the pill and stays there.
    const sweep = (cycle! * settleOffset("shine")) / 100;
    const still = cycle! - sweep;
    // Bounds derived from what the badge is for, not the numbers in the file:
    // 800 ms of sweep and 4.2 s of stillness pass, and so would 600 ms and 3 s.
    // What fails is `infinite` bolted onto the previous two-step keyframes --
    // the band would then settle only at 100%, leaving no still time at all,
    // which is the strobe over a busy map this is not allowed to be -- and a
    // sweep slowed until the highlight is always somewhere on the badge.
    expect(sweep).toBeGreaterThan(0.2);
    expect(sweep).toBeLessThanOrEqual(1.2);
    expect(still).toBeGreaterThanOrEqual(2);
  });

  it("is taken away entirely from a reader who asked for less motion", () => {
    // The accessibility half, and the one part of the original rule that does
    // not bend. The blanket declarations in that block do not cover this case
    // on their own: they clamp every animation to a single 0.01 ms iteration,
    // which for an `infinite` one is still an animation that runs -- and, with
    // the fill gone, one that ends by snapping the band back to its resting
    // position over the badge's left 40%. Taking the pseudo-element away
    // answers both, and `forwards` answers the second by itself if this rule is
    // ever lifted, which is why it survives a declaration that no longer needs
    // it while the count says `infinite`.
    expect(ruleIn(reducedMotion(), "the reduced-motion block", ".pill--best.anim-shine::after")).toMatch(
      /display\s*:\s*none/,
    );
    expect(rule(".pill--best.anim-shine::after")).toMatch(/animation\s*:[^;]*\bforwards\b/);
  });

  it("ends with the band clear of the pill it is clipped by", () => {
    // The band is `width: 40%` of the pill and starts at `left: 0`, so a
    // `translateX(P%)` -- P being a percentage of the *band's* own width --
    // puts its bright centre at (0.4·P + 20)% across the pill. Clear of the
    // right edge therefore means P >= 200. This is the geometry, not the
    // current number: 220% passes, and so would any other honest value. What
    // fails is parking the band back over the badge (P = 0, the report) or
    // stopping it half way (P = 100, centre still at 60% of the pill) -- and
    // now for the 84% of every cycle the step above holds it there, not just
    // for the pause after a single iteration.
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
