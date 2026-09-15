import { describe, expect, it } from "vitest";
import { nearestSnap, settleSnap, snapHeights, stepSnap } from "../src/layout/sheet";

describe("snapHeights", () => {
  it("derives the three heights from the viewport with a floor on peek", () => {
    expect(snapHeights(800, 60)).toEqual({ peek: 272, half: 440, full: 728 });
    expect(snapHeights(600, 60).peek).toBe(240);
  });
});

describe("nearestSnap and settleSnap", () => {
  const h = snapHeights(800, 60);
  it("picks the closest snap point", () => {
    expect(nearestSnap(300, h)).toBe("peek");
    expect(nearestSnap(400, h)).toBe("half");
    expect(nearestSnap(700, h)).toBe("full");
  });
  it("lets a flick move one step in its direction, whatever the position", () => {
    expect(settleSnap(300, 0.8, h, "peek")).toBe("half");
    expect(settleSnap(700, -0.8, h, "full")).toBe("half");
    expect(settleSnap(700, 0.8, h, "full")).toBe("full");
    expect(settleSnap(600, 0.1, h, "half")).toBe("full");
  });
  it("steps within the three points", () => {
    expect(stepSnap("peek", "up")).toBe("half");
    expect(stepSnap("full", "up")).toBe("full");
    expect(stepSnap("half", "down")).toBe("peek");
  });
});
