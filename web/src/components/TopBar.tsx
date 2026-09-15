/**
 * The phone layout's floating header: the destination search box plus the
 * locate and language buttons, laid out in a single row over the map.
 * Purely structural -- `Shell` supplies `search`, `locate` and `lang` as
 * already-built elements, so this component owns none of their behaviour.
 */
import type { ReactNode } from "react";

export function TopBar({ search, locate, lang }: { search: ReactNode; locate: ReactNode; lang: ReactNode }) {
  return (
    <div className="topbar">
      <div className="topbar__search">{search}</div>
      {locate}
      {lang}
    </div>
  );
}
