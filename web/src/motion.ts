/**
 * The one place that reads `prefers-reduced-motion`.
 *
 * Every animated thing in this app -- the FLIP-moved list, the sheet drag, a
 * JS-driven counter -- funnels through `tween` or `flipMove` rather than
 * checking the media query itself, so the app can never end up with one
 * component honouring reduced motion and another one still sliding. The
 * duration numbers below mirror `--dur-*` in `styles/motion.css` exactly
 * (same names, same milliseconds): change one, change the other.
 *
 * `tween` and `flipMove` take an optional dependency bag (`raf`/`cancelRaf`/
 * `now`) so tests can drive them with a fake clock instead of waiting on
 * real animation frames -- production code never passes it and gets the
 * real `window`/`performance` underneath.
 */

/** Mirrors the `--dur-*` custom properties in `styles/motion.css`. Keep in sync. */
export const DURATION = { fast: 160, base: 260, slow: 400, sheet: 360 } as const;

/** Whether the user asked the OS for less motion. False wherever the query can't be asked (SSR, old browsers). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Ease-out cubic: fast start, settles into the landing rather than snapping to it. */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

interface TweenDeps {
  raf: (cb: (now: number) => void) => number;
  cancelRaf: (id: number) => void;
  now: () => number;
}

const browserDeps = (): TweenDeps => ({
  raf: (cb) => window.requestAnimationFrame(cb),
  cancelRaf: (id) => window.cancelAnimationFrame(id),
  now: () => performance.now(),
});

/**
 * Drive `onFrame` from `from` to `to` over `durationMs`, easing out; ends
 * exactly on `to` (never left short by a rounding frame). Returns a cancel
 * function. Under reduced motion, or a non-positive duration, skips straight
 * to the end value -- there is no partial frame to interrupt, so cancelling
 * that case is a no-op.
 */
export function tween(
  from: number, to: number, durationMs: number, onFrame: (value: number) => void, deps?: TweenDeps,
): () => void {
  if (durationMs <= 0 || prefersReducedMotion() || typeof window === "undefined") {
    onFrame(to);
    return () => {};
  }
  const d = deps ?? browserDeps();
  const start = d.now();
  let id = 0;
  let cancelled = false;
  const frame = () => {
    if (cancelled) return;
    const t = Math.min(1, (d.now() - start) / durationMs);
    onFrame(t >= 1 ? to : from + (to - from) * easeOutCubic(t));
    if (t < 1) id = d.raf(frame);
  };
  id = d.raf(frame);
  return () => { cancelled = true; d.cancelRaf(id); };
}

/** Snapshot each element's current box, keyed however the caller identifies it (a lot id, say). */
export function measureRects(entries: Iterable<[string, Element]>): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>();
  for (const [key, el] of entries) out.set(key, el.getBoundingClientRect());
  return out;
}

/**
 * FLIP: play an element from where it was (`previous`, measured before the
 * reorder) to where it now sits, so a re-ranked row glides into its new slot
 * instead of teleporting. A no-op when there's nothing to compare against
 * (`previous` undefined -- first render), when the move is sub-pixel, when
 * `Element.animate` isn't available, or under reduced motion.
 */
/** The two fields `flipMove` reads. A `DOMRect` satisfies it; so does a rect a
 *  caller has rebased into another coordinate space (see `LotList`). */
export interface Corner {
  left: number;
  top: number;
}

export function flipMove(el: Element, previous: Corner | undefined, durationMs: number): void {
  if (previous === undefined || prefersReducedMotion()) return;
  const animate = (el as Element & { animate?: Element["animate"] }).animate;
  if (typeof animate !== "function") return;
  const now = el.getBoundingClientRect();
  const dx = previous.left - now.left;
  const dy = previous.top - now.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  animate.call(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
    duration: durationMs, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  });
}
