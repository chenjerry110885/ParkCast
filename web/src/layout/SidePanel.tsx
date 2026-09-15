/**
 * The desktop layout's results surface: a fixed-width panel pinned to the
 * left edge instead of the phone's draggable bottom sheet. Desktop has room
 * for both the map and a permanently visible list, so there is no snapping
 * to do here -- `Shell` picks this over `BottomSheet` once `useIsDesktop`
 * says so, and the two share nothing but the `header`/`children` shape.
 */
import type { ReactNode } from "react";

export function SidePanel({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <aside className="panel glass" data-testid="panel">
      <div className="panel__header">{header}</div>
      <div className="panel__body">{children}</div>
    </aside>
  );
}
