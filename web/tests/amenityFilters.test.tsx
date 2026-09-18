/**
 * 機車 / 充電 filtering, end to end through the real `App`.
 *
 * The owner's rule for this feature, in their words: **"Filter narrows, never
 * hides silently."** Three things have to hold at once for that to be true,
 * and each is a separate failure this file is written to catch:
 *
 *   - the filter narrows the *ranking*, not the twenty rows already on screen,
 *     or it would routinely leave a driver with two results and a city full of
 *     unshown ones;
 *   - what it removed is reported, or a short list is indistinguishable from
 *     an empty city;
 *   - and the report is **two numbers**, because a car park that said it has
 *     no scooter bays and a car park whose feed never mentions them are
 *     different facts. Fusing them into one "hidden" count is the same lie as
 *     rendering an absent `m` as `0`, reached by arithmetic instead. Every
 *     count asserted below is deliberately a *different* number from the one
 *     beside it, so a test cannot pass by matching the wrong total.
 *
 * The CSS block at the end is on text, not layout: jsdom lays nothing out, so
 * the 44 px floor is pinned where it is written. The visual check is a real
 * browser at 375 px and desktop -- see the report.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { LIST_LIMIT } from "../src/App";
import { HEADER_SIZE } from "../src/artifacts";
import { fillTemplate, t } from "../src/i18n";
import type { Lot, LotsDoc } from "../src/types";

const ROSTER_ID = 4242;
const N_HORIZONS = 24;
const STEP_MIN = 5;
const BASE_DATA_TS = 1788677280;
const NOW_MS = (BASE_DATA_TS + 4 * 60) * 1000;
const HERE = { lat: 25.0375, lon: 121.5637 };

/** Every lot reports the same 70% chance, so nothing but the filter can move the list. */
const PERCENT = 70;

/**
 * Twenty-five car parks in a line north of the destination, one every ~22 m.
 *
 * Same price, same probability, so the ranker orders them by distance alone
 * and the fixture's array order *is* the ranked order -- which is what lets a
 * test say "these rows came from past the list's own cap" without restating
 * the ranker's arithmetic.
 *
 * The scooter field is what the tests turn on, and it is spread across the
 * three states on purpose:
 *
 *   | rows                      | `m`      | meaning                    |
 *   |---------------------------|----------|----------------------------|
 *   | index 2, and 20..24       | `40`     | has scooter bays           |
 *   | indexes 7, 12, 18         | absent   | the feed never said        |
 *   | every other index         | `0`      | reported: none             |
 *
 * One matching lot sits *inside* the unfiltered head (index 2) and five sit
 * past it, so the filtered list is necessarily interleaved -- a filter that
 * reordered, or one that could only reach the head, gets a different answer.
 *
 * `e: 0` on every row is the other half of the fixture: a real published zero
 * for every car park in it, which is what the charging filter is pointed at
 * below to check that a *reported* zero empties the list honestly rather than
 * silently.
 */
const MATCHING = new Set([2, 20, 21, 22, 23, 24]);
const UNREPORTED = new Set([7, 12, 18]);

const LOTS: Lot[] = Array.from({ length: 25 }, (_unused, k) => {
  const lot: Lot = {
    i: k,
    id: `TPE_${String(k).padStart(2, "0")}`,
    n: `停車場${k}`,
    a: "信義區",
    y: HERE.lat + 0.0002 * (k + 1),
    x: HERE.lon,
    c: 50,
    t: "民營停車場",
    p: { k: "exact", lo: 60, hi: 60 },
    e: 0,
  };
  if (MATCHING.has(k)) lot.m = 40;
  else if (!UNREPORTED.has(k)) lot.m = 0;
  return lot;
});

/** The two counts the notice has to keep apart, derived from the fixture, never typed twice. */
const HEAD = LOTS.slice(0, LIST_LIMIT);
const HIDDEN_NONE = HEAD.filter((lot) => lot.m === 0).length;
const HIDDEN_UNKNOWN = HEAD.filter((lot) => lot.m === undefined).length;
const SHOWN_IDS = LOTS.filter((lot) => MATCHING.has(lot.i)).map((lot) => lot.id);

function encodeGrid(): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + LOTS.length * N_HORIZONS);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode("PCG1"), 0);
  dv.setUint8(4, 1);
  dv.setUint32(5, BASE_DATA_TS + 213, true);
  dv.setUint32(9, BASE_DATA_TS, true);
  dv.setUint16(13, LOTS.length, true);
  dv.setUint8(15, N_HORIZONS);
  dv.setUint8(16, STEP_MIN);
  dv.setUint32(17, ROSTER_ID, true);
  new Uint8Array(buf).fill(PERCENT, HEADER_SIZE);
  return buf;
}

const DOC: LotsDoc = {
  v: 1,
  generated_at: BASE_DATA_TS + 213,
  base_data_ts: BASE_DATA_TS,
  n_lots: LOTS.length,
  roster_id: ROSTER_ID,
  lots: LOTS,
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("grid.bin")) {
        return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(encodeGrid()) });
      }
      if (url.endsWith("lots.json")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DOC) });
      }
      if (url.endsWith("week.bin")) return Promise.resolve({ ok: false, status: 503 });
      return Promise.reject(new Error(`unexpected url ${url}`));
    }),
  );
  Object.defineProperty(navigator, "geolocation", {
    value: {
      getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) =>
        ok({ coords: { latitude: HERE.lat, longitude: HERE.lon } }),
    },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderRanked(): Promise<void> {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: t("en").useMyLocation }));
  await screen.findByTestId("lot-list");
}

function rowIds(): string[] {
  return within(screen.getByTestId("lot-list"))
    .queryAllByTestId("lot-row")
    .map((row) => row.getAttribute("data-lot-id") ?? "");
}

function press(amenity: "scooter" | "charging"): void {
  act(() => {
    fireEvent.click(screen.getByTestId(`filter-${amenity}`));
  });
}

describe("the amenity filters", () => {
  it("start off, and say so where a screen reader can hear it", async () => {
    await renderRanked();
    expect(screen.getByTestId("filter-scooter")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("filter-charging")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("group", { name: t("en").filtersLabel })).toBeInTheDocument();
    // Nothing filtered, so nothing to explain.
    expect(rowIds()).toHaveLength(LIST_LIMIT);
    expect(screen.queryByTestId("filter-hidden")).toBeNull();
  });

  it("narrows the whole ranking, not just the rows already on screen", async () => {
    await renderRanked();
    press("scooter");
    expect(screen.getByTestId("filter-scooter")).toHaveAttribute("aria-pressed", "true");

    // Every matching lot, and only those. Five of the six were past the cap:
    // a filter applied to `listed` instead of to `ranked` would show the one
    // that was inside it and stop there.
    expect(rowIds()).toEqual(SHOWN_IDS);
    expect(rowIds().filter((id) => !HEAD.some((lot) => lot.id === id))).toHaveLength(5);
  });

  it("narrows without reordering", async () => {
    await renderRanked();
    const before = rowIds();
    press("scooter");
    const after = rowIds();
    // The rows the filter kept from the unfiltered list are still in the order
    // the ranker put them in, and still ahead of the rows pulled up from below.
    const kept = before.filter((id) => after.includes(id));
    expect(kept).toEqual(after.slice(0, kept.length));
    expect(after).toEqual([...after].sort());
  });

  it("reports what it hid as two counts, not one", async () => {
    await renderRanked();
    press("scooter");
    const notice = screen.getByTestId("filter-hidden");

    // The numbers are deliberately different (16 and 3 at this fixture), so a
    // notice that printed the combined 19 in either slot, or the same number
    // twice, fails here rather than reading plausibly.
    expect(HIDDEN_NONE).not.toBe(HIDDEN_UNKNOWN);
    expect(within(notice).getByTestId("filter-hidden-none")).toHaveTextContent(
      fillTemplate(t("en").filterHiddenNoneTemplate, { n: HIDDEN_NONE }),
    );
    expect(within(notice).getByTestId("filter-hidden-unknown")).toHaveTextContent(
      fillTemplate(t("en").filterHiddenUnknownTemplate, { n: HIDDEN_UNKNOWN }),
    );
    expect(within(notice).getByTestId("filter-hidden-none").textContent).not.toContain(
      String(HIDDEN_NONE + HIDDEN_UNKNOWN),
    );
  });

  it("counts a car park that never mentioned scooters as unknown, not as a zero", async () => {
    // The single assertion this whole feature turns on, at list level. The
    // three unreported lots are not in the list -- they are not matches -- but
    // they are accounted for under their own reason. Code that read an absent
    // `m` as `0` would move all three into the "reports none" count, which is
    // exactly the number this asserts they are *not* in.
    await renderRanked();
    press("scooter");
    const notice = screen.getByTestId("filter-hidden");
    expect(within(notice).getByTestId("filter-hidden-unknown")).toHaveTextContent(String(HIDDEN_UNKNOWN));
    expect(within(notice).getByTestId("filter-hidden-none")).toHaveTextContent(String(HIDDEN_NONE));
    expect(within(notice).getByTestId("filter-hidden-none").textContent).not.toContain(
      String(HIDDEN_NONE + HIDDEN_UNKNOWN),
    );
    // ...and none of the three is quietly in the list either.
    for (const lot of HEAD.filter((l) => l.m === undefined)) {
      expect(rowIds()).not.toContain(lot.id);
    }
  });

  it("empties the list out loud when every car park reported none", async () => {
    // `e: 0` on all 25 rows: a published zero everywhere, which is a real
    // answer and not an absence. The list goes empty, the notice says so, and
    // the "doesn't say" clause is *absent* -- nothing here failed to report.
    await renderRanked();
    press("charging");
    expect(rowIds()).toHaveLength(0);
    const notice = screen.getByTestId("filter-hidden");
    expect(notice).toHaveTextContent(t("en").filterNoMatch);
    expect(within(notice).getByTestId("filter-hidden-none")).toHaveTextContent(String(LIST_LIMIT));
    expect(within(notice).queryByTestId("filter-hidden-unknown")).toBeNull();
  });

  it("composes the two filters instead of replacing one with the other", async () => {
    await renderRanked();
    press("scooter");
    expect(rowIds()).toEqual(SHOWN_IDS);
    press("charging");
    // Scooter bays yes, charging points reported as none: nothing satisfies both.
    expect(screen.getByTestId("filter-scooter")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("filter-charging")).toHaveAttribute("aria-pressed", "true");
    expect(rowIds()).toHaveLength(0);
  });

  it("puts the list back, and takes the explanation away with it", async () => {
    await renderRanked();
    press("scooter");
    expect(rowIds()).toEqual(SHOWN_IDS);
    press("scooter");
    expect(screen.getByTestId("filter-scooter")).toHaveAttribute("aria-pressed", "false");
    expect(rowIds()).toHaveLength(LIST_LIMIT);
    expect(screen.queryByTestId("filter-hidden")).toBeNull();
  });

  it("leaves the ranking's other facts alone", async () => {
    // A filtered list is still the same ranking, told about the same car
    // parks: the probability, the walk and the price on a surviving row must
    // be what they were before the chip was pressed. The filter narrows what
    // is shown; it does not recompute anything about what survives.
    await renderRanked();
    const shown = SHOWN_IDS[0]!;
    const facts = () => {
      const card = screen.getByTestId("lot-list").querySelector(`[data-lot-id="${shown}"]`) as HTMLElement;
      return ["lot-probability", "lot-walk", "lot-price", "lot-scooter"].map(
        (tile) => within(card).getByTestId(tile).textContent,
      );
    };
    const before = facts();
    expect(before[0]).toContain(`${PERCENT}%`);
    press("scooter");
    expect(facts()).toEqual(before);
  });

  it("crowns the best pick of what was asked for, and only one of them", async () => {
    // The badge means "the top of the ranking you are looking at". With the
    // chip on, that is the best car park *with scooter bays* -- a crown left
    // behind on a car park the list no longer shows would be a recommendation
    // pointing off screen, and a list with no crown at all would drop the one
    // piece of advice the ranker is actually for.
    await renderRanked();
    press("scooter");
    const rows = within(screen.getByTestId("lot-list")).getAllByTestId("lot-row");
    expect(within(screen.getByTestId("lot-list")).getAllByText(t("en").bestPick)).toHaveLength(1);
    expect(within(rows[0]!).getByText(t("en").bestPick)).toBeInTheDocument();
    expect(rows[0]!.getAttribute("data-lot-id")).toBe(SHOWN_IDS[0]);
  });
});

describe("the filter chips' own geometry", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles", "components.css"),
    "utf8",
  );

  it("meets the 44 px tap floor and colours itself from aria-pressed", () => {
    const chip = css.match(/\.fchip\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(chip).toMatch(/min-height:\s*44px/);
    // The pressed look is driven by the attribute a screen reader reads, so
    // the two cannot drift apart into a chip that looks on and reads off.
    expect(css).toMatch(/\.fchip\[aria-pressed="true"\]\s*\{/);
  });
});
