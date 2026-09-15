import { describe, expect, it } from "vitest";
import { BASEMAP_BOUNDS, GLYPHS_URL, TILES_URL, basemapStyle, labelLang } from "../src/map/basemapStyle";

/** Every string anywhere in a value, so a nested URL cannot hide from the check. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const symbolLayers = (style: ReturnType<typeof basemapStyle>) =>
  style.layers.filter((layer) => layer.type === "symbol");

describe("basemapStyle", () => {
  it("draws street and place labels, not just roads", () => {
    for (const lang of ["zh", "en"] as const) {
      expect(symbolLayers(basemapStyle("light", lang)).length).toBeGreaterThan(0);
    }
  });

  it("loads plain tile files within the extract's bounds, not a range-read archive", () => {
    const source = basemapStyle("light", "zh").sources.basemap as {
      tiles?: string[];
      url?: string;
      bounds?: number[];
      maxzoom?: number;
    };
    // Cloudflare's static hosting ignores Range, so a pmtiles:// archive draws nothing live.
    expect(source.url).toBeUndefined();
    expect(source.tiles).toEqual([TILES_URL]);
    expect(TILES_URL).toBe(`${window.location.origin}/basemap/tiles/{z}/{x}/{y}.pbf`);
    expect(source.bounds).toEqual(BASEMAP_BOUNDS);
    expect(source.maxzoom).toBe(15);
  });

  it("fetches tiles and glyphs from this origin only", () => {
    const style = basemapStyle("dark", "zh");
    expect(style.glyphs).toBe(GLYPHS_URL);
    expect(GLYPHS_URL).toBe("/basemap/fonts/{fontstack}/{range}.pbf");
    // The attribution is the only place a third-party URL may appear, and it is a link, not a fetch.
    const { attribution: _attribution, ...source } = style.sources.basemap as Record<string, unknown>;
    const fetched = [...strings(style.glyphs), ...strings(source), ...strings(style.layers)];
    const offOrigin = fetched.filter(
      (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !s.startsWith(`${window.location.origin}/`),
    );
    expect(offOrigin).toEqual([]);
  });

  it("asks for no sprite images, because none is shipped", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const lang of ["zh", "en"] as const) {
        const style = basemapStyle(theme, lang);
        expect(style.sprite).toBeUndefined();
        expect(style.layers.filter((l) => l.type === "symbol" && l.layout?.["icon-image"] !== undefined)).toEqual([]);
      }
    }
  });

  it("labels in the app's language", () => {
    expect(labelLang("zh")).toBe("zh-Hant");
    expect(labelLang("en")).toBe("en");
    expect(JSON.stringify(symbolLayers(basemapStyle("light", "zh")))).toContain("name:zh-Hant");
    expect(JSON.stringify(symbolLayers(basemapStyle("light", "en")))).toContain("name:en");
  });

  it("names only fonts the deploy gate ships, plus Devanagari, which the device draws", () => {
    const fonts = new Set<string>();
    for (const theme of ["light", "dark"] as const) {
      for (const lang of ["zh", "en"] as const) {
        for (const layer of symbolLayers(basemapStyle(theme, lang))) {
          for (const s of strings(layer.layout?.["text-font"])) if (s.startsWith("Noto")) fonts.add(s);
        }
      }
    }
    // Kept in step with LABEL_FONTS in scripts/check-deploy-bundle.mjs.
    const shipped = ["Noto Sans Italic", "Noto Sans Medium", "Noto Sans Regular"];
    for (const font of shipped) expect(fonts).toContain(font);
    expect([...fonts].filter((f) => !shipped.includes(f) && f !== "Noto Sans Devanagari Regular v1")).toEqual([]);
  });
});
