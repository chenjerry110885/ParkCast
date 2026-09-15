import { describe, expect, it } from "vitest";
import { toFeatureCollection } from "../src/map/lotSource";

const row = (over: Record<string, unknown> = {}) =>
  ({ id: "TPE0001", name: "測試", district: "中正區", lat: 25.05, lon: 121.52,
     probability: 0.8, hourly: 50, perEntry: null, priceKnown: true,
     walkMin: 4, meters: 300, ...over }) as never;

describe("toFeatureCollection", () => {
  it("uses GeoJSON [lon, lat] order, not [lat, lon]", () => {
    const fc = toFeatureCollection([row()]);
    expect(fc.features[0]!.geometry).toMatchObject({ coordinates: [121.52, 25.05] });
  });

  it("carries a null probability through rather than dropping the lot", () => {
    const fc = toFeatureCollection([row({ probability: null })]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.properties!.probability).toBeNull();
  });

  it("emits every row it is given", () => {
    expect(toFeatureCollection([row(), row({ id: "B" }), row({ id: "C" })]).features).toHaveLength(3);
  });

  it("marks the selected and best lots on their features", () => {
    // The map draws the halo from these two flags, so they have to be per-lot
    // properties rather than a paint expression over ids -- and they have to be
    // independent: the lot the driver tapped is usually not the best one.
    const fc = toFeatureCollection([row({ id: "A" }), row({ id: "B" })], { selectedId: "A", bestId: "B" });
    expect(fc.features[0]!.properties.selected).toBe(true);
    expect(fc.features[0]!.properties.best).toBe(false);
    expect(fc.features[1]!.properties.selected).toBe(false);
    expect(fc.features[1]!.properties.best).toBe(true);
  });

  it("marks nothing when it is told nothing, rather than guessing", () => {
    // The map is drawn before a destination exists, so "no marks" is the
    // ordinary case and must not fall back to marking the first row.
    const fc = toFeatureCollection([row({ id: "A" }), row({ id: "B" })]);
    for (const feature of fc.features) {
      expect(feature.properties.selected).toBe(false);
      expect(feature.properties.best).toBe(false);
    }
  });
});
