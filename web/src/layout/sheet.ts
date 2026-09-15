/**
 * Where the results sheet rests, and where a drag or flick sends it.
 *
 * The sheet has exactly three resting heights -- `peek` (just the search bar
 * and a hint of the list), `half`, and `full` -- derived from the viewport
 * rather than hard-coded, so a short phone in landscape still gets a usable
 * peek instead of a sheet that swallows the map. This module is the pure
 * arithmetic behind that: it never touches a DOM node or a gesture event, so
 * the drag handler that does can be tested by pushing numbers through here
 * instead of simulating touch events.
 *
 * A flick wins over position: `settleSnap` treats a fast release as intent
 * ("the user wants more/less sheet") and steps one point in that direction
 * regardless of where the finger let go, the way a real bottom sheet
 * (Google Maps, Apple Maps) behaves. A slow release falls back to whichever
 * point the sheet ended up closest to.
 */

export type Snap = "peek" | "half" | "full";
export const SNAPS: readonly Snap[] = ["peek", "half", "full"];
export const FLICK_PX_PER_MS = 0.5;
export const PEEK_MIN_PX = 240;

export interface SnapHeights { peek: number; half: number; full: number }

export function snapHeights(viewportH: number, topBarH: number): SnapHeights {
  return {
    peek: Math.max(PEEK_MIN_PX, Math.round(viewportH * 0.34)),
    half: Math.round(viewportH * 0.55),
    full: Math.round(viewportH - topBarH - 12),
  };
}

export function nearestSnap(height: number, heights: SnapHeights): Snap {
  let best: Snap = "peek";
  let bestDistance = Infinity;
  for (const snap of SNAPS) {
    const distance = Math.abs(heights[snap] - height);
    if (distance < bestDistance) { best = snap; bestDistance = distance; }
  }
  return best;
}

export function stepSnap(from: Snap, direction: "up" | "down"): Snap {
  const at = SNAPS.indexOf(from);
  const next = direction === "up" ? Math.min(SNAPS.length - 1, at + 1) : Math.max(0, at - 1);
  return SNAPS[next]!;
}

/** Where a release lands: a flick goes one step its way, otherwise the nearest point. */
export function settleSnap(height: number, velocityPxPerMs: number, heights: SnapHeights, from: Snap): Snap {
  if (velocityPxPerMs >= FLICK_PX_PER_MS) return stepSnap(from, "up");
  if (velocityPxPerMs <= -FLICK_PX_PER_MS) return stepSnap(from, "down");
  return nearestSnap(height, heights);
}
