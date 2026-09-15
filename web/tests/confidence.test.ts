import { describe, expect, it } from "vitest";
import { HIGH_MAX_MIN, MEDIUM_MAX_MIN, confidenceFor } from "../src/confidence";

describe("confidenceFor", () => {
  it("follows the blend's persistence weight: high to 30 min, medium to 75, low beyond", () => {
    expect(confidenceFor(5, true, 0.8)).toBe("high");
    expect(confidenceFor(HIGH_MAX_MIN, true, 0.8)).toBe("high");
    expect(confidenceFor(HIGH_MAX_MIN + 1, true, 0.8)).toBe("medium");
    expect(confidenceFor(MEDIUM_MAX_MIN, true, 0.8)).toBe("medium");
    expect(confidenceFor(MEDIUM_MAX_MIN + 1, true, 0.8)).toBe("low");
    expect(confidenceFor(500, true, 0.8)).toBe("low");
  });

  it("has nothing to say without a forecast or for a lot that is not updating", () => {
    expect(confidenceFor(5, true, null)).toBeNull();
    expect(confidenceFor(5, false, 0.8)).toBeNull();
  });
});
