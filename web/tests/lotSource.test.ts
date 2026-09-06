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
});
