import { describe, expect, it } from "vitest";
import { haversineMeters, walkMinutes } from "../src/geo";

describe("haversineMeters", () => {
  it("measures a known Taipei distance", () => {
    // Taipei 101 to Taipei City Hall, about 400 m (verified: 408 m).
    const d = haversineMeters({ lat: 25.0339, lon: 121.5645 },
                              { lat: 25.0375, lon: 121.5637 });
    expect(d).toBeGreaterThan(350);
    expect(d).toBeLessThan(500);
  });

  it("is zero for the same point and symmetric", () => {
    const a = { lat: 25.05, lon: 121.52 }, b = { lat: 25.06, lon: 121.53 };
    expect(haversineMeters(a, a)).toBe(0);
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe("walkMinutes", () => {
  it("rounds up, because arriving early is not the failure mode", () => {
    expect(walkMinutes(80)).toBe(1);
    expect(walkMinutes(81)).toBe(2);
    expect(walkMinutes(0)).toBe(0);
  });
});
