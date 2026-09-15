import { describe, expect, it } from "vitest";
import { PROBABILITY_RAMP, UNKNOWN_COLOUR, colourFor } from "../src/map/colour";

describe("colourFor", () => {
  it("gives unknown its own grey, off the ramp and never the colour of zero", () => {
    expect(colourFor(null)).toBe(UNKNOWN_COLOUR);
    expect(colourFor(Number.NaN)).toBe(UNKNOWN_COLOUR);
    expect(colourFor(0)).not.toBe(UNKNOWN_COLOUR);
    expect(PROBABILITY_RAMP.map(([, c]) => c)).not.toContain(UNKNOWN_COLOUR);
  });

  it("hits every stop exactly and is monotone between them", () => {
    for (const [p, hex] of PROBABILITY_RAMP) expect(colourFor(p)).toBe(hex);
    const steps = [0, 0.2, 0.35, 0.5, 0.7, 0.85, 1].map((p) => colourFor(p));
    expect(new Set(steps).size).toBe(steps.length);
  });

  it("runs red to teal, never green: the red-green colour-blind reading stays intact", () => {
    expect(PROBABILITY_RAMP[0]![1]).toBe("#e5484d");
    expect(PROBABILITY_RAMP.at(-1)![1]).toBe("#0e9384");
  });

  it("returns a valid colour for every probability, clamping outside 0..1", () => {
    for (let p = -0.5; p <= 1.5; p += 0.05) expect(colourFor(p)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(colourFor(2)).toBe(colourFor(1));
  });
});
