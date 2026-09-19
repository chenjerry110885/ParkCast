/**
 * The list's reorder animation, and the two things it must not do.
 *
 * FLIP is the right effect for a re-ranked list -- a card that moves should be
 * seen moving -- but the first version replayed it after *every* commit and
 * measured against the viewport. Hovering a card re-renders the list (the map's
 * hover halo is driven from up there), so on a desktop a mouse merely crossing
 * the list, or a scroll wheel turning under it, made every card slide: the
 * "correction" was faithfully playing back the scroll distance.
 *
 * jsdom lays nothing out, so the geometry is supplied: `getBoundingClientRect`
 * answers from a table keyed by each card's `data-lot-id`, which is what lets a
 * scroll (every card moves, the order does not) be told apart from a reorder
 * (the cards swap places) at all.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LotList } from "../src/components/LotList";
import type { Ranked } from "../src/rank";
import type { Lot } from "../src/types";

const BASE = 1788677280;
const lot = (id: string): Lot => ({ i: 0, id, n: `車場 ${id}`, a: "信義區", y: 25.03, x: 121.56, c: 400, t: "民營停車場", p: { k: "exact", lo: 60, hi: 60 }, f: 38 });
const row = (id: string): Ranked => ({ lot: lot(id), id, index: 0, probability: 0.86, hourly: 60, perEntry: null, priceKnown: true, meters: 320, walkMin: 4, cost: 100 });
// An empty `supportById` is what an unfetched `week.bin` looks like: every card
// reads 0, which honestly says there is no history behind this hour yet. This
// file is about the reorder animation, so that is all it needs.
const props = { lang: "en" as const, baseDataTs: BASE, ageMin: 4, arrivalTs: BASE + 22 * 60, horizonFromReadingMin: 22, supportById: new Map<string, number>(), fromHistory: false, bestId: null, onSelect: vi.fn() };

const A = row("A");
const B = row("B");

/** Card top edges in the viewport, by lot id. The `<ol>` itself stays at 0. */
const tops = new Map<string, number>();
let animate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Motion on: `flipMove` is a no-op under prefers-reduced-motion, which would
  // make every assertion below pass for the wrong reason.
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  animate = vi.fn();
  // jsdom has no Web Animations API; `flipMove` checks for one and steps aside.
  (Element.prototype as unknown as { animate: unknown }).animate = animate;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = tops.get((this as HTMLElement).dataset?.["lotId"] ?? "") ?? 0;
    return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
  tops.clear();
});

describe("LotList reordering", () => {
  it("does not animate when the order is unchanged, however far the list has scrolled", () => {
    tops.set("A", 100);
    tops.set("B", 300);
    const { rerender } = render(<LotList rows={[A, B]} {...props} selectedId={null} />);

    // A scroll, then a re-render for an unrelated reason (a card was selected).
    // Every card is somewhere new; none of them moved relative to the others.
    tops.set("A", -200);
    tops.set("B", 0);
    rerender(<LotList rows={[{ ...A }, { ...B }]} {...props} selectedId="A" />);

    expect(animate).not.toHaveBeenCalled();
  });

  it("animates a card that genuinely changed place in the ranking", () => {
    tops.set("A", 100);
    tops.set("B", 300);
    const { rerender } = render(<LotList rows={[A, B]} {...props} selectedId={null} />);

    tops.set("A", 300);
    tops.set("B", 100);
    rerender(<LotList rows={[B, A]} {...props} selectedId={null} />);

    expect(animate).toHaveBeenCalled();
    // Played from where the card used to be, 200 px away -- not from the scroll
    // offset, and not from zero.
    const frames = animate.mock.calls[0]?.[0] as Array<{ transform: string }>;
    expect(frames[0]?.transform).toMatch(/translate\(0px, -?200px\)/);
  });
});

/**
 * Two lists on one page.
 *
 * The nearby expander opens a second `<ol>` of the same component below the
 * ranked head (`App`), which is only safe if the two can be told apart -- by a
 * screen reader, which otherwise announces "list, 44 items" under another
 * unnamed list, and by a test, which otherwise finds `lot-list` twice and every
 * existing assertion about "the list" becomes a question about which one.
 */
describe("LotList as the second list on a page", () => {
  it("keeps the ranked head's own handle and stays unnamed by default", () => {
    render(<LotList rows={[A, B]} {...props} selectedId={null} />);
    const list = screen.getByTestId("lot-list");
    // Unnamed on purpose: the head sits under the `<h2>` that names it, and a
    // second name beside that one would be read out twice.
    expect(list).not.toHaveAttribute("aria-label");
  });

  it("takes its own handle and its own name when asked for one", () => {
    render(
      <LotList rows={[A, B]} {...props} selectedId={null} label="More car parks nearby" testId="nearby-list" />,
    );
    expect(screen.queryByTestId("lot-list")).toBeNull();
    expect(screen.getByRole("list", { name: "More car parks nearby" })).toBe(
      screen.getByTestId("nearby-list"),
    );
  });
});

/**
 * The expander's own geometry, pinned where it is written.
 *
 * jsdom lays nothing out, so this asserts the rule rather than the rendered
 * box; the measurement that decides whether it is honoured is a real browser at
 * 375 px and on the desktop panel -- see the report. Same bargain, and the same
 * 44 px floor, as `.fchip` and `.pchip`.
 */
describe("the expander's stylesheet", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles", "components.css"),
    "utf8",
  );

  it("gives the control a 44 px tap target", () => {
    const rule = css.match(/\.nearby-toggle\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/min-height:\s*44px/);
  });

  it("turns the caret over from aria-expanded, not from a class", () => {
    // The same rule `.fchip` follows: the look is keyed on the state a screen
    // reader is told, so the two cannot drift into a control that points one
    // way and reads the other.
    expect(css).toMatch(/\.nearby-toggle\[aria-expanded="true"\]::after\s*\{/);
  });

  it("animates nothing at rest -- only the press, the hover and the caret", () => {
    const rule = css.match(/\.nearby-toggle\s*\{([^}]*)\}/)?.[1] ?? "";
    // A transition fires on a change and stops; an `animation` would run
    // forever under a finger that never touched it. `motion.css` zeroes the
    // durations under `prefers-reduced-motion`.
    expect(rule).not.toMatch(/animation/);
    expect(rule).toMatch(/transition:/);
  });
});
