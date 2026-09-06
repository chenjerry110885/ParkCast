import { describe, expect, it } from "vitest";
import { UNKNOWN_COLOUR, colourFor } from "../src/map/colour";

describe("colourFor", () => {
  it("gives unknown its own colour, not the colour of zero", () => {
    expect(colourFor(null)).toBe(UNKNOWN_COLOUR);
    expect(colourFor(0)).not.toBe(UNKNOWN_COLOUR);
  });

  it("is monotone: a likelier lot never looks worse", () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map((p) => colourFor(p));
    expect(new Set(steps).size).toBe(steps.length);
  });

  it("returns a valid colour for every probability", () => {
    for (let p = 0; p <= 1.0001; p += 0.05) {
      expect(colourFor(Math.min(p, 1))).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
