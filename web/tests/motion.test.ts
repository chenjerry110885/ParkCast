import { afterEach, describe, expect, it, vi } from "vitest";
import { easeOutCubic, flipMove, measureRects, prefersReducedMotion, tween } from "../src/motion";

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches, addEventListener() {}, removeEventListener() {} })));
}

afterEach(() => vi.unstubAllGlobals());

describe("prefersReducedMotion", () => {
  it("reads the media query, and is false where matchMedia does not exist", () => {
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    stubReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("tween", () => {
  function fakeClock() {
    let t = 0;
    const frames: Array<(now: number) => void> = [];
    return {
      deps: { raf: (cb: (now: number) => void) => { frames.push(cb); return frames.length; }, cancelRaf: () => {}, now: () => t },
      step(ms: number) { t += ms; const pending = frames.splice(0); for (const cb of pending) cb(t); },
    };
  }

  it("reaches exactly the target and eases out", () => {
    stubReducedMotion(false);
    const clock = fakeClock();
    const seen: number[] = [];
    tween(0, 100, 100, (v) => seen.push(v), clock.deps);
    clock.step(0); clock.step(50); clock.step(50); clock.step(50);
    expect(seen.at(-1)).toBe(100);
    expect(seen[1]).toBeGreaterThan(50); // ease-out: more than half way at half time
  });

  it("jumps straight to the target under reduced motion", () => {
    stubReducedMotion(true);
    const seen: number[] = [];
    tween(0, 100, 100, (v) => seen.push(v));
    expect(seen).toEqual([100]);
  });

  it("can be cancelled", () => {
    stubReducedMotion(false);
    const clock = fakeClock();
    const seen: number[] = [];
    const cancel = tween(0, 100, 100, (v) => seen.push(v), clock.deps);
    clock.step(0); cancel(); clock.step(50);
    expect(seen.length).toBe(1);
  });

  it("maps 0.5 to more than 0.5", () => expect(easeOutCubic(0.5)).toBeGreaterThan(0.5));
});

describe("flip", () => {
  it("measures rects by key and animates a moved element from its old spot", () => {
    stubReducedMotion(false);
    const el = document.createElement("li");
    document.body.appendChild(el);
    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    (el as unknown as { animate: typeof animate }).animate = animate;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 0, top: 100, width: 10, height: 10 } as DOMRect);
    const before = measureRects([["a", el]]);
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 0, top: 40, width: 10, height: 10 } as DOMRect);
    flipMove(el, before.get("a"), 260);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames] = animate.mock.calls[0] as unknown as [Array<{ transform: string }>];
    expect(frames[0]!.transform).toBe("translate(0px, 60px)");
  });

  it("does nothing for an element that did not move, or under reduced motion", () => {
    const el = document.createElement("li");
    const animate = vi.fn();
    (el as unknown as { animate: typeof animate }).animate = animate;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1, height: 1 } as DOMRect);
    stubReducedMotion(false);
    flipMove(el, { left: 0, top: 0 } as DOMRect, 260);
    stubReducedMotion(true);
    flipMove(el, { left: 0, top: 500 } as DOMRect, 260);
    expect(animate).not.toHaveBeenCalled();
  });

  it("does nothing when there is no previous rect, and never measures the element", () => {
    stubReducedMotion(false);
    const el = document.createElement("li");
    const animate = vi.fn();
    (el as unknown as { animate: typeof animate }).animate = animate;
    const getRect = vi.spyOn(el, "getBoundingClientRect");
    flipMove(el, undefined, 260);
    expect(animate).not.toHaveBeenCalled();
    expect(getRect).not.toHaveBeenCalled();
  });

  it("does not throw when the element has no animate function", () => {
    stubReducedMotion(false);
    const el = document.createElement("li");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1, height: 1 } as DOMRect);
    expect(() => flipMove(el, { left: 0, top: 500 } as DOMRect, 260)).not.toThrow();
  });
});
