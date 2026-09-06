/**
 * The arrival-time scrubber: "when will I get there?", as one drag.
 *
 * This replaces the horizon `<select>` because the grid already holds every
 * horizon. Changing arrival time costs no request and no recompute of anything
 * upstream -- it is a re-read of a column that is already in memory -- so the
 * control should let the user *sweep* the city rather than commit to a value.
 * A native select on a phone is a modal wheel: it hides the map behind an
 * overlay, shows one value at a time, and answers only after it is dismissed.
 * A range input keeps the map on screen and repaints under the thumb, which is
 * the only way the shape of the forecast (this district fills up at 18:30, that
 * one does not) is visible at all.
 *
 * Two things it deliberately does *not* do.
 *
 *   - **It does not know about the artifact's age.** The value it reports is
 *     the driver's arrival time, minutes from now, exactly as they set it.
 *     `App` adds the age of the reading before indexing the grid, and that is
 *     the single place in the app where that correction happens. A second one
 *     here would double-count it, which is a subtler bug than omitting it.
 *   - **It does not invent its own range.** `stepMin` and `count` come from the
 *     grid's own header, so a grid rebuilt at a different resolution moves the
 *     control with it instead of leaving the far end pointing at a column that
 *     does not exist.
 */
import { useId } from "react";
import { t, type Lang } from "../i18n";

export interface ScrubberProps {
  /** The chosen arrival time in minutes from *now*. Never a grid column index. */
  value: number;
  /** Spacing between the grid's horizons, `grid.stepMin`. */
  stepMin: number;
  /** How many horizons the grid holds, `grid.nHorizons`. */
  count: number;
  /** Called with the new arrival time, in minutes from now. */
  onChange: (arrivalMin: number) => void;
  lang: Lang;
}

export function Scrubber({ value, stepMin, count, onChange, lang }: ScrubberProps) {
  const s = t(lang);
  // Generated rather than hardcoded: an id that collides silently re-points a
  // label at the wrong control, and a wrong label is worse than none.
  const id = useId();
  const reading = `${value} ${s.minutesUnit}`;

  return (
    <div className="scrubber">
      <div className="scrubber-head">
        <label htmlFor={id}>{s.arrivingIn}</label>
        <output htmlFor={id} className="scrubber-value">
          {reading}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={stepMin}
        max={stepMin * count}
        step={stepMin}
        value={value}
        // A screen reader would otherwise announce a bare "45", which in a
        // parking app could as easily be a price or a distance.
        aria-valuetext={reading}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
