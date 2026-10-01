import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LotCard } from "../src/components/LotCard";
import { t } from "../src/i18n";
import type { Ranked } from "../src/rank";
import type { Lot, Price } from "../src/types";

/**
 * The price tile, as a driver reads it once the fare depends on the clock.
 *
 * The arrival times here are exact Taipei wall-clock moments: `BASE` is the
 * reading at 14:48 Taipei, `MIDNIGHT` the start of that same day, so `at(21)`
 * is 21:00 Taipei and nothing in these tests depends on the machine's zone.
 */
const BASE = 1788677280;
const MIDNIGHT = 1788624000;
const at = (hour: number) => MIDNIGHT + hour * 3600;

/** 08-22 at NT$50, 22-08 at NT$10 -- the commonest shape in the corpus. */
const DAY_NIGHT: Price = {
  k: "range",
  lo: 10,
  hi: 50,
  t: [
    ["all", 8, 22, 50],
    ["all", 22, 8, 10],
  ],
};

const lot = (over: Partial<Lot> = {}): Lot => ({
  i: 0, id: "TPE1", n: "台北101停車場", a: "信義區", y: 25.03, x: 121.56,
  c: 400, t: "民營停車場", p: { k: "exact", lo: 60, hi: 60 }, f: 38, ...over,
});
const row = (over: Partial<Ranked> = {}, lotOver: Partial<Lot> = {}): Ranked => ({
  lot: lot(lotOver), id: "TPE1", index: 0, probability: 0.86, hourly: 60,
  perEntry: null, priceKnown: true, rateAtArrival: null, pricesHolidays: false,
  meters: 320, walkMin: 4, cost: 100, ...over,
});
const props = {
  lang: "en" as const, baseDataTs: BASE, ageMin: 4, horizonFromReadingMin: 22,
  support: 0, fromHistory: false, onSelect: vi.fn(), index: 0,
  best: false, selected: false,
};

const priceTile = () => within(screen.getByTestId("lot-row")).getByTestId("lot-price");
const label = () => priceTile().querySelector(".fact__label")!.textContent;
const value = () => priceTile().querySelector(".fact__value")!.textContent;

beforeEach(() =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the price tile at a chosen time", () => {
  it("shows the rate for the arrival time, and names the time it applies to", () => {
    render(<ol><LotCard row={row({ rateAtArrival: 50 }, { p: DAY_NIGHT })} {...props} arrivalTs={at(21)} /></ol>);
    expect(value()).toBe("NT$50");
    expect(label()).toBe("per hour at 21:00");
    // Never the range it was read out of: the number on the card is now a
    // single claim about a single hour, and NT$10-50 beside it would unmake it.
    expect(priceTile().textContent).not.toContain("NT$10");
  });

  it("moves when the scrubber moves", () => {
    // The whole point of the request. 21:00 is the day rate, 23:00 the night
    // one, and the card must follow the picker rather than freeze on mount.
    const { rerender } = render(
      <ol><LotCard row={row({ rateAtArrival: 50 }, { p: DAY_NIGHT })} {...props} arrivalTs={at(21)} /></ol>,
    );
    expect(value()).toBe("NT$50");
    expect(label()).toBe("per hour at 21:00");
    rerender(
      <ol><LotCard row={row({ rateAtArrival: 10 }, { p: DAY_NIGHT })} {...props} arrivalTs={at(23)} /></ol>,
    );
    expect(value()).toBe("NT$10");
    expect(label()).toBe("per hour at 23:00");
  });

  it("keeps the range and says the rate varies when the time cannot be resolved", () => {
    // A midpoint is a fallback, never a display. The range is what the parser
    // actually found, and the note says why a single number is not offered.
    render(<ol><LotCard row={row({ rateAtArrival: null }, { p: DAY_NIGHT })} {...props} arrivalTs={at(3)} /></ol>);
    expect(value()).toBe("NT$10–50");
    expect(label()).toBe(`per hour · ${t("en").priceVaries}`);
    // No clock, because no claim is being made about that hour.
    expect(priceTile().textContent).not.toContain("03:00");
  });

  it("says the rate varies for a range whose schedule could not be read at all", () => {
    // 100 of the 219 varying lots land here: a range, no schedule. Before this
    // the card showed the range with nothing said -- the range was already the
    // display, so only the note is new.
    render(<ol><LotCard row={row({}, { p: { k: "range", lo: 20, hi: 40 } })} {...props} arrivalTs={at(21)} /></ol>);
    expect(value()).toBe("NT$20–40");
    expect(label()).toBe(`per hour · ${t("en").priceVaries}`);
  });

  it("carries the holiday note as a fact about the car park, resolved or not", () => {
    // 95 of the 219 varying lots price public holidays as their own category
    // and this app has no holiday calendar, so a driver on Double Tenth Day is
    // told to check the sign -- including when the ordinary rate resolved
    // perfectly well, which is the case the note exists for.
    render(
      <ol><LotCard row={row({ rateAtArrival: 50, pricesHolidays: true }, { p: DAY_NIGHT })} {...props} arrivalTs={at(21)} /></ol>,
    );
    const card = screen.getByTestId("lot-row");
    expect(within(card).getByTestId("lot-holiday-price")).toHaveTextContent(t("en").priceHolidayNote);
    // In the lot's own facts, not folded into the money tile -- the same slot
    // and the same reasoning as the not-updating note.
    expect(priceTile().textContent).not.toContain(t("en").priceHolidayNote);
    expect(value()).toBe("NT$50");
  });

  it("says nothing about holidays for a lot that does not price them", () => {
    render(<ol><LotCard row={row({ rateAtArrival: 50 }, { p: DAY_NIGHT })} {...props} arrivalTs={at(21)} /></ol>);
    expect(screen.queryByTestId("lot-holiday-price")).toBeNull();
  });
});

describe("the 73.4% of the roster that charges one flat rate", () => {
  it("renders an exact lot byte-identically to before the schedule existed", () => {
    // The guarantee the whole feature is gated on. An `exact` lot has no
    // schedule to resolve, so it must gain no clock, no note, and no change of
    // wording -- which is also the colleague's rule still holding: the arrival
    // time is not repeated down a page of cards whose price cannot vary.
    render(<ol><LotCard row={row({ rateAtArrival: 60 })} {...props} arrivalTs={at(21)} /></ol>);
    expect(value()).toBe("NT$60");
    expect(label()).toBe("per hour");
    expect(screen.getByTestId("lot-row").textContent).not.toContain("21:00");
    expect(screen.queryByTestId("lot-holiday-price")).toBeNull();
  });

  it("leaves a per-entry fare alone", () => {
    // A per-visit charge has no hourly rate, and a time-of-day qualifier on one
    // would be a claim about a quantity that does not exist.
    render(
      <ol><LotCard row={row({ hourly: null, perEntry: 50 }, { p: { k: "entry", lo: 50, hi: 50 } })} {...props} arrivalTs={at(21)} /></ol>,
    );
    expect(value()).toBe("NT$50");
    expect(label()).toBe(t("en").perEntry);
  });

  it("still says nothing at all when the fare carries no number", () => {
    render(
      <ol><LotCard row={row({ hourly: null, priceKnown: false }, { p: { k: "unknown" } })} {...props} arrivalTs={at(21)} /></ol>,
    );
    expect(value()).toBe(t("en").priceUnknown);
    expect(label()).toBe("");
  });
});

describe("Chinese", () => {
  it("puts the clock before the unit, which is how the time reads in Chinese", () => {
    render(
      <ol><LotCard row={row({ rateAtArrival: 50 }, { p: DAY_NIGHT })} {...props} lang="zh" arrivalTs={at(21)} /></ol>,
    );
    expect(label()).toBe("21:00 每小時");
  });

  it("says the rate varies, and flags holidays, in Chinese", () => {
    render(
      <ol><LotCard row={row({ pricesHolidays: true }, { p: DAY_NIGHT })} {...props} lang="zh" arrivalTs={at(3)} /></ol>,
    );
    expect(label()).toBe(`${t("zh").perHour} · ${t("zh").priceVaries}`);
    expect(screen.getByTestId("lot-holiday-price")).toHaveTextContent(t("zh").priceHolidayNote);
  });
});
