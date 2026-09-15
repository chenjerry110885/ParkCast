#!/usr/bin/env node
/**
 * The deploy gate's content check (spec §8.3 step 3). Node built-ins only.
 *
 *   node scripts/check-deploy-bundle.mjs [--worker-bundle worker/.wrangler/dry]
 *
 * Every uploaded file must be on the allowlist, required files must exist, and no
 * byte of any file may contain the upload secret, its shape, the deploy key or a
 * private key.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MiB = 1024 * 1024;

export const ALLOWED = [
  /^index\.html$/, /^404\.html$/, /^sw\.js$/, /^manifest\.webmanifest$/, /^favicon\.svg$/,
  /^icon-(192|512|maskable-512)\.png$/, /^_headers$/, /^robots\.txt$/, /^fallback\.css$/,
  /^basemap\/taipei\.pmtiles$/, /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(js|css)$/,
  // Label glyphs (docs/basemap.md): one file per font per 256 codepoints, plus the font licence.
  /^basemap\/fonts\/OFL\.txt$/, /^basemap\/fonts\/Noto Sans (Regular|Medium|Italic)\/\d{1,5}-\d{1,5}\.pbf$/,
];
export const LABEL_FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
export const REQUIRED = [
  "index.html", "404.html", "sw.js", "manifest.webmanifest", "_headers", "fallback.css",
  "robots.txt", "basemap/taipei.pmtiles", "basemap/fonts/OFL.txt",
  // Every label font's Latin range: without it the map ships with no street or place names.
  ...LABEL_FONTS.map((font) => `basemap/fonts/${font}/0-255.pbf`),
];
export const FORBIDDEN = [
  /\.map$/i, /\.(ts|tsx|py)$/i, /(^|\/)\.env/i, /(^|\/)\.dev\.vars/i,
  /\.(sqlite|db|parquet)$/i, /^artifacts\//, /^data\//,
];
const SECRET_SHAPE = /pcu_[A-Za-z0-9_-]{43}/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function listFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

/**
 * `wrangler deploy --dry-run --outdir` always writes local-only debug artifacts
 * (a source map, linked from the built script via `//# sourceMappingURL=`, and a
 * README) next to the built Worker script -- regardless of whether they will
 * ever be uploaded. Whether they get uploaded is controlled separately by
 * `upload_source_maps` in wrangler.jsonc. If that is enabled, wrangler would
 * upload the source map -- complete with its `sourcesContent`, i.e. the
 * Worker's original source text -- to Cloudflare, so silently discarding the
 * map from this scan would hide a real problem instead of flagging it.
 * Returns a problems list, like checkBundle: non-empty means "stop, don't
 * prune, don't trust this scan."
 */
export function pruneDryRunArtifacts(dir, config = {}) {
  if (config.upload_source_maps) {
    return [
      "worker/wrangler.jsonc has upload_source_maps enabled: wrangler would upload the worker's " +
        "source map (with its sourcesContent) to Cloudflare, so the dry-run bundle scan cannot " +
        "safely discard *.map before scanning it -- turn upload_source_maps off, or review the " +
        "bundle by hand",
    ];
  }
  for (const rel of listFiles(dir)) {
    if (rel.endsWith(".map") || rel === "README.md") rmSync(join(dir, rel));
  }
  return [];
}

function scanContent(path, label, secrets, problems) {
  const text = readFileSync(path).toString("latin1");
  if (SECRET_SHAPE.test(text)) problems.push(`secret-shaped string in ${label}`);
  if (PRIVATE_KEY.test(text)) problems.push(`private key in ${label}`);
  for (const secret of secrets) {
    if (secret && text.includes(secret)) problems.push(`a known secret value in ${label}`);
  }
}

export function checkBundle({ distDir, workerDir = null, secrets = [], basemapBytes = [15 * MiB, 25 * MiB] }) {
  const problems = [];
  const files = listFiles(distDir);
  for (const rel of files) {
    if (FORBIDDEN.some((r) => r.test(rel))) problems.push(`forbidden file: ${rel}`);
    else if (!ALLOWED.some((r) => r.test(rel))) problems.push(`not on the allowlist: ${rel}`);
    if (statSync(join(distDir, rel)).size >= 25 * MiB) problems.push(`over the 25 MiB asset limit: ${rel}`);
    scanContent(join(distDir, rel), rel, secrets, problems);
  }
  for (const rel of REQUIRED) {
    if (!files.includes(rel)) problems.push(`missing required file: ${rel}`);
  }
  if (files.includes("basemap/taipei.pmtiles")) {
    const size = statSync(join(distDir, "basemap/taipei.pmtiles")).size;
    const [min, max] = basemapBytes;
    if (size < min || size >= max) problems.push(`basemap size ${size} outside ${min}..${max}`);
  }
  if (workerDir) {
    for (const rel of listFiles(workerDir)) {
      if (FORBIDDEN.some((r) => r.test(rel))) problems.push(`forbidden file in the Worker bundle: ${rel}`);
      scanContent(join(workerDir, rel), `worker/${rel}`, secrets, problems);
    }
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const flag = process.argv.indexOf("--worker-bundle");
  const workerDir = flag > 0 ? resolve(process.argv[flag + 1]) : null;
  const secretPath = join(root, "docker", "secrets", "parkcast_upload_secret");
  const secrets = [
    existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : "",
    process.env.CLOUDFLARE_API_TOKEN ?? "",
  ].filter((s) => s.length >= 16);
  const problems = checkBundle({ distDir: join(root, "web", "dist"), workerDir, secrets });
  if (problems.length > 0) {
    console.error(`deploy bundle check FAILED:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`deploy bundle check passed (${listFiles(join(root, "web", "dist")).length} files)`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) main();
