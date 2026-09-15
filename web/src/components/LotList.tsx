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
import { useLayoutEffect, useRef } from "react";
import type { Lang } from "../i18n";
import { DURATION, flipMove, measureRects } from "../motion";
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

export function LotList({
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
  const previous = useRef<Map<string, DOMRect>>(new Map());

  // FLIP: measure before React commits the new order (the ref holds last commit's rects), play after.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const items = [...list.querySelectorAll<HTMLElement>("[data-lot-id]")].map(
      (el): [string, HTMLElement] => [el.dataset["lotId"] ?? "", el],
    );
    // Measured *before* anything is played: `flipMove` puts a transform on the
    // element it animates, and `getBoundingClientRect` reports the transformed
    // box -- so measuring afterwards would store each card's old position as the
    // baseline for the next reorder, and the one after this would play from the
    // wrong place. Measure the new layout, then play, then keep what was
    // measured.
    const current = measureRects(items);
    for (const [id, el] of items) flipMove(el, previous.current.get(id), DURATION.base);
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
