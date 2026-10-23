import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_DAYS_AHEAD, calendarCoverageProblem } from "../calendar-coverage.mjs";

// Taipei noon on a given day, as a Date: the gate reads Taipei's date, and
// noon keeps the arithmetic clear of either midnight.
const taipeiNoon = (iso) => new Date(`${iso}T12:00:00+08:00`);

test("passes a calendar that runs well past the window", () => {
  assert.equal(calendarCoverageProblem("2027-12-31", taipeiNoon("2026-10-23")), null);
});

test("fails a calendar that ends inside the window", () => {
  // The arrival picker reaches seven days out and a release lives for weeks, so
  // a calendar that runs out inside the window would quietly stop knowing about
  // holidays between two releases -- with nothing on screen to say so.
  const problem = calendarCoverageProblem("2027-12-31", taipeiNoon("2027-11-15"));
  assert.match(problem, /holidaysTw\.json/);
  assert.match(problem, /2027-12-31/);
  assert.match(problem, /build-calendar\.py/);
});

test("the boundary is exactly MIN_DAYS_AHEAD days", () => {
  assert.equal(MIN_DAYS_AHEAD, 60);
  // 2027-11-01 + 60 days = 2027-12-31: covered to the day, so it passes...
  assert.equal(calendarCoverageProblem("2027-12-31", taipeiNoon("2027-11-01")), null);
  // ...and one day later it does not.
  assert.notEqual(calendarCoverageProblem("2027-12-31", taipeiNoon("2027-11-02")), null);
});

test("reads Taipei's date, not UTC's", () => {
  // 2027-11-02 07:00 Taipei is still 2027-11-01 in UTC. Read in UTC this would
  // pass; read in Taipei -- the calendar's own zone -- it fails.
  assert.notEqual(
    calendarCoverageProblem("2027-12-31", new Date("2027-11-02T07:00:00+08:00")),
    null,
  );
});
