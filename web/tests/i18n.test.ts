import { describe, expect, it } from "vitest";
import { districtName, lotTypeName, t } from "../src/i18n";

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
