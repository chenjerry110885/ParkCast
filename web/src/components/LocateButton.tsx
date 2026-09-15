/**
 * The round button that kicks off `useGeolocation`'s `request`. The label
 * and `aria-busy`/`disabled` state track `geo` directly, so a screen reader
 * announces "Locating..." while the request is in flight and the button
 * cannot be double-tapped into a second, overlapping request.
 */
import { Locate } from "../icons";
import { t, type Lang } from "../i18n";
import type { GeoState } from "../useGeolocation";

export function LocateButton({ geo, onClick, lang }: { geo: GeoState; onClick: () => void; lang: Lang }) {
  const s = t(lang);
  const label = geo === "locating" ? s.locating : geo === "unavailable" ? s.locationUnavailable : s.useMyLocation;
  return (
    <button
      type="button"
      className={`round-btn glass${geo === "locating" ? " round-btn--locating" : ""}`}
      onClick={onClick}
      disabled={geo === "locating"}
      aria-busy={geo === "locating"}
      aria-label={label}
      title={label}
    >
      <Locate />
    </button>
  );
}
