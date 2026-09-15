import assert from "node:assert/strict";
import { test } from "node:test";
import { labelInputs, neededRanges } from "../select-glyphs.mjs";

const cps = (text) => [...text].map((ch) => ch.codePointAt(0));

test("always ships Basic Latin, even for an all-Chinese map", () => {
  assert.deepEqual(neededRanges(cps("台北車站")), ["0-255.pbf"]);
});

test("skips every range MapLibre draws with the device's own fonts", () => {
  // Han, CJK punctuation, Bopomofo, Hangul and fullwidth forms never reach the glyphs URL.
  assert.deepEqual(neededRanges(cps("中「」ㄧ대（／）")), ["0-255.pbf"]);
});

test("ships the ranges of the non-CJK characters that do appear", () => {
  assert.deepEqual(neededRanges(cps("Tōnghuà St ‧ Ⅲ Россия")), [
    "0-255.pbf", "256-511.pbf", "1024-1279.pbf", "8192-8447.pbf", "8448-8703.pbf",
  ]);
});

test("reads the source layers, properties and fonts of symbol layers only", () => {
  const inputs = labelInputs([[
    { type: "line", "source-layer": "roads", layout: { "text-font": ["Not A Label Font"] } },
    {
      type: "symbol",
      "source-layer": "places",
      layout: {
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
        "text-font": ["case", ["==", ["get", "script"], "Devanagari"], ["literal", ["Noto Sans Devanagari Regular v1"]], ["literal", ["Noto Sans Medium"]]],
      },
    },
  ]]);
  assert.deepEqual([...inputs.sourceLayers], ["places"]);
  assert.deepEqual([...inputs.keys].sort(), ["name", "name:en", "script"]);
  assert.deepEqual([...inputs.fonts].sort(), ["Noto Sans Devanagari Regular v1", "Noto Sans Medium"]);
});
