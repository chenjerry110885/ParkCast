/**
 * The ranked list. Presentational: the caller has already ranked and sliced.
 *
 * An ordered list rather than a stack of divs, because the order *is* the
 * content -- a screen reader announcing "list item 1 of 20" is telling the user
 * the same thing the visual order tells everyone else.
 */
import type { Lang } from "../i18n";
import type { Ranked } from "../rank";
import { LotRow } from "./LotRow";

interface LotListProps {
  rows: readonly Ranked[];
  lang: Lang;
}

export function LotList({ rows, lang }: LotListProps) {
  return (
    <ol className="lots" data-testid="lot-list">
      {rows.map((row) => (
        <LotRow key={row.id} row={row} lang={lang} />
      ))}
    </ol>
  );
}
