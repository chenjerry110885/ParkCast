import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LotCard } from "../src/components/LotCard";
import { LotList } from "../src/components/LotList";
import { fillTemplate, t } from "../src/i18n";
import type { Ranked } from "../src/rank";
import type { Lot } from "../src/types";

const BASE = 1788677280;
const lot = (over: Partial<Lot> = {}): Lot => ({ i: 0, id: "TPE1", n: "台北101停車場", a: "信義區", y: 25.03, x: 121.56, c: 400, t: "民營停車場", p: { k: "exact", lo: 60, hi: 60 }, f: 38, ...over });
const row = (over: Partial<Ranked> = {}, lotOver: Partial<Lot> = {}): Ranked => ({
  lot: lot(lotOver), id: lotOver.id ?? "TPE1", index: 0, probability: 0.86, hourly: 60, perEntry: null, priceKnown: true, meters: 320, walkMin: 4, cost: 100, ...over,
});
// `support: 0` is the honest default, not a placeholder: a card the week table
// has never been consulted for has no history behind this half-hour to cite.
// Tests that want history say so themselves.
const props = { lang: "en" as const, baseDataTs: BASE, ageMin: 4, horizonFromReadingMin: 22, support: 0, fromHistory: false, onSelect: vi.fn(), index: 0 };

beforeEach(() => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("LotCard", () => {
  it("shows P, walk, price and the observed count with its age as separate facts", () => {
    render(<ol><LotCard row={row()} {...props} best selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    expect(within(card).getByTestId("lot-probability")).toHaveTextContent("86%");
    expect(within(card).getByTestId("lot-walk")).toHaveTextContent("4 min");
    expect(within(card).getByTestId("lot-walk")).toHaveTextContent("320 m");
    expect(within(card).getByTestId("lot-price")).toHaveTextContent("NT$60");
    expect(within(card).getByTestId("lot-spaces")).toHaveTextContent("38 / 400 free · 4 min ago");
    expect(within(card).getByText(t("en").bestPick)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /confidence.*high/i })).toBeInTheDocument();
    expect(card).toHaveClass("lot-card--best");
    expect(card.textContent).not.toMatch(/cost|NT\$100/);
  });

  it("does not repeat the arrival time the driver already chose", () => {
    // It was a fact tile until the owner's colleague pointed out that every
    // card was restating one number the picker had just been set to and the
    // readout above the list already shows. `arrivalTs` is 15:10 Taipei here,
    // so a card that still carried it -- as a tile, or anywhere else -- would
    // put that clock time on screen.
    render(<ol><LotCard row={row()} {...props} best selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    expect(within(card).queryByTestId("lot-arrival")).toBeNull();
    expect(card.textContent).not.toContain("15:10");
  });

  it("omits the count tile without an observation, and shows the count alone without a capacity", () => {
    const { rerender } = render(<ol><LotCard row={row({}, { f: undefined })} {...props} best={false} selected={false} /></ol>);
    expect(screen.queryByTestId("lot-spaces")).toBeNull();
    rerender(<ol><LotCard row={row({}, { f: 7, c: null })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-spaces")).toHaveTextContent("7 free · 4 min ago");
  });

  it("shows the scooter and charging counts a car park reported", () => {
    render(<ol><LotCard row={row({}, { m: 120, e: 8 })} {...props} best={false} selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    expect(within(card).getByTestId("lot-scooter")).toHaveTextContent("120");
    expect(within(card).getByTestId("lot-scooter")).toHaveTextContent(t("en").scooterTile);
    expect(within(card).getByTestId("lot-charging")).toHaveTextContent("8");
    expect(within(card).getByTestId("lot-charging")).toHaveTextContent(t("en").chargingTile);
  });

  it("tells a reported zero from a field the feed never mentioned, on one card", () => {
    // **The test the rest of this feature rests on.** `m: 0` is a measurement
    // -- this car park was asked and has no scooter bays -- and `e` absent is
    // the absence of one. They must not render the same way, and a test that
    // only checked the zero case would pass just as happily against code that
    // rendered both as "None". So both states sit on the same card and are
    // asserted against each other:
    //
    //   - render absent as 0/"None" and the charging tile appears -> fails;
    //   - drop the zero as if it were absent and the scooter tile goes -> fails;
    //   - print the zero as a bare "0" and the `amenityNone` check fails.
    render(<ol><LotCard row={row({}, { m: 0 })} {...props} best={false} selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    const scooter = within(card).getByTestId("lot-scooter");
    expect(scooter).toHaveTextContent(t("en").amenityNone);
    expect(scooter.querySelector(".fact__value")?.textContent).not.toBe("0");
    expect(within(card).queryByTestId("lot-charging")).toBeNull();
    // ...and nothing else on the card leaked the word in from somewhere else.
    expect(card.textContent).not.toContain(t("en").chargingTile);
  });

  it("says nothing at all about either field when neither was reported", () => {
    // The default fixture carries no `m` and no `e`, which is what every lot
    // outside Taipei publishes. Two absent tiles, not two zeroes.
    render(<ol><LotCard row={row()} {...props} best={false} selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    expect(within(card).queryByTestId("lot-scooter")).toBeNull();
    expect(within(card).queryByTestId("lot-charging")).toBeNull();
    expect(card.textContent).not.toContain(t("en").amenityNone);
    expect(card.textContent).not.toContain(t("en").scooterTile);
  });

  it("says the same two things in Chinese", () => {
    // The zero and the silence have to stay distinguishable under the zh
    // dictionary too -- this is the language the owner reviews, and 0 and
    // "未提供" collapsing into one another is not a bug an English-only
    // test would ever see.
    render(<ol><LotCard row={row({}, { m: 0, e: 3 })} {...props} lang="zh" best={false} selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    expect(within(card).getByTestId("lot-scooter")).toHaveTextContent(`${t("zh").amenityNone}${t("zh").scooterTile}`);
    expect(within(card).getByTestId("lot-charging")).toHaveTextContent(`3${t("zh").chargingTile}`);
  });

  it("says no data for a missing forecast, with no confidence and never 0%", () => {
    render(<ol><LotCard row={row({ probability: null, cost: null })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-probability")).toHaveTextContent(t("en").noData);
    expect(screen.getByTestId("lot-probability")).not.toHaveTextContent("0%");
    expect(screen.queryByRole("button", { name: /confidence/i })).toBeNull();
  });

  it("says a lot is not updating, and for how long", () => {
    render(<ol><LotCard row={row({ probability: null, cost: null }, { u: BASE - 30 * 3600 })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-probability")).toHaveTextContent(t("en").notUpdating);
    expect(screen.getByTestId("lot-row")).toHaveTextContent("No change in 30 h");
  });

  it("keeps saying it when the number beside it is climatology rather than a reading", () => {
    // A grid number is direct evidence this lot moved at the reading, so it
    // cancels a stale `u` from an older `lots.json`. A week number is what the
    // lot usually does at this hour and is evidence of nothing about its feed,
    // so it must not -- otherwise a car park that stopped reporting renders as
    // a bare confident percentage at every arrival past the grid's window.
    const stalledLot = { u: BASE - 30 * 3600 };
    const { rerender } = render(
      <ol><LotCard row={row({}, stalledLot)} {...props} best={false} selected={false} /></ol>,
    );
    expect(screen.getByTestId("lot-probability")).toHaveTextContent("86%");
    expect(screen.queryByTestId("lot-stalled")).toBeNull();

    // Same row, same 86%, different source.
    rerender(
      <ol><LotCard row={row({}, stalledLot)} {...props} fromHistory best={false} selected={false} /></ol>,
    );
    expect(screen.getByTestId("lot-probability")).toHaveTextContent("86%");
    const stalled = screen.getByTestId("lot-stalled");
    expect(stalled).toHaveTextContent(t("en").notUpdating);
    expect(stalled).toHaveTextContent("No change in 30 h");
  });

  it("shows an unparsed fare as words, a per-entry fare per entry, and a range as a range", () => {
    const { rerender } = render(<ol><LotCard row={row({ priceKnown: false, hourly: null }, { p: { k: "unknown" } })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-price")).toHaveTextContent(t("en").priceUnknown);
    expect(screen.getByTestId("lot-price").textContent).not.toMatch(/\d/);
    rerender(<ol><LotCard row={row({ hourly: null, perEntry: 50 }, { p: { k: "entry", lo: 50, hi: 50 } })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-price")).toHaveTextContent("NT$50");
    expect(screen.getByTestId("lot-price")).toHaveTextContent(t("en").perEntry);
    rerender(<ol><LotCard row={row({ hourly: 30 }, { p: { k: "range", lo: 20, hi: 40 } })} {...props} best={false} selected={false} /></ol>);
    expect(screen.getByTestId("lot-price")).toHaveTextContent("NT$20–40");
  });

  it("reports the pointer entering and leaving, so the map can halo the same lot", () => {
    const onHover = vi.fn();
    render(<ol><LotCard row={row()} {...props} onHover={onHover} best={false} selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    fireEvent.mouseEnter(card);
    expect(onHover).toHaveBeenLastCalledWith("TPE1");
    fireEvent.mouseLeave(card);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it("explains the confidence pill with the card's own reading age, not a stand-in value", () => {
    // props.ageMin is 4; the popover must say so verbatim, so a caller that
    // stops threading its own reading age through (e.g. hard-codes 0) is
    // caught here even though the level itself ("high") wouldn't change.
    render(<ol><LotCard row={row()} {...props} best selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    fireEvent.click(within(card).getByRole("button", { name: /confidence.*high/i }));
    expect(within(card).getByRole("note")).toHaveTextContent(
      fillTemplate(t("en").confidenceReadingTemplate, { n: props.ageMin }),
    );
  });

  it("never claims weeks of history for a card that hasn't consulted the week table", () => {
    // A horizon past MEDIUM_MAX_MIN takes both reading-led rows off the
    // table, so with the real support: 0 this lot has nothing left but
    // "low, thin". If the card's support were ever wired to a stand-in
    // non-zero value instead of 0, this would read "high" or "medium" with
    // a weeks-of-history sentence for a lot the week table was never
    // actually asked about -- the exact overstatement this task removes.
    render(<ol><LotCard row={row()} {...props} horizonFromReadingMin={100} best={false} selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    fireEvent.click(within(card).getByRole("button", { name: /confidence.*low/i }));
    expect(within(card).getByRole("note")).toHaveTextContent(t("en").confidenceThin);
  });

  it("counts the support it was handed, not one it decided on", () => {
    // The other side of the test above, now that `support` is a prop rather
    // than a literal in this file: the same far horizon, the same lot, and
    // four weeks of this half-hour behind it reads high and says how many.
    // A card that ignored its `support` prop would still read "low · thin"
    // here, and one that rounded the weeks differently would name the wrong
    // number.
    render(<ol><LotCard row={row()} {...props} horizonFromReadingMin={100} support={26} best={false} selected={false} /></ol>);
    const card = screen.getByTestId("lot-row");
    fireEvent.click(within(card).getByRole("button", { name: /confidence.*high/i }));
    expect(within(card).getByRole("note")).toHaveTextContent(
      fillTemplate(t("en").confidenceWeeksTemplate, { n: 4 }),
    );
  });

  it("keeps the name Chinese under English and selects on tap", () => {
    const onSelect = vi.fn();
    render(<ol><LotCard row={row()} {...props} onSelect={onSelect} best={false} selected /></ol>);
    expect(screen.getByTestId("lot-name")).toHaveTextContent("台北101停車場");
    expect(screen.getByTestId("lot-name")).toHaveAttribute("lang", "zh-Hant");
    fireEvent.click(screen.getByRole("button", { name: /台北101停車場/ }));
    expect(onSelect).toHaveBeenCalledWith("TPE1");
    expect(screen.getByTestId("lot-row")).toHaveClass("lot-card--selected");
  });
});

describe("LotList", () => {
  const rows = () => [row(), row({ id: "TPE2", probability: 0.5 }, { id: "TPE2", n: "二號停車場" })];

  it("is an ordered list keyed by lot, with exactly one best pick", () => {
    render(<LotList rows={rows()} {...props} supportById={new Map()} bestId="TPE1" selectedId={null} />);
    const list = screen.getByTestId("lot-list");
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByTestId("lot-row").length).toBe(2);
    expect(within(list).getAllByText(t("en").bestPick).length).toBe(1);
  });

  it("gives each card its own lot's support, not the first row's", () => {
    // The horizon is past MEDIUM_MAX_MIN, so nothing but support can earn a
    // grade here and the two cards must disagree: five weeks of history for
    // one lot, none for the other. A list that looked the support up once and
    // reused it -- or keyed it by position rather than by lot id -- would
    // render two identical pills.
    render(
      <LotList
        rows={rows()}
        {...props}
        horizonFromReadingMin={100}
        supportById={new Map([["TPE1", 30]])}
        bestId={null}
        selectedId={null}
      />,
    );
    const [first, second] = within(screen.getByTestId("lot-list")).getAllByTestId("lot-row");
    expect(within(first!).getByRole("button", { name: /confidence.*high/i })).toBeInTheDocument();
    expect(within(second!).getByRole("button", { name: /confidence.*low/i })).toBeInTheDocument();
  });
});
