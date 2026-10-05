/**
 * The arrival picker: "when will I get there?", as a day, an hour and a
 * minute a driver actually chooses -- not a horizon dragged on a slider.
 *
 * This replaces `ArrivalStrip`, the chip strip that answered two complaints
 * verbatim from real users: capping the choice at two hours ahead ("limiting
 * the prediction to two hours is weird"), and a scrolling chip row that
 * dragged like a slider on desktop when a driver expected two ordinary
 * dropdowns. Three native `<select>`s fix both: every phone already renders
 * one as a wheel, they are keyboard- and screen-reader-complete for free, and
 * a `<select>` cannot be dragged into changing its own value -- there is no
 * pointer gesture left to reintroduce the sweep.
 *
 * The one rule this file exists to enforce (see the project's Task 9 ruling
 * R10): **it must be impossible to select a time in the past, or beyond
 * `MAX_LEAD_SEC`.** `dayOptions` hands back entries as far as "today" even
 * when today has no time left in it (23:58 Taipei, say), and the same is true
 * one level down -- 14:30 plus hour 09 is a past time every day, not an edge
 * case. So every list here is filtered against the live `[lowerBound,
 * upperBound]` window before it reaches a `<select>`, rather than offered in
 * full and clamped after the fact: a control that can only ever answer
 * `onChange` with something already inside the window has no "then it got
 * rewritten" step for a user to notice.
 *
 * The component holds no state of its own. `value` (an absolute Unix
 * second) and `nowSec` are both props, so every render decomposes `value`
 * back into a day/hour/minute triple from scratch -- there is nothing to
 * fall out of sync with the parent's own clock tick or a refreshed
 * selection. `clampArrival` still runs once per commit, as the backstop the
 * project's brief asks for: the filtering above is what keeps a bad choice
 * from being offered in the first place, and the clamp is only insurance
 * against `value` itself having drifted (the clock ticked past it) between
 * renders.
 */
import { useRef, useState, type ChangeEvent } from "react";
import {
  MAX_LEAD_SEC, MIN_LEAD_SEC,
  ceilToStep, clampArrival, composeArrival, dayOptions, floorToStep, formatClock,
  hourOptions, minuteOptions, relativeMinutes, TIME_ZONE,
  type DayOption,
} from "../arrival";
import { fillTemplate, t, weekdayName, type Lang } from "../i18n";

export interface ArrivalPickerProps {
  /** The chosen arrival time, as a unix second -- never a horizon or an index. */
  value: number;
  /** The current time, used to bound the picker's options and render the lead time under the readout. */
  nowSec: number;
  /** Called with the newly chosen arrival time, in unix seconds. Always inside `[nowSec + MIN_LEAD_SEC, nowSec + MAX_LEAD_SEC]`. */
  onChange: (arrivalTs: number) => void;
  lang: Lang;
}

/** `HH:MM` (Taipei) → a day → date-string map key, so a day `<select>`'s options can be matched against `value` without redoing `arrival.ts`'s own Taipei-midnight arithmetic here. */
const dateKeyFormat = new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE,
});

function dateKey(ts: number): string {
  return dateKeyFormat.format(new Date(ts * 1000));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayLabel(day: DayOption, s: ReturnType<typeof t>, lang: Lang): string {
  if (day.kind === "today") return s.dayToday;
  if (day.kind === "tomorrow") return s.dayTomorrow;
  return weekdayName(day.weekday, lang);
}

/** Whether calendar day `day` has any minute left inside `[lower, upper]` at all. */
function dayInRange(day: DayOption, lower: number, upper: number): boolean {
  return composeArrival(day.daySec, 23, 55) >= lower && day.daySec <= upper;
}

/** Every hour of `daySec` (Taipei) with at least one selectable minute inside `[lower, upper]`. */
function hoursInRange(daySec: number, lower: number, upper: number): number[] {
  return hourOptions().filter((h) => composeArrival(daySec, h, 55) >= lower && composeArrival(daySec, h, 0) <= upper);
}

/** Every 5-minute mark of `daySec`+`hour` (Taipei) that composes to a time inside `[lower, upper]`. */
function minutesInRange(daySec: number, hour: number, lower: number, upper: number): number[] {
  return minuteOptions().filter((m) => {
    const ts = composeArrival(daySec, hour, m);
    return ts >= lower && ts <= upper;
  });
}

export function ArrivalPicker({ value, nowSec, onChange, lang }: ArrivalPickerProps) {
  const s = t(lang);

  // The live window: never earlier than the nearest arrival the app will
  // answer for, never later than what `week.bin` can honestly speak to (see
  // `MAX_LEAD_SEC`'s own comment in `arrival.ts`). Recomputed every render,
  // so it walks forward with `nowSec` on its own -- nothing here caches a
  // window from a render ago.
  const lowerBound = ceilToStep(nowSec + MIN_LEAD_SEC);
  // FLOORED onto the 5-minute clock, like `lowerBound` above, and floored
  // rather than rounded so the window never reaches past the seven days it is
  // the ceiling of.
  //
  // It mattered the moment the chips became cumulative. Nothing could land on
  // this bound before -- the old chips computed `now + 1h` at most -- so an
  // unsnapped `now + 7 days` was merely a limit no selection ever equalled.
  // Pressing repeatedly walks straight into it, and then the readout showed
  // 09:29 while the selects under it showed 09:00: two different arrival times
  // on one screen, one of them a number no control could produce.
  const upperBound = floorToStep(nowSec + MAX_LEAD_SEC);
  const bounds = { min: lowerBound, max: upperBound };

  // `clampArrival` here is the backstop, not the mechanism: `value` is only
  // ever produced by this component's own `commit`, already inside bounds --
  // except across the one render where `nowSec` has ticked forward but the
  // parent has not yet written the correction back (see `App.tsx`'s own
  // effect). A stale `value` is shown, and would be committed, as the
  // nearest still-selectable time instead of the one the clock has already
  // passed.
  /**
   * Which chip was last pressed, and a key that changes on every press.
   *
   * Presentational only: the arrival itself is the caller's state, and this
   * never feeds back into it. It exists because a ripple has to replay on a
   * repeated press of the SAME chip, and React replays a CSS animation only
   * when the element is new.
   */
  const [pressed, setPressed] = useState<{ key: number; deltaSec: number } | null>(null);
  const pressKey = useRef(0);

  const shown = clampArrival(value, bounds);
  const [hour, minute] = formatClock(shown).split(":").map(Number) as [number, number];

  const days = dayOptions(nowSec).filter((d) => dayInRange(d, lowerBound, upperBound));
  const today = dateKey(shown);
  const selectedDay = days.find((d) => dateKey(d.daySec) === today) ?? days[0]!;
  const hours = hoursInRange(selectedDay.daySec, lowerBound, upperBound);
  const minutes = minutesInRange(selectedDay.daySec, hour, lowerBound, upperBound);

  function commit(daySec: number, h: number, m: number) {
    onChange(clampArrival(composeArrival(daySec, h, m), bounds));
  }

  function onDayChange(e: ChangeEvent<HTMLSelectElement>) {
    const daySec = Number(e.target.value);
    const validHours = hoursInRange(daySec, lowerBound, upperBound);
    const nextHour = validHours.includes(hour) ? hour : validHours[0]!;
    const validMinutes = minutesInRange(daySec, nextHour, lowerBound, upperBound);
    const nextMinute = validMinutes.includes(minute) ? minute : validMinutes[0]!;
    commit(daySec, nextHour, nextMinute);
  }

  function onHourChange(e: ChangeEvent<HTMLSelectElement>) {
    const h = Number(e.target.value);
    const validMinutes = minutesInRange(selectedDay.daySec, h, lowerBound, upperBound);
    const nextMinute = validMinutes.includes(minute) ? minute : validMinutes[0]!;
    commit(selectedDay.daySec, h, nextMinute);
  }

  function onMinuteChange(e: ChangeEvent<HTMLSelectElement>) {
    commit(selectedDay.daySec, hour, Number(e.target.value));
  }

  /**
   * `+15` / `+30` / `+1h`: an offset added to the arrival **already chosen**,
   * not a preset computed from `nowSec`.
   *
   * They are labelled as offsets, so they behave as offsets. A driver reaching
   * for half an hour out presses `+15` twice rather than working out which
   * single chip lands there, and a row of three increments covers every time in
   * the window by repetition. Computed from `nowSec` instead -- which is what
   * this did -- the second press of a chip recomputed the same answer and the
   * screen did not move, which reads as a dropped tap rather than as a design.
   *
   * Still snapped onto the 5-minute clock and still clamped into the window, so
   * repeated pressing saturates at the far end instead of running away; `atMax`
   * below is what stops a saturated chip from pretending it did something.
   */
  function bump(deltaSec: number) {
    return () => {
      // A new key on every press, so the ripple below REMOUNTS and its
      // animation restarts. Toggling a class instead would do nothing on the
      // second of two fast taps -- the class is already there and a running
      // animation does not replay -- which is exactly the case these chips are
      // being rebuilt for.
      setPressed({ key: pressKey.current++, deltaSec });
      onChange(clampArrival(ceilToStep(shown + deltaSec), bounds));
    };
  }

  /**
   * The way back. Nothing here subtracts -- three forward chips and no reverse
   * -- so overshooting by one tap would otherwise mean reaching for the selects.
   *
   * Not literally this instant: the app never promises a forecast for a time
   * already too close to trust, so `clampArrival` floors it to the nearest
   * arrival the picker offers at all (`MIN_LEAD_SEC`).
   */
  function resetToNow() {
    onChange(clampArrival(ceilToStep(nowSec), bounds));
  }

  /** Whether a chip has any room left, so a refused press is visible rather than silent. */
  function atMax(deltaSec: number) {
    return clampArrival(ceilToStep(shown + deltaSec), bounds) === shown;
  }

  return (
    <div className="arrival-picker">
      <div className="arrival-picker__readout">
        <span className="arrival-picker__label">{s.arrivalLabel}</span>
        {/* Keyed on the time itself, so the number springs whenever it moves --
            on a chip, on a select, on anything. The key is the value rather
            than a press counter deliberately: it reacts to the arrival
            CHANGING, not to a button being pressed, so a press that lands on
            the same minute (a saturated chip, a select set to what it already
            said) stays still rather than claiming something happened. */}
        <span key={shown} className="arrival-picker__time num" data-testid="arrival-time">
          {formatClock(shown)}
        </span>
        <span className="arrival-picker__relative">{fillTemplate(s.inMinutesTemplate, { n: relativeMinutes(shown, nowSec) })}</span>
      </div>

      {/*
        * Clicked, never dragged: each is a plain `<button type="button">`
        * with `onClick` alone -- no `onPointerDown`/`onPointerMove` pair for
        * a drag gesture to hook into, which is the strip's old sweep and the
        * thing this file must not bring back.
        */}
      <div className="arrival-picker__quick">
        <button type="button" className="qchip" onClick={resetToNow}>{s.quickNow}</button>
        {/* Each judged on its own room, never as a row: half an hour from the
            ceiling `+15` can still move and `+1h` cannot, and disabling them
            together would refuse a press that is perfectly valid. */}
        {([[15, s.quickPlus15], [30, s.quickPlus30], [60, s.quickPlus1h]] as const).map(
          ([mins, label]) => (
            <button
              key={mins}
              type="button"
              className="qchip qchip--bump"
              onClick={bump(mins * 60)}
              disabled={atMax(mins * 60)}
            >
              {label}
              {/* Keyed, so a second press of the same chip replays it. Rendered
                  only inside the chip that was pressed, and `aria-hidden`
                  because it says nothing a screen reader has not already been
                  told by the readout's own change. */}
              {pressed?.deltaSec === mins * 60 && (
                <span key={pressed.key} className="qchip__ripple" aria-hidden="true" />
              )}
            </button>
          ),
        )}
      </div>

      <div className="arrival-picker__fields">
        <div className="arrival-picker__field">
          <label className="visually-hidden" htmlFor="arrival-picker-day">{s.pickerDay}</label>
          <select
            id="arrival-picker-day" className="arrival-picker__select"
            value={String(selectedDay.daySec)} onChange={onDayChange}
          >
            {days.map((d) => (
              <option key={d.daySec} value={d.daySec}>{dayLabel(d, s, lang)}</option>
            ))}
          </select>
        </div>
        <div className="arrival-picker__field">
          <label className="visually-hidden" htmlFor="arrival-picker-hour">{s.pickerHour}</label>
          <select
            id="arrival-picker-hour" className="arrival-picker__select num"
            value={String(hour)} onChange={onHourChange}
          >
            {hours.map((h) => (
              <option key={h} value={h}>{pad2(h)}</option>
            ))}
          </select>
        </div>
        <div className="arrival-picker__field">
          <label className="visually-hidden" htmlFor="arrival-picker-minute">{s.pickerMinute}</label>
          <select
            id="arrival-picker-minute" className="arrival-picker__select num"
            value={String(minute)} onChange={onMinuteChange}
          >
            {minutes.map((m) => (
              <option key={m} value={m}>{pad2(m)}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
