/**
 * Tests for the installable-app assets: the manifest, the icons it points at,
 * and the favicon.
 *
 * These are generated files (`python scripts/build-icons.py`) referenced by a
 * hand-written manifest, so the failure mode is drift: an icon renamed, a size
 * that no longer matches its declaration, a `maskable` icon that is not actually
 * maskable. None of that shows up in a build, and all of it shows up on a
 * driver's home screen.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// Resolved through `fileURLToPath` rather than `new URL("...", import.meta.url)`:
// Vite rewrites that literal pattern at transform time into an asset URL, which
// here would resolve to `http://localhost/icon-192.png` and never reach the disk.
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(WEB, "public");

const MANIFEST = JSON.parse(readFileSync(join(PUBLIC, "manifest.webmanifest"), "utf8"));
const INDEX_HTML = readFileSync(join(WEB, "index.html"), "utf8");

/** The app's own accent, from `--accent` in `src/index.css`. */
const ACCENT = "#1d5fd0";

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

/** Width, height and the raw RGBA rows of a PNG this repo generated. */
function readPng(name: string) {
  const bytes = readFileSync(join(PUBLIC, name));
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const chunks = new Map<string, Buffer[]>();
  let width = 0;
  let height = 0;
  let colourType = -1;
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const tag = bytes.subarray(at + 4, at + 8).toString("ascii");
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (tag === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colourType = data.readUInt8(9);
    }
    if (!chunks.has(tag)) chunks.set(tag, []);
    chunks.get(tag)!.push(Buffer.from(data));
    at += 12 + length; // length + tag + data + CRC
  }

  // Colour type 6 is RGBA, and `build-icons.py` writes filter 0 on every
  // scanline, so the inflated stream is `1 + width * 4` bytes per row with no
  // un-filtering to undo.
  expect(colourType).toBe(6);
  const pixels = inflateSync(Buffer.concat(chunks.get("IDAT")!));
  return { width, height, pixels, bytes };
}

const RED = 0;
const ALPHA = 3;

/** One channel of the pixel at (x, y). Filter 0 means one byte of row prefix. */
function channelAt({ width, pixels }: ReturnType<typeof readPng>, x: number, y: number, channel: number) {
  return pixels[y * (1 + width * 4) + 1 + x * 4 + channel];
}

/**
 * The lowest alpha byte in the image.
 *
 * A running minimum rather than an array of 262,144 alphas fed to `Math.min`,
 * which overflows the argument stack.
 */
function minAlpha(png: ReturnType<typeof readPng>) {
  let lowest = 255;
  for (let y = 0; y < png.height; y += 1) {
    expect(png.pixels[y * (1 + png.width * 4)]).toBe(0); // filter type "None"
    for (let x = 0; x < png.width; x += 1) {
      lowest = Math.min(lowest, channelAt(png, x, y, ALPHA)!);
    }
  }
  return lowest;
}

describe("the web app manifest", () => {
  it("names the app in both scripts", () => {
    expect(MANIFEST.name).toBe("ParkCast — 停車先知");
    expect(MANIFEST.short_name).toBe("ParkCast");
  });

  it("keeps start_url and scope relative, because the app deploys under /ParkCast/", () => {
    // Vite does not process a `.webmanifest`, so nothing rewrites an absolute
    // path here with the deployment base. `/` would scope the installed app to
    // the whole github.io origin and start it on someone else's project.
    expect(MANIFEST.start_url).toBe("./");
    expect(MANIFEST.scope).toBe("./");
    for (const icon of MANIFEST.icons as ManifestIcon[]) {
      expect(icon.src.startsWith("./")).toBe(true);
    }
  });

  it("declares a standalone display and the app's own accent", () => {
    expect(MANIFEST.display).toBe("standalone");
    expect(MANIFEST.theme_color).toBe(ACCENT);
    expect(MANIFEST.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("ships exactly one maskable icon alongside the plain ones", () => {
    const icons = MANIFEST.icons as ManifestIcon[];
    expect(icons.filter((icon) => icon.purpose === "maskable")).toHaveLength(1);
    expect(icons.filter((icon) => icon.purpose === "any").map((icon) => icon.sizes).sort()).toEqual([
      "192x192",
      "512x512",
    ]);
  });

  it("points at PNGs that exist and are the size they claim", () => {
    for (const icon of MANIFEST.icons as ManifestIcon[]) {
      const png = readPng(icon.src.replace(/^\.\//, ""));
      expect(`${png.width}x${png.height}`, icon.src).toBe(icon.sizes);
      expect(icon.type).toBe("image/png");
    }
  });
});

describe("the maskable icon", () => {
  it("is fully opaque, so a launcher's crop cannot expose a chipped corner", () => {
    // The whole contract of `purpose: maskable`: the launcher applies its own
    // mask -- circle, squircle, teardrop -- and only the central 80% is
    // guaranteed to survive. An icon with transparent corners paints those
    // corners as holes behind whatever shape the launcher chose.
    expect(minAlpha(readPng("icon-maskable-512.png"))).toBe(255);
  });

  it("keeps the glyph inside the 80% safe zone", () => {
    const png = readPng("icon-maskable-512.png");
    const inset = Math.floor(png.width * 0.1);
    // Anything white outside the safe zone would be croppable glyph. Sample the
    // border ring: it must be solid accent blue, red channel 0x1d.
    for (let y = 0; y < png.height; y += 1) {
      const edge = y < inset || y >= png.height - inset;
      for (let x = 0; x < png.width; x += 1) {
        if (!edge && x >= inset && x < png.width - inset) continue;
        expect(channelAt(png, x, y, RED)).toBe(0x1d);
      }
    }
  });
});

describe("the plain icon", () => {
  it("has transparent corners, so it is a rounded mark and not a blue square", () => {
    const png = readPng("icon-512.png");
    expect(channelAt(png, 0, 0, ALPHA)).toBe(0);
    expect(channelAt(png, png.width - 1, png.height - 1, ALPHA)).toBe(0);
    // ...and is still solid in the middle.
    const mid = Math.floor(png.width / 2);
    expect(channelAt(png, mid, mid, ALPHA)).toBe(255);
  });
});

describe("the favicon", () => {
  const svg = readFileSync(join(PUBLIC, "favicon.svg"), "utf8");

  it("is ParkCast's mark and not the Vite scaffold's", () => {
    expect(svg).not.toMatch(/#863bff/i); // the starter template's purple
    expect(svg).toContain(ACCENT);
    expect(svg).toContain('aria-label="ParkCast"');
  });
});

describe("index.html", () => {
  it("links the manifest, the favicon and an apple-touch-icon", () => {
    expect(INDEX_HTML).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
    expect(INDEX_HTML).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
    expect(INDEX_HTML).toMatch(/<link rel="apple-touch-icon" href="\/icon-maskable-512\.png" \/>/);
  });

  it("declares the same theme colour as the manifest", () => {
    expect(INDEX_HTML).toContain(`<meta name="theme-color" content="${MANIFEST.theme_color}" />`);
  });
});
