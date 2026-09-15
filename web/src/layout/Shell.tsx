/**
 * The app's responsive frame: a full-bleed map with either a bottom sheet
 * (phone) or a side panel plus floating controls (desktop) laid over it.
 * `Shell` itself holds no layout logic beyond that single branch --
 * `useIsDesktop` is the one place that decides which breakpoint the app is
 * in, so every other component can just be handed the right children.
 */
import type { ReactNode } from "react";
import type { Lang } from "../i18n";
import { BottomSheet } from "./BottomSheet";
import { SidePanel } from "./SidePanel";
import type { Snap } from "./sheet";
import { DESKTOP_QUERY, useMediaQuery } from "./useMediaQuery";

export const useIsDesktop = (): boolean => useMediaQuery(DESKTOP_QUERY);

export interface ShellProps {
  map: ReactNode;
  /** Phone only: the top bar with search, locate and language controls. */
  topBar: ReactNode;
  /** Desktop only: the same controls, floated over the map instead. */
  floatControls: ReactNode;
  header: ReactNode;
  children: ReactNode;
  snap: Snap;
  onSnapChange: (s: Snap) => void;
  lang: Lang;
  /** e.g. the map hint, positioned above everything but below the sheet/panel. */
  overlay?: ReactNode;
}

export function Shell({ map, topBar, floatControls, header, children, snap, onSnapChange, lang, overlay }: ShellProps) {
  const desktop = useIsDesktop();
  return (
    <div className="app-shell" data-layout={desktop ? "desktop" : "phone"}>
      <div className="map-stage">{map}</div>
      {overlay}
      {desktop ? (
        <>
          <div className="float-controls">{floatControls}</div>
          <SidePanel header={header}>{children}</SidePanel>
        </>
      ) : (
        <>
          {topBar}
          <BottomSheet snap={snap} onSnapChange={onSnapChange} header={header} lang={lang}>{children}</BottomSheet>
        </>
      )}
    </div>
  );
}
