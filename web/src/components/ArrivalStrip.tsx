/**
 * The arrival strip: "when will I get there?", as clock times you can read.
 *
 * This replaces the `Scrubber`'s minutes-from-now slider because a driver
 * does not think in horizons -- they think "I'll be there around 15:10", and
 * a range input answers in the wrong unit. The strip offers the grid's own
 * clock times as radio chips, so choosing an arrival is picking a time off a
 * shelf rather than converting one in your head.
 *
 * Two things it deliberately does *not* do, carried forward from the
 * scrubber it replaces.
 *
 *   - **It does not know about the artifact's age.** `value` and every entry
 *     in `options` are absolute unix times, exactly as chosen; the age of the
 *     reading behind the forecast lives in `arrival.ts`'s subtraction
 *     (`horizonFromReading`), not here. A strip that "helpfully" shifted its
 *     own times by that age would put a second conversion in the path and
 *     silently double-count it.
 *   - **It does not invent its own range.** `options` comes from the caller
 *     (`arrivalOptions`, bounded by what the grid actually covers), so a grid
 *     rebuilt at a different resolution or a stale reading moves the strip
 *     with it instead of offering a time the model never forecast.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { formatClock, relativeMinutes } from "../arrival";
import { fillTemplate, t, type Lang } from "../i18n";

export interface ArrivalStripProps {
  /** Every clock time (unix seconds) the driver may pick, in order. */
  options: readonly number[];
  /** The chosen arrival time, as a unix second -- never a column index. */
  value: number;
  /** The current time, used only to render the lead time under the readout. */
  nowSec: number;
  /** Called with the newly chosen arrival time, in unix seconds. */
  onChange: (arrivalTs: number) => void;
  /**
   * Set when the reading behind the grid is too old for any arrival time to
   * have a forecast left -- `options` may still be non-empty, but showing
   * chips for it would be a lie about what the grid can answer.
   */
  expired: boolean;
  lang: Lang;
}

export function ArrivalStrip({ options, value, nowSec, onChange, expired, lang }: ArrivalStripProps) {
  const s = t(lang);
  const stripRef = useRef<HTMLDivElement>(null);
  const show = !expired && options.length > 0;

  // Keep the selected chip in view -- and, if focus was already inside the strip
  // (an arrow key just moved the selection), move focus with it, so a screen reader
  // announces the new chip. A click elsewhere or a programmatic `value` change (a
  // refresh) must never steal focus, hence the `contains` guard.
  useEffect(() => {
    const checked = stripRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    checked?.scrollIntoView?.({ block: "nearest", inline: "center" });
    if (checked && stripRef.current?.contains(document.activeElement)) checked.focus();
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = options[Math.min(options.length - 1, Math.max(0, index + delta))];
    if (next !== undefined) onChange(next);
  }


  return (
    <div className="arrival">
      <div className="arrival__readout">
        <span className="arrival__label">{s.arrivalLabel}</span>
        <span className="arrival__time num" data-testid="arrival-time">{show ? formatClock(value) : "—"}</span>
        {show && <span className="arrival__relative">{fillTemplate(s.inMinutesTemplate, { n: relativeMinutes(value, nowSec) })}</span>}
      </div>
      {/* The scroller and the radio group are two elements, not one: the tail
          below is a sentence about what lies past the last chip, and a non-radio
          child of a `radiogroup` is a child assistive tech has to guess at. It
          still scrolls with the chips, because the scroller is the wrapper. */}
      <div className="arrival__strip" ref={stripRef}>
        <div className="arrival__chips" role="radiogroup" aria-label={s.arrivalGroupLabel}>
          {show && options.map((ts, index) => (
            <button key={ts} type="button" role="radio" aria-checked={ts === value} className="chip" data-ts={ts}
              tabIndex={ts === value ? 0 : -1} onClick={() => onChange(ts)} onKeyDown={(e) => onKeyDown(e, index)}>
              {formatClock(ts)}
            </button>
          ))}
        </div>
        <span className="arrival__tail">{s.noForecastBeyond}</span>
      </div>
    </div>
  );
}
