/**
 * A car park's typical week, on its selected card: one row per day, one cell
 * per hour, coloured by the usual chance of a space.
 *
 * It is the climatology the app already forecasts from past the grid's window,
 * drawn whole. The cells use `colourFor`, the map's own ramp, so a lot that is
 * red on the map at 18:00 is red here at 18:00 and an unknown hour is the
 * map's one grey -- never a shade that reads as "full".
 *
 * A screen reader gets the chart as one image whose name is the summary line,
 * not 168 unlabelled cells.
 */
import { useMemo } from "react";
import { fillTemplate, t, weekdayName, type Lang } from "../i18n";
import { colourFor } from "../map/colour";
import type { WeekTable } from "../types";
import { busiestWindow, profileRows, type ProfileDay } from "../weekProfile";

/** `Date#getDay()` index of each clock day, for `weekdayName`. */
const WEEKDAY_INDEX: Record<Exclude<ProfileDay, "holiday">, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** The day's full name: "Saturday", "週六", or "public holidays". */
function dayName(day: ProfileDay, lang: Lang): string {
  return day === "holiday" ? t(lang).weekProfileHolidays : weekdayName(WEEKDAY_INDEX[day], lang);
}

/**
 * The day column's label. English names cut to their standard three-letter
 * forms (every one of the seven is its own first three letters); the Chinese
 * "週一" is already two characters.
 */
function dayLabel(day: ProfileDay, lang: Lang): string {
  if (day === "holiday") return t(lang).weekProfileHolidayShort;
  const name = dayName(day, lang);
  return lang === "en" ? name.slice(0, 3) : name;
}

const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

export interface WeekProfileProps {
  table: WeekTable;
  /** The lot's grid row, `Lot.i`: the same index every `week.bin` lookup uses. */
  lotIndex: number;
  lang: Lang;
}

export function WeekProfile({ table, lotIndex, lang }: WeekProfileProps) {
  const s = t(lang);
  const rows = useMemo(() => profileRows(table, lotIndex), [table, lotIndex]);
  const busy = useMemo(() => busiestWindow(rows), [rows]);
  const summary =
    busy === null
      ? s.weekProfileRoomy
      : fillTemplate(s.weekProfileBusiestTemplate, {
          day: dayName(busy.day, lang),
          start: clock(busy.startHour),
          end: clock(busy.endHour),
        });
  return (
    <figure className="week-profile" data-testid="week-profile">
      <figcaption className="week-profile__caption">
        <b>{s.weekProfileTitle}</b> · {summary}
      </figcaption>
      <div className="week-profile__chart" role="img" aria-label={`${s.weekProfileTitle}: ${summary}`}>
        {rows.map((r) => (
          <div className="week-profile__row" key={r.day} data-testid="week-profile-row" aria-hidden="true">
            <span className="week-profile__day">{dayLabel(r.day, lang)}</span>
            {r.hours.map((p, h) => (
              <span
                key={h}
                className={
                  busy !== null && busy.day === r.day && h >= busy.startHour && h < busy.endHour
                    ? "week-profile__cell week-profile__cell--busy"
                    : "week-profile__cell"
                }
                style={{ background: colourFor(p) }}
              />
            ))}
          </div>
        ))}
        <div className="week-profile__axis" aria-hidden="true">
          <span />
          {[0, 6, 12, 18].map((h) => (
            <span key={h} style={{ gridColumn: `${h + 2} / span 6` }}>
              {h}
            </span>
          ))}
        </div>
      </div>
      <div className="week-profile__legend" aria-hidden="true">
        <span>{s.weekProfileFull}</span>
        <span className="week-profile__ramp" style={{ background: `linear-gradient(to right, ${colourFor(0)}, ${colourFor(0.35)}, ${colourFor(0.7)}, ${colourFor(1)})` }} />
        <span>{s.weekProfileFree}</span>
      </div>
    </figure>
  );
}
