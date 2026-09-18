/**
 * The half sheet's body scrolls, and `peek`'s does not.
 *
 * Two halves that only work together, so both are asserted here: a stylesheet
 * rule keyed on `data-snap`, and the attribute that rule matches against. jsdom
 * does not load `components.css`, lay anything out, or compute a scrollport --
 * so a test that rendered the sheet and read `overflow` would read the empty
 * string at every snap and pass no matter what the stylesheet said. The rule is
 * therefore read as text, which pins *which states scroll* but can say nothing
 * about whether the result is usable; the measurement that decides that (a
 * 227 px card against 224 px of half-sheet body at 375x812) is in the rule's own
 * comment and was taken in a real browser.
 *
 * What this does catch is the regression that matters: dropping `half` from the
 * selector list, or letting `peek` into it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "../src/layout/BottomSheet";
import { SNAPS } from "../src/layout/sheet";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Comments stripped first: a rule's leading comment is otherwise part of its selector text. */
const componentsCss = readFileSync(join(WEB, "src", "styles", "components.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every rule in `components.css` whose selector list mentions `.sheet__body`. */
function sheetBodyRules(): { selectors: string[]; body: string }[] {
  const rules: { selectors: string[]; body: string }[] = [];
  for (const match of componentsCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim();
    if (!selector.includes(".sheet__body")) continue;
    rules.push({ selectors: selector.split(",").map((s) => s.trim()), body: match[2]! });
  }
  return rules;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe(".sheet__body scrolling", () => {
  it("scrolls at `full` and at `half`, and never at `peek`", () => {
    const rules = sheetBodyRules();
    const scrolls = rules.filter((r) => /overflow-y\s*:\s*auto/.test(r.body));
    expect(scrolls).toHaveLength(1);
    // Exactly these two states, so neither can be dropped silently...
    expect(scrolls[0]!.selectors).toEqual([".sheet--full .sheet__body", '.sheet[data-snap="half"] .sheet__body']);
    // ...and `peek` is not among them: 53 px of body is a hint that a list
    // exists, not a list, and a scrollport there would show an arbitrary slice.
    for (const rule of scrolls) {
      for (const selector of rule.selectors) expect(selector).not.toContain("peek");
    }
    // The default the two override: clipped everywhere else.
    const base = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === ".sheet__body");
    expect(base?.body).toMatch(/overflow\s*:\s*hidden/);
  });

  it("renders the `data-snap` attribute the `half` rule selects on, at every snap", () => {
    // Without this attribute the rule above matches nothing, and the assertion
    // on its selector text would be pinning a rule that cannot fire.
    for (const snap of SNAPS) {
      const { unmount } = render(
        <BottomSheet snap={snap} onSnapChange={vi.fn()} header={<b>h</b>} lang="en">
          body
        </BottomSheet>,
      );
      expect(screen.getByTestId("sheet")).toHaveAttribute("data-snap", snap);
      // `.sheet--full` is the other half of the pair, and only `full` carries it.
      expect(screen.getByTestId("sheet").classList.contains("sheet--full")).toBe(snap === "full");
      unmount();
    }
  });
});
