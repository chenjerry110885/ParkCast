#!/usr/bin/env node
/**
 * Copy just the glyph ranges the basemap's labels can ask for into
 * `web/public/basemap/fonts/` (docs/basemap.md).
 *
 *   node scripts/select-glyphs.mjs --fonts <path to a basemaps-assets checkout>/fonts
 *
 * MapLibre draws label text from signed-distance-field glyph files, one per font
 * and per 256 codepoints, fetched from the style's `glyphs` URL. The full
 * Protomaps set is 768 files; Taipei's labels touch a few dozen of them. This
 * reads every tile in `taipei.pmtiles`, collects every character the label
 * layers could draw, drops the ones MapLibre draws with the device's own fonts
 * instead (Chinese, Japanese and Korean -- see LOCAL_IDEOGRAPH), and copies the
 * remaining ranges for each font the label layers name.
 *
 * Like build-basemap.mjs, this downloads nothing. Fetch the fonts yourself, from
 * a pinned commit of github.com/protomaps/basemaps-assets, and point --fonts at
 * them. Re-run it after rebuilding the basemap: new place names can need new ranges.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE, openArchive, repoRoot, tileCoords, webModule } from "./basemap-archive.mjs";

const OUT = join(repoRoot, "web", "public", "basemap", "fonts");

/** The languages the app offers, as `labelLang` in `web/src/map/basemapStyle.ts` names them. */
const LABEL_LANGS = ["zh-Hant", "en"];
const THEMES = ["light", "dark"];

/**
 * The characters MapLibre never fetches a glyph range for, because it draws them
 * with `localIdeographFontFamily` (the device's own fonts) instead. Copied from
 * maplibre-gl 6.7.0's `codePointUsesLocalIdeographFontFamily`; re-copy it when
 * upgrading MapLibre.
 */
const LOCAL_IDEOGRAPH = /[\u02EA\u02EB\u1100-\u11FF\u2E80-\u2FDF\u3000-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u4DBF\u4E00-\uA48C\uA490-\uA4C6\uA960-\uA97C\uAC00-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFFEF]|\uD81B[\uDFE0-\uDFFF]|[\uD81C-\uD822\uD840-\uD868\uD86A-\uD86D\uD86F-\uD872\uD874-\uD879\uD880-\uD883\uD885-\uD88C][\uDC00-\uDFFF]|\uD823[\uDC00-\uDCD5\uDCFF-\uDD1E\uDD80-\uDDF2]|\uD82B[\uDFF0-\uDFFF]|\uD82C[\uDC00-\uDEFB]|\uD83C[\uDE00-\uDEFF]|\uD869[\uDC00-\uDEDF\uDF00-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEAD\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0\uDFF0-\uDFFF]|\uD87B[\uDC00-\uDE5D]|\uD87E[\uDC00-\uDE1D]|\uD884[\uDC00-\uDF4A\uDF50-\uDFFF]|\uD88D[\uDC00-\uDC79]/;

/** The glyph files (`<start>-<end>.pbf`) MapLibre could fetch to draw these codepoints. */
export function neededRanges(codepoints) {
  const ranges = new Set([0]); // Basic Latin: digits, spaces and any literal text in the style itself
  for (const cp of codepoints) {
    if (!LOCAL_IDEOGRAPH.test(String.fromCodePoint(cp))) ranges.add(Math.floor(cp / 256));
  }
  return [...ranges].sort((a, b) => a - b).map((r) => `${r * 256}-${r * 256 + 255}.pbf`);
}

/** Expressions whose arguments are all strings, so they cannot be told from a fontstack by shape. */
const STRING_ONLY_OPERATORS = new Set(["get", "has", "var", "zoom", "geometry-type", "id", "properties"]);

/** The source layers, feature properties and fontstacks the label layers read. */
export function labelInputs(layerLists) {
  const keys = new Set(), sourceLayers = new Set(), fonts = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) {
      if (v[0] === "get" && typeof v[1] === "string") keys.add(v[1]);
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  // A fontstack is a plain array of names, or the array inside ["literal", [...]];
  // any other array in `text-font` is an expression choosing between them.
  const walkFonts = (v) => {
    if (!Array.isArray(v)) return;
    if (v[0] === "literal" && Array.isArray(v[1])) v[1].forEach((f) => fonts.add(f));
    else if (v.every((x) => typeof x === "string") && !STRING_ONLY_OPERATORS.has(v[0])) v.forEach((f) => fonts.add(f));
    else v.forEach(walkFonts);
  };
  for (const layer of layerLists.flat()) {
    if (layer.type !== "symbol") continue;
    sourceLayers.add(layer["source-layer"]);
    walk(layer.layout ?? {});
    walkFonts(layer.layout?.["text-font"]);
  }
  return { keys, sourceLayers, fonts };
}

async function main() {
  const flag = process.argv.indexOf("--fonts");
  if (flag < 0 || !process.argv[flag + 1]) {
    console.error("usage: node scripts/select-glyphs.mjs --fonts <basemaps-assets checkout>/fonts");
    process.exit(2);
  }
  const fontsDir = resolve(process.argv[flag + 1]);
  if (!existsSync(join(fontsDir, "OFL.txt"))) {
    console.error(`select-glyphs: ${fontsDir} has no OFL.txt -- is it the basemaps-assets fonts directory?`);
    process.exit(2);
  }
  if (!existsSync(ARCHIVE)) {
    console.error("select-glyphs: web/basemap-src/taipei.pmtiles is missing -- run scripts/build-basemap.mjs first");
    process.exit(2);
  }

  // The web app's own copies, so the style read here is the style the app draws.
  const { VectorTile } = await webModule("@mapbox/vector-tile/index.js");
  const { PbfReader } = await webModule("pbf/index.js");
  const { layers, namedTheme } = await webModule("protomaps-themes-base/dist/esm/index.js");

  // The same call `web/src/map/basemapStyle.ts` makes, labels only.
  const { keys, sourceLayers, fonts } = labelInputs(
    THEMES.flatMap((theme) =>
      LABEL_LANGS.map((lang) => layers("basemap", namedTheme(theme), { lang, labelsOnly: true }))),
  );

  const archive = await openArchive();
  const codepoints = new Set();
  let tiles = 0;
  for (const [z, x, y] of tileCoords(await archive.getHeader())) {
    const tile = await archive.getZxy(z, x, y);
    if (!tile) continue;
    tiles++;
    const vt = new VectorTile(new PbfReader(new Uint8Array(tile.data)));
    for (const name of Object.keys(vt.layers)) {
      if (!sourceLayers.has(name)) continue;
      const layer = vt.layers[name];
      for (let i = 0; i < layer.length; i++) {
        const props = layer.feature(i).properties;
        for (const key of keys) {
          const value = props[key];
          if (value === undefined || typeof value === "boolean") continue;
          for (const ch of String(value)) codepoints.add(ch.codePointAt(0));
        }
      }
    }
  }

  const ranges = neededRanges(codepoints);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  copyFileSync(join(fontsDir, "OFL.txt"), join(OUT, "OFL.txt"));
  let copied = 0, bytes = 0;
  const unavailable = [];
  for (const font of [...fonts].sort()) {
    if (!existsSync(join(fontsDir, font))) {
      unavailable.push(`${font} (whole font)`);
      continue;
    }
    mkdirSync(join(OUT, font), { recursive: true });
    for (const range of ranges) {
      const src = join(fontsDir, font, range);
      if (!existsSync(src)) {
        unavailable.push(`${font}/${range}`);
        continue;
      }
      copyFileSync(src, join(OUT, font, range));
      copied++;
      bytes += statSync(src).size;
    }
  }
  console.log(`select-glyphs: ${tiles} tiles, ${codepoints.size} distinct label characters, ${ranges.length} ranges`);
  console.log(`select-glyphs: copied ${copied} glyph files (${(bytes / 1024 / 1024).toFixed(2)} MB) + OFL.txt to web/public/basemap/fonts/`);
  if (unavailable.length > 0) {
    console.log(`select-glyphs: not in the font set, drawn with the device's fonts instead: ${unavailable.join(", ")}`);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) await main();
