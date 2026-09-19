/**
 * Which way the driver wants the ranking to lean: cheaper, balanced, closer.
 *
 * It sits with `ArrivalPicker` rather than over the list, because the two
 * answer the same kind of question -- *what am I asking for* -- against the
 * list's *here is what we found*. "I arrive at 18:35" and "I would rather walk
 * less" are both parts of the request; the order the cards come back in is the
 * answer to it.
 *
 * **Native radios, for the reason `ArrivalPicker` chose native `<select>`s.**
 * Exactly one of three is a radio group, and saying so in markup buys the whole
 * of the behaviour for free: arrow keys move within the group, the browser
 * keeps one and only one chosen, and a screen reader reads "Closer, radio
 * button, 3 of 3, selected" without a line of code here. The alternative on
 * offer -- three `aria-pressed` buttons with a roving `tabindex`, the shape
 * `AmenityFilters` uses -- is right there because those chips are two
 * *independent* switches; this is one choice among three, and hand-rolling the
 * keyboard model for it would be re-implementing something the platform
 * already gets right.
 *
 * Each input is visually hidden inside its own `<label>`, so the visible chip
 * *is* the tap target (≥ 44 px) and the label's text *is* the accessible name.
 * The selected look is drawn by `.pchip:has(input:checked)` and the focus ring
 * by `.pchip:has(input:focus-visible)` -- keyed on the same checkedness a
 * screen reader reports, the way `.fchip[aria-pressed="true"]` is, so the two
 * cannot drift apart.
 *
 * **The score is never shown here, or anywhere.** `rankLots` prices this choice
 * in NT$ and that number is a sort key; this control names a preference and
 * carries no figure at all. The copy is comparative for the matching reason:
 * availability still leads under all three presets, so "Cheaper" describes a
 * lean and "cheapest" would be a promise the ranker does not keep. See
 * `Preference` in `../rank` and the `preference*` strings in `../i18n`.
 *
 * Presentational and controlled: the chosen preference lives in `App`, because
 * the ranking reads it and `localStorage` remembers it, and neither of those
 * could reach it from in here.
 */
import { useId } from "react";
import { t, type Lang, type Strings } from "../i18n";
import type { Preference } from "../rank";

/**
 * The three options, left to right, each with the string that names it.
 *
 * A spectrum rather than a menu: pay less on one end, walk less on the other,
 * the shipped weighting between them. That ordering is a design decision and so
 * it is written here rather than read off `PREFERENCES`, whose key order is an
 * implementation detail -- but `tests/preferencePicker.test.tsx` checks this
 * list against that table, so a fourth preset cannot join the ranker and
 * quietly have no control.
 */
const OPTIONS: readonly { preference: Preference; key: keyof Strings }[] = [
  { preference: "cheaper", key: "preferenceCheaper" },
  { preference: "balanced", key: "preferenceBalanced" },
  { preference: "closer", key: "preferenceCloser" },
];

export interface PreferencePickerProps {
  /** The preference in force. `App` owns it; this component holds no state. */
  value: Preference;
  /** Called with the newly chosen preference. Never called with the one already in force. */
  onChange: (preference: Preference) => void;
  lang: Lang;
}

export function PreferencePicker({ value, onChange, lang }: PreferencePickerProps) {
  const s = t(lang);
  // Generated, not hardcoded, for the same reason `PlaceSearch` generates its
  // ids: a colliding `name` would fuse this group with another radio group on
  // the page, and a colliding label id would point the group's accessible name
  // at whatever claimed it first.
  const id = useId();
  const labelId = `${id}-label`;

  return (
    <div className="preference" data-testid="preference-picker">
      <span className="preference__label" id={labelId}>{s.preferenceLabel}</span>
      <div className="preference__options" role="radiogroup" aria-labelledby={labelId}>
        {OPTIONS.map(({ preference, key }) => (
          <label key={preference} className="pchip" data-testid={`preference-${preference}`}>
            <input
              type="radio"
              className="visually-hidden"
              name={id}
              value={preference}
              checked={preference === value}
              onChange={() => onChange(preference)}
            />
            <span className="pchip__text">{s[key]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
