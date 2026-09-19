/**
 * The two filter chips over the ranked list: 機車 and 充電.
 *
 * Toggle buttons rather than checkboxes, for the same reason `ArrivalPicker`'s
 * quick chips are buttons: they are pressed with a thumb on a map screen, and
 * `aria-pressed` says everything a checkbox's role would have said without
 * needing a visible label beside a 16-px box. Each chip is its own 44-px tap
 * target (spec §2) and nothing here animates at rest.
 *
 * Presentational and controlled: the active list lives in `App`, because the
 * ranking, the hidden tally and the map's dimming all read it and none of them
 * could read it from here. The predicate itself lives in `../amenities`, so
 * what the chip means and what the list does are one definition.
 *
 * Which chips exist is decided the same way, one layer up: `available` is
 * `answerable(lots)`, and a question the roster on hand cannot answer is not
 * put. See `AmenityFiltersProps.available`.
 */
import { AMENITIES, type Amenity } from "../amenities";
import { Charging, Scooter } from "../icons";
import { t, type Lang } from "../i18n";

export interface AmenityFiltersProps {
  /** The amenities currently filtered on. Empty is the unfiltered screen. */
  active: readonly Amenity[];
  /**
   * The amenities the loaded roster can answer about -- `answerable` in
   * `../amenities`. A chip no car park in the roster reports is not drawn at
   * all, and when neither is, this row is not drawn either: a group with no
   * controls in it is a heading over nothing, and a disabled chip is still a
   * 44 px target advertising an answer the data cannot give.
   */
  available: readonly Amenity[];
  onToggle: (amenity: Amenity) => void;
  lang: Lang;
}

export function AmenityFilters({ active, available, onToggle, lang }: AmenityFiltersProps) {
  const s = t(lang);
  const shown = AMENITIES.filter((amenity) => available.includes(amenity));
  if (shown.length === 0) return null;
  return (
    <div className="filters" role="group" aria-label={s.filtersLabel} data-testid="amenity-filters">
      {shown.map((amenity) => {
        const scooter = amenity === "scooter";
        const Glyph = scooter ? Scooter : Charging;
        return (
          <button
            key={amenity}
            type="button"
            className="fchip"
            data-testid={`filter-${amenity}`}
            aria-pressed={active.includes(amenity)}
            onClick={() => onToggle(amenity)}
          >
            <Glyph className="fchip__icon" />
            {scooter ? s.filterScooter : s.filterCharging}
          </button>
        );
      })}
    </div>
  );
}
