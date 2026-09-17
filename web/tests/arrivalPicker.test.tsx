import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LEAD_SEC, MIN_LEAD_SEC,
  ceilToStep, composeArrival, dayOptions, formatClock, relativeMinutes,
} from "../src/arrival";
import { ArrivalPicker } from "../src/components/ArrivalPicker";
import { fillTemplate, t } from "../src/i18n";

/** Taipei 2026-09-17 14:30:00, a Thursday -- squarely inside the day, on the 5-minute clock. */
const MIDDAY = 1789626600;
/** Taipei 2026-09-17 23:58:00, the same Thursday -- two minutes from midnight. */
const NEAR_MIDNIGHT = 1789660680;

/** The values a `<select>` currently offers, in document order. */
function optionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((o) => o.value);
}

function hourSelect(): HTMLSelectElement {
  return screen.getByLabelText(t("en").pickerHour) as HTMLSelectElement;
}
function minuteSelect(): HTMLSelectElement {
  return screen.getByLabelText(t("en").pickerMinute) as HTMLSelectElement;
}
function daySelect(): HTMLSelectElement {
  return screen.getByLabelText(t("en").pickerDay) as HTMLSelectElement;
}

/** A controlled wrapper, the way `App` actually drives the picker: `onChange` feeds back into `value`. */
function Controlled({ initial, nowSec }: { initial: number; nowSec: number }) {
  const [value, setValue] = useState(initial);
  return <ArrivalPicker value={value} nowSec={nowSec} onChange={setValue} lang="en" />;
}

afterEach(cleanup);

describe("quick chips", () => {
  it("set the arrival to now, +15, +30 and +1h, each rounded onto the 5-minute clock", () => {
    const onChange = vi.fn();
    render(<ArrivalPicker value={MIDDAY + 900} nowSec={MIDDAY} onChange={onChange} lang="en" />);

    // MIDDAY sits exactly on a 5-minute mark, so `ceilToStep` moves nothing
    // for +15/+30/+1h -- only "now" needs a nudge, and that nudge is the
    // MIN_LEAD_SEC floor, not `ceilToStep` rounding.
    fireEvent.click(screen.getByRole("button", { name: t("en").quickPlus15 }));
    expect(onChange).toHaveBeenLastCalledWith(MIDDAY + 15 * 60);
    fireEvent.click(screen.getByRole("button", { name: t("en").quickPlus30 }));
    expect(onChange).toHaveBeenLastCalledWith(MIDDAY + 30 * 60);
    fireEvent.click(screen.getByRole("button", { name: t("en").quickPlus1h }));
    expect(onChange).toHaveBeenLastCalledWith(MIDDAY + 60 * 60);

    // "Now" is not literally this instant -- the app never promises a
    // forecast for a time already too close to trust, so it floors to the
    // nearest arrival the picker will offer at all (`MIN_LEAD_SEC`).
    fireEvent.click(screen.getByRole("button", { name: t("en").quickNow }));
    expect(onChange).toHaveBeenLastCalledWith(ceilToStep(MIDDAY + MIN_LEAD_SEC));
  });

  it("does not change the selection when a pointer is dragged across the chips", () => {
    // The strip this replaces let a drag sweep across its chips change the
    // selection, which on desktop made a row of buttons act like a slider
    // nobody asked for. These are plain buttons with only an `onClick`, so a
    // pointer sequence with no actual click must change nothing.
    const onChange = vi.fn();
    render(<ArrivalPicker value={MIDDAY + 900} nowSec={MIDDAY} onChange={onChange} lang="en" />);
    const first = screen.getByRole("button", { name: t("en").quickNow });
    const last = screen.getByRole("button", { name: t("en").quickPlus1h });

    fireEvent.pointerDown(first, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerMove(last, { clientX: 300, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(last, { clientX: 300, clientY: 10, pointerId: 1 });

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("the day/hour/minute selects", () => {
  it("compose a time from the three selections, independent of the quick chips", () => {
    render(<Controlled initial={MIDDAY + 900} nowSec={MIDDAY} />);
    expect(screen.getByTestId("arrival-time").textContent).toBe("14:45"); // MIDDAY+15

    fireEvent.change(hourSelect(), { target: { value: "16" } });
    expect(screen.getByTestId("arrival-time").textContent).toBe("16:45");

    fireEvent.change(minuteSelect(), { target: { value: "10" } });
    expect(screen.getByTestId("arrival-time").textContent).toBe("16:10");
  });

  it("shows the readout's relative distance alongside the clock time", () => {
    render(<ArrivalPicker value={MIDDAY + 900} nowSec={MIDDAY} onChange={() => {}} lang="en" />);
    expect(screen.getByTestId("arrival-time").textContent).toBe(formatClock(MIDDAY + 900));
    expect(screen.getByText(fillTemplate(t("en").inMinutesTemplate, { n: relativeMinutes(MIDDAY + 900, MIDDAY) }))).toBeInTheDocument();
  });
});

/**
 * Ruling R10: it must be impossible to select a time in the past, or beyond
 * `MAX_LEAD_SEC`. Every test below would fail if a past or out-of-range
 * moment became reachable through any of the three selects -- not merely if
 * the picker looked wrong, since each assertion checks the actual `<option>`
 * values rendered, not just what happens to be selected.
 */
describe("R10 -- past and out-of-range times are never offered", () => {
  it("drops 'today' from the day select once today has no time left in it", () => {
    // 23:58 Taipei: `MIN_LEAD_SEC` pushes the nearest arrival into tomorrow,
    // so today must not appear at all -- not disabled, not present and
    // pointing nowhere, simply absent.
    render(<ArrivalPicker value={NEAR_MIDNIGHT} nowSec={NEAR_MIDNIGHT} onChange={() => {}} lang="en" />);
    const labels = Array.from(daySelect().options).map((o) => o.textContent);
    expect(labels).not.toContain(t("en").dayToday);
    expect(labels[0]).toBe(t("en").dayTomorrow);
    // 8 calendar days on offer (today..+7) minus the one just dropped.
    expect(labels).toHaveLength(7);
  });

  it("lands on the nearest still-selectable time when handed a value already in the past", () => {
    // `value` here (23:58) is itself the moment that just got excluded above.
    // A stale prop -- the clock ticked past the parent's own state one
    // render ago -- must render as the nearest valid time, not as itself.
    render(<ArrivalPicker value={NEAR_MIDNIGHT} nowSec={NEAR_MIDNIGHT} onChange={() => {}} lang="en" />);
    const lower = ceilToStep(NEAR_MIDNIGHT + MIN_LEAD_SEC);
    expect(screen.getByTestId("arrival-time").textContent).toBe(formatClock(lower));
    expect(daySelect().selectedOptions[0]?.textContent).toBe(t("en").dayTomorrow);
  });

  it("drops every hour of today whose every minute has already passed", () => {
    // 14:30, so the nearest offer is 14:35: hour 09 is entirely gone, hour 14
    // (this hour) survives because 14:35..14:55 are still ahead, and hour 23
    // is untouched.
    const lower = ceilToStep(MIDDAY + MIN_LEAD_SEC);
    render(<ArrivalPicker value={lower} nowSec={MIDDAY} onChange={() => {}} lang="en" />);
    const hours = optionValues(hourSelect());
    expect(hours).not.toContain("9");
    expect(hours).toContain("14");
    expect(hours).toContain("23");
  });

  it("drops every minute of the current hour that has already passed", () => {
    const lower = ceilToStep(MIDDAY + MIN_LEAD_SEC); // 14:35
    render(<ArrivalPicker value={lower} nowSec={MIDDAY} onChange={() => {}} lang="en" />);
    const minutes = optionValues(minuteSelect());
    for (const passed of ["0", "5", "10", "15", "20", "25", "30"]) expect(minutes).not.toContain(passed);
    for (const left of ["35", "40", "45", "50", "55"]) expect(minutes).toContain(left);
  });

  it("never offers a day beyond MAX_LEAD_SEC", () => {
    render(<ArrivalPicker value={MIDDAY + 900} nowSec={MIDDAY} onChange={() => {}} lang="en" />);
    const dayValues = optionValues(daySelect()).map(Number);
    expect(dayValues).toHaveLength(8); // today..+7, none excluded at 14:30
    const farthest = Math.max(...dayValues);
    // Independently computed from `dayOptions`, not from the component's own
    // filtering -- the oracle Task 8 already pinned.
    const expectedFarthest = dayOptions(MIDDAY).at(-1)!.daySec;
    expect(farthest).toBe(expectedFarthest);
    expect(farthest).toBeLessThanOrEqual(MIDDAY + MAX_LEAD_SEC);
  });

  it("drops every hour and minute of the farthest day that falls beyond MAX_LEAD_SEC", () => {
    // MAX_LEAD_SEC is a flat 7*24h, so at 14:30 the farthest reachable moment
    // is 14:30 on the farthest day, exactly on the 5-minute clock: hour 15
    // onward is entirely beyond the window, and within hour 14 only :00..:30
    // survive.
    const farthestDay = dayOptions(MIDDAY).at(-1)!.daySec;
    const value = composeArrival(farthestDay, 14, 0);
    render(<ArrivalPicker value={value} nowSec={MIDDAY} onChange={() => {}} lang="en" />);

    const hours = optionValues(hourSelect());
    expect(hours).toContain("14");
    expect(hours).not.toContain("15");
    expect(hours).not.toContain("23");

    const minutes = optionValues(minuteSelect());
    for (const left of ["0", "5", "10", "15", "20", "25", "30"]) expect(minutes).toContain(left);
    for (const beyond of ["35", "40", "45", "50", "55"]) expect(minutes).not.toContain(beyond);
  });

  it("snaps to the earliest still-valid hour and minute when the day changes out from under the old ones", () => {
    // Start on tomorrow at 09:00, then switch the day select back to today
    // (14:30 now): hour 09 no longer exists for today, so the picker must
    // land on today's own earliest offer (14:35) -- not keep the stale 09:00,
    // and not merely refuse the change.
    const today = dayOptions(MIDDAY)[0]!;
    const tomorrow = dayOptions(MIDDAY)[1]!;
    render(<Controlled initial={composeArrival(tomorrow.daySec, 9, 0)} nowSec={MIDDAY} />);
    expect(hourSelect().value).toBe("9");

    fireEvent.change(daySelect(), { target: { value: String(today.daySec) } });

    const lower = ceilToStep(MIDDAY + MIN_LEAD_SEC);
    expect(screen.getByTestId("arrival-time").textContent).toBe(formatClock(lower));
    expect(hourSelect().value).toBe("14");
    expect(minuteSelect().value).toBe("35");
  });

  it("snaps to the new day's own earliest offer, not to the global window's edge", () => {
    // A day-change snap and the `clampArrival` backstop can agree by
    // coincidence (switching to *today*, above, lands on the global lower
    // bound either way). This picks a case where they would not: starting at
    // 23:55 on a fully-open middle day, then switching to the farthest day,
    // which `MAX_LEAD_SEC` only leaves open through 14:30. A day-aware snap
    // lands on that day's own first offer, 00:00 -- keeping 23:55's minute,
    // since hour 0 has every minute free. A bare backstop clamp, blind to
    // *which* day is selected, would instead clamp 23:55 down to the global
    // upper bound, landing near 14:30 -- the wrong end of the day entirely.
    const middleDay = dayOptions(MIDDAY)[1]!; // tomorrow: fully open, every hour valid
    const farthestDay = dayOptions(MIDDAY).at(-1)!;
    render(<Controlled initial={composeArrival(middleDay.daySec, 23, 55)} nowSec={MIDDAY} />);
    expect(hourSelect().value).toBe("23");

    fireEvent.change(daySelect(), { target: { value: String(farthestDay.daySec) } });

    expect(hourSelect().value).toBe("0");
    expect(minuteSelect().value).toBe("55");
    expect(screen.getByTestId("arrival-time").textContent).toBe(formatClock(composeArrival(farthestDay.daySec, 0, 55)));
  });
});

describe("every control is keyboard-reachable and labelled", () => {
  it("focuses each select and quick chip by its own accessible name", () => {
    render(<ArrivalPicker value={MIDDAY + 900} nowSec={MIDDAY} onChange={() => {}} lang="en" />);
    const controls = [
      screen.getByLabelText(t("en").pickerDay),
      screen.getByLabelText(t("en").pickerHour),
      screen.getByLabelText(t("en").pickerMinute),
      screen.getByRole("button", { name: t("en").quickNow }),
      screen.getByRole("button", { name: t("en").quickPlus15 }),
      screen.getByRole("button", { name: t("en").quickPlus30 }),
      screen.getByRole("button", { name: t("en").quickPlus1h }),
    ];
    for (const control of controls) {
      (control as HTMLElement).focus();
      expect(document.activeElement).toBe(control);
    }
  });

  it("says all of it in Chinese too", () => {
    render(<ArrivalPicker value={MIDDAY + 900} nowSec={MIDDAY} onChange={() => {}} lang="zh" />);
    expect(screen.getByLabelText(t("zh").pickerDay)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("zh").quickPlus1h })).toBeInTheDocument();
  });
});
