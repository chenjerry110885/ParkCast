/**
 * The ranked list. Presentational: the caller has already ranked and sliced.
 *
 * An ordered list rather than a stack of divs, because the order *is* the
 * content -- a screen reader announcing "list item 1 of 20" is telling the
 * user the same thing the visual order tells everyone else.
 *
 * Reordering is FLIP-animated: a re-ranked card glides to its new slot
 * instead of teleporting there, via `motion.measureRects`/`flipMove`, keyed
 * by lot id so a card's identity survives the reorder rather than being
 * decided by array position.
 */
import { memo, useLayoutEffect, useRef } from "react";
import type { Lang } from "../i18n";
import { DURATION, flipMove, measureRects, type Corner } from "../motion";
import type { Ranked } from "../rank";
import { LotCard } from "./LotCard";

export interface LotListProps {
  rows: readonly Ranked[];
  lang: Lang;
  /** `grid.baseDataTs`, which each card measures a stalled feed to. */
  baseDataTs: number;
  /** Minutes since `baseDataTs`, for each card's observed-count tile. */
  ageMin: number;
  /** The clock time the list was ranked for. */
  arrivalTs: number;
  /** Minutes from the reading to `arrivalTs`, for each card's confidence pill. */
  horizonFromReadingMin: number;
  /** Id of the list's single top pick, or `null` when none applies. */
  bestId: string | null;
  /** Id of the card currently selected on the map, or `null`. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Passed straight to each card: the id the pointer entered, or `null` on leave. */
  onHover?: (id: string | null) => void;
}

function LotListInner({
  rows,
  lang,
  baseDataTs,
  ageMin,
  arrivalTs,
  horizonFromReadingMin,
  bestId,
  selectedId,
  onSelect,
  onHover,
}: LotListProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const previous = useRef<Map<string, Corner>>(new Map());
  const order = useRef("");

  // FLIP, under two conditions the first version of this was missing -- both of
  // which showed up as cards sliding around under a mouse that was only
  // scrolling past them.
  //
  //   - **Only when the order actually changed.** This effect runs after every
  //     commit, and a commit is not the same thing as a reorder: hovering a card
  //     re-renders the list (the map's hover halo is driven from here), and
  //     replaying the move on a commit that moved nothing is how a pointer
  //     crossing the list came to drag it.
  //   - **Measured against the list, not the viewport.**
  //     `getBoundingClientRect` is viewport-relative, so scrolling between two
  //     commits shifts every stored rect by the scroll distance and the
  //     "correction" faithfully plays that distance back. Storing each card's
  //     offset *within* the list makes the measurement scroll-invariant; it is
  //     rebased onto the list's current origin at play time, which is the frame
  //     `flipMove` measures in.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const items = [...list.querySelectorAll<HTMLElement>("[data-lot-id]")].map(
      (el): [string, HTMLElement] => [el.dataset["lotId"] ?? "", el],
    );
    const ids = items.map(([id]) => id).join(",");
    // Not on the first commit: every card is new, there is nowhere to play from.
    const reordered = order.current !== "" && ids !== order.current;
    order.current = ids;

    // Measured *before* anything is played: `flipMove` puts a transform on the
    // element it animates, and `getBoundingClientRect` reports the transformed
    // box -- so measuring afterwards would store each card's old position as the
    // baseline for the next reorder.
    const origin = list.getBoundingClientRect();
    const current = new Map<string, Corner>();
    for (const [id, box] of measureRects(items)) {
      current.set(id, { left: box.left - origin.left, top: box.top - origin.top });
    }
    if (reordered) {
      for (const [id, el] of items) {
        const was = previous.current.get(id);
        flipMove(el, was && { left: was.left + origin.left, top: was.top + origin.top }, DURATION.base);
      }
    }
    previous.current = current;
  });

  return (
    <ol className="lots anim-stagger" data-testid="lot-list" ref={listRef}>
      {rows.map((row, index) => (
        <LotCard
          key={row.id}
          row={row}
          lang={lang}
          baseDataTs={baseDataTs}
          ageMin={ageMin}
          arrivalTs={arrivalTs}
          horizonFromReadingMin={horizonFromReadingMin}
          best={row.id === bestId}
          selected={row.id === selectedId}
          onSelect={onSelect}
          onHover={onHover}
          index={Math.min(index, 7)}
        />
      ))}
    </ol>
  );
}

/**
 * Memoised, because `App` re-renders on every hover: the hovered lot id lives up
 * there (the map needs it), and without this each mouse move across the list
 * re-rendered all twenty-five cards and re-ran the layout effect above.
 */
export const LotList = memo(LotListInner);
