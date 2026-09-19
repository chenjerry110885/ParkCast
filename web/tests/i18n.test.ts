import { describe, expect, it } from "vitest";
import { districtName, fillTemplate, lotTypeName, t } from "../src/i18n";

describe("translation", () => {
  it("has both languages for every key", () => {
    const en = t("en"), zh = t("zh");
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[k]).toBeTruthy();
      expect(zh[k]).toBeTruthy();
    }
  });

  it("uses Traditional characters, never Simplified", () => {
    const zh = JSON.stringify(t("zh")) + JSON.stringify(
      ["中正區", "信義區"].map((d) => districtName(d, "zh")));
    // A few high-frequency Simplified forms that must never appear.
    for (const bad of ["车", "费", "间", "价", "钟", "机"]) {
      expect(zh).not.toContain(bad);
    }
  });

  /**
   * The two amenity tiles say "total", because the tile beside them does not.
   *
   * `m` is `totalmotor` and `e` is `ChargingStation` -- both capacities. They
   * sit on the same grid as `spacesNowLabel`, whose value reads "現在 92 / 370
   * 位 · 51 分鐘前", and Taipei publishes a real live motorcycle count
   * (`availablemotor` -> `free_motor`), so "178 / 機車位" had every reason to
   * be read as 178 bays free right now. Same class as "the observed count `f`
   * is never presented as a forecast": a number wearing a label that belongs
   * to a different number.
   */
  it("labels the amenity tiles as totals, and the live tile as an observation", () => {
    for (const lang of ["en", "zh"] as const) {
      const s = t(lang);
      const total = lang === "en" ? "total" : "總數";
      expect(s.scooterTile).toContain(total);
      expect(s.chargingTile).toContain(total);
      // The live neighbour stays an observation and never borrows the word --
      // if it did, the distinction these labels draw would be gone again.
      expect(s.spacesNowLabel).not.toContain(total);
    }
  });

  /**
   * The hidden-count lines name their scope and count in their own number.
   *
   * The scope is the rows the list would otherwise show, which is neither the
   * city nor the rows on screen -- "22 rows on screen, 13 hidden" is a sum a
   * reader cannot complete, because the list refilled from below its own cap.
   * And "1 car parks are hidden" is the sentence English gets at `n === 1`,
   * which for the unknown line is an ordinary roster and not an edge case;
   * the singular/plural pair follows `confidenceWeekTemplate`'s precedent, and
   * zh's two are deliberately the same text.
   */
  it("scopes the hidden-count lines, and gives English a singular for each", () => {
    const en = t("en"), zh = t("zh");
    for (const template of [en.filterHiddenNoneTemplate, en.filterHiddenUnknownTemplate]) {
      expect(template).toContain("this list");
      expect(template).toContain("car parks");
      expect(template).toContain("are hidden");
    }
    for (const template of [en.filterHiddenNoneOneTemplate, en.filterHiddenUnknownOneTemplate]) {
      expect(template).toContain("this list");
      expect(template).toContain("{n} car park ");
      expect(template).not.toContain("car parks");
      expect(template).toContain("is hidden");
    }
    for (const template of [zh.filterHiddenNoneTemplate, zh.filterHiddenUnknownTemplate]) {
      expect(template).toContain("此清單");
    }
    expect(zh.filterHiddenNoneOneTemplate).toBe(zh.filterHiddenNoneTemplate);
    expect(zh.filterHiddenUnknownOneTemplate).toBe(zh.filterHiddenUnknownTemplate);
    // The distinction the two lines exist to draw survives the rewording.
    expect(en.filterHiddenUnknownTemplate).toContain("not the same as having none");
    expect(zh.filterHiddenUnknownTemplate).toContain("這與「回報沒有」並不一樣");
  });

  /**
   * The nearby expander says how many rows it opens, and does not say how far.
   *
   * The count is the substance of the control, not decoration: "show more" is
   * the difference between three rows and a hundred and forty, which is the
   * difference between a glance and a scroll, and a driver looking at a green
   * dot on the map needs to know the list can reach it before they will
   * believe that it does.
   *
   * The distance stays out of the copy. `NEARBY_RADIUS_M` is a *straight-line*
   * 1.5 km, and `geo.ts` says in as many words that a straight line understates
   * a real Taipei walk by 20-30% -- so "within 1.5 km" would be a promise made
   * in a unit the app already qualifies everywhere else it shows one.
   */
  it("counts the rows the expander opens, in both languages, and names no radius", () => {
    const en = t("en"), zh = t("zh");
    for (const template of [
      en.nearbyMoreTemplate,
      en.nearbyMoreOneTemplate,
      zh.nearbyMoreTemplate,
      zh.nearbyMoreOneTemplate,
    ]) {
      expect(template).toContain("{n}");
      expect(template).not.toMatch(/1\.5|1,?500|公里|km/);
    }
    // English needs the singular: without it the `n === 1` case, which any
    // filtered list can reach, reads "Show 1 more car parks nearby".
    expect(en.nearbyMoreOneTemplate).not.toBe(en.nearbyMoreTemplate);
    expect(fillTemplate(en.nearbyMoreOneTemplate, { n: 1 })).toBe("Show 1 more car park nearby");
    expect(fillTemplate(en.nearbyMoreTemplate, { n: 3 })).toBe("Show 3 more car parks nearby");
    // Chinese draws no singular/plural distinction, so its two are deliberately
    // the same text -- `confidenceWeekTemplate`'s precedent exactly.
    expect(zh.nearbyMoreOneTemplate).toBe(zh.nearbyMoreTemplate);
  });
});

describe("districtName", () => {
  it("translates all twelve districts", () => {
    const districts = ["中正區", "大同區", "中山區", "松山區", "大安區", "萬華區",
                       "信義區", "士林區", "北投區", "內湖區", "南港區", "文山區"];
    for (const d of districts) {
      expect(districtName(d, "en")).toMatch(/District$/);
      expect(districtName(d, "zh")).toBe(d);
    }
  });

  it("falls back to the source string for an unknown district", () => {
    expect(districtName("新區", "en")).toBe("新區");
  });
});

describe("lotTypeName", () => {
  it("translates the operator types and falls back safely", () => {
    expect(lotTypeName("民營停車場", "en")).toBeTruthy();
    expect(lotTypeName("民營停車場", "en")).not.toBe("民營停車場");
    expect(lotTypeName("未知類型", "en")).toBe("未知類型");
  });
});
