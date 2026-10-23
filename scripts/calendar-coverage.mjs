/**
 * The release gate on the holiday calendar's remaining lifetime.
 *
 * `web/src/holidaysTw.json` covers whole years and ends on a fixed date. Past
 * it, the app quietly stops knowing about holidays: no wrong number, but no
 * holiday slot, no holiday fare and no notice either -- a regression nothing on
 * screen would announce. So a release is refused while the file ends within
 * `MIN_DAYS_AHEAD` days. The government publishes the next year's calendar
 * around June, so in practice this fails only if nobody has run
 * `scripts/build-calendar.py` for a year that was already available.
 */
export const MIN_DAYS_AHEAD = 60;

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of `now` in Taipei, the calendar's own zone. */
function taipeiDay(now) {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** A sentence saying what to do, or `null` when the calendar runs far enough. */
export function calendarCoverageProblem(coversEnd, now = new Date()) {
  const today = Date.parse(`${taipeiDay(now)}T00:00:00Z`);
  const last = Date.parse(`${coversEnd}T00:00:00Z`);
  const daysLeft = Math.round((last - today) / DAY_MS);
  if (daysLeft >= MIN_DAYS_AHEAD) return null;
  return (
    `web/src/holidaysTw.json covers holidays only through ${coversEnd}, ${daysLeft} days from now ` +
    `(at least ${MIN_DAYS_AHEAD} are required). Download the next year's 中華民國政府行政機關辦公日曆表 ` +
    `(data.gov.tw dataset 14718) and run scripts/build-calendar.py with every year's CSV.`
  );
}
