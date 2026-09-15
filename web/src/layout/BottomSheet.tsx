/**
 * The phone layout's results surface: a sheet that rests at `peek`, `half`
 * or `full` and drags between them, per `./sheet`'s pure arithmetic. This
 * component is the only thing that touches a DOM node or a pointer event --
 * everything about *where* the sheet should land after a drag or a flick
 * lives in `sheet.ts` and is tested there without simulating touch at all.
 *
 * The grip is a real `<button>`, not a drag handle dressed as one: tapping
 * it steps the sheet peek<->full for anyone who cannot (or would rather not)
 * drag, and the drag handlers sit alongside the click handler on the same
 * element. `moved` distinguishes the two -- a drag that displaces the
 * pointer by more than a few pixels should not also fire the click the
 * browser synthesises on pointerup, or a drag-to-peek would immediately
 * bounce back to full. That guard has to be short-lived, though: `end`
 * clears it again on the next macrotask, after the synthesised click (which
 * fires synchronously off the same pointerup) has had its chance to see it
 * still set. A later Space/Enter activation of the grip -- which never
 * drags, so never sets `moved` in the first place -- always toggles; without
 * the timed reset, one drag would leave the button permanently deaf to the
 * keyboard.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { t, type Lang } from "../i18n";
import { settleSnap, snapHeights, type Snap, type SnapHeights } from "./sheet";

export interface BottomSheetProps { snap: Snap; onSnapChange: (snap: Snap) => void; topBarHeight?: number; header: ReactNode; children: ReactNode; lang: Lang }

const VELOCITY_WINDOW_MS = 80;
const MOVE_THRESHOLD_PX = 6;

export function BottomSheet({ snap, onSnapChange, topBarHeight = 60, header, children, lang }: BottomSheetProps) {
  const s = t(lang);
  const [heights, setHeights] = useState<SnapHeights>(() => snapHeights(typeof window === "undefined" ? 800 : window.innerHeight, topBarHeight));
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ startY: number; startHeight: number; samples: Array<[number, number]> } | null>(null);
  const moved = useRef(false);
  const movedReset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => setHeights(snapHeights(window.innerHeight, topBarHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [topBarHeight]);

  useEffect(() => () => { if (movedReset.current !== null) clearTimeout(movedReset.current); }, []);

  const begin = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    moved.current = false;
    drag.current = { startY: event.clientY, startHeight: heights[snap], samples: [[performance.now(), event.clientY]] };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [heights, snap]);

  const move = useCallback((event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null) return;
    if (Math.abs(event.clientY - d.startY) > MOVE_THRESHOLD_PX) moved.current = true;
    const now = performance.now();
    d.samples.push([now, event.clientY]);
    while (d.samples.length > 2 && now - d.samples[0]![0] > VELOCITY_WINDOW_MS) d.samples.shift();
    setDragHeight(Math.min(heights.full, Math.max(heights.peek * 0.6, d.startHeight + (d.startY - event.clientY))));
  }, [heights]);

  const end = useCallback(() => {
    const d = drag.current;
    if (d === null) return;
    drag.current = null;
    const [t0, y0] = d.samples[0]!;
    const [t1, y1] = d.samples[d.samples.length - 1]!;
    const velocity = t1 > t0 ? (y0 - y1) / (t1 - t0) : 0; // up = sheet growing = positive
    const height = dragHeight ?? heights[snap];
    setDragHeight(null);
    onSnapChange(settleSnap(height, velocity, heights, snap));
    // Let the synthesised click that follows this pointerup see `moved.current`
    // still true (it fires synchronously, before this timeout), then clear it
    // so a later keyboard activation of the grip isn't swallowed forever.
    if (movedReset.current !== null) clearTimeout(movedReset.current);
    movedReset.current = setTimeout(() => { moved.current = false; }, 0);
  }, [dragHeight, heights, snap, onSnapChange]);

  // A downward drag at the top of a full, scrolled-to-top list collapses the sheet.
  const bodyDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (snap !== "full" || (bodyRef.current?.scrollTop ?? 0) > 0) return;
    begin(event);
  }, [snap, begin]);

  const height = dragHeight ?? heights[snap];
  const className = ["sheet", "glass", snap === "full" && dragHeight === null ? "sheet--full" : "", dragHeight !== null ? "sheet--dragging" : "sheet--settling"].filter(Boolean).join(" ");
  const toggle = useCallback(() => {
    // A click synthesised at the end of a drag is not a tap -- the drag's own
    // pointerup already called `end` and settled the sheet where it belongs.
    if (moved.current) return;
    // `"full"` spelled out: this was `stepSnap("half", "up")`, which is the same
    // value by a longer route -- and reads as though the step depended on where
    // the sheet is, which it does not. The grip toggles the two ends.
    onSnapChange(snap === "full" ? "peek" : "full");
  }, [snap, onSnapChange]);

  return (
    <section className={className} style={{ height }} data-testid="sheet" data-snap={snap}>
      <button type="button" className="sheet__grip" aria-expanded={snap === "full"} aria-label={snap === "full" ? s.collapseList : s.expandList}
        onClick={toggle} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
      <div className="sheet__header" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>{header}</div>
      <div className="sheet__body" ref={bodyRef} onPointerDown={bodyDown} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>{children}</div>
    </section>
  );
}
