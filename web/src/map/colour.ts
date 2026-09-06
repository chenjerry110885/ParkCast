/**
 * Probability -> colour, and the one rule this whole project turns on: **"we do
 * not know" is not a value on the scale.**
 *
 * A grid cell of 255 means no forecast; a cell of 0 means the model is
 * confident the car park is full. Painting them the same colour would state a
 * certainty the data does not support -- the map equivalent of rendering the
 * no-data sentinel as 0%, which the collector, the artifact writer and the list
 * all refuse to do. So `UNKNOWN_COLOUR` is a neutral grey drawn from nowhere on
 * the ramp, and it is the *only* grey the map uses.
 *
 * The colour of a lot is computed here, in one place, and carried on the
 * feature as a property rather than re-expressed as a MapLibre `interpolate`
 * expression in the layer paint. Two implementations of one ramp is two chances
 * to get the unknown case wrong, and only one of them would be under test.
 */

/**
 * The ramp, low chance of a space -> high chance.
 *
 * ColorBrewer's RdYlBu, minus its two palest steps: red-to-blue reads as
 * bad-to-good without relying on the red/green distinction that ~8% of men
 * cannot make, and every stop here stays saturated enough to sit on a light
 * basemap without dissolving into it.
 */
export const PROBABILITY_RAMP = [
  "#d73027", // 0.00 -- almost certainly full
  "#f46d43", // 0.25
  "#fdae61", // 0.50
  "#74add1", // 0.75
  "#4575b4", // 1.00 -- almost certainly a space
] as const;

/**
 * No forecast. Deliberately off-ramp: a desaturated grey that cannot be read as
 * "a bit red" or "a bit blue". Matches `--unknown` in `index.css`, so a lot
 * that says "no data" in the list is the same grey on the map.
 */
export const UNKNOWN_COLOUR = "#6a6a76";

/** `#rrggbb` -> [r, g, b]. Only ever called on the literals above. */
function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function hex2(v: number): string {
  return Math.round(v).toString(16).padStart(2, "0");
}

/**
 * The colour for a probability, or `UNKNOWN_COLOUR` for `null`.
 *
 * Linear interpolation between the ramp stops in sRGB. Not perceptually
 * uniform -- a proper Oklab ramp would be -- but the stops are close enough in
 * hue that the difference is invisible at circle size, and this way the ramp is
 * five hex literals a reader can check against ColorBrewer rather than a colour
 * space implementation they have to trust.
 *
 * A non-finite input is unknown, not zero: NaN reaching this function means a
 * corrupt grid, and the honest answer to a corrupt reading is "no data".
 */
export function colourFor(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return UNKNOWN_COLOUR;

  const clamped = Math.min(1, Math.max(0, p));
  const last = PROBABILITY_RAMP.length - 1;
  const scaled = clamped * last;
  const i = Math.min(last - 1, Math.floor(scaled));
  const frac = scaled - i;

  const lo = channels(PROBABILITY_RAMP[i]!);
  const hi = channels(PROBABILITY_RAMP[i + 1]!);
  return `#${lo.map((c, k) => hex2(c + (hi[k]! - c) * frac)).join("")}`;
}
