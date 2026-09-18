import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaceSearch } from "../src/components/PlaceSearch";
import { t } from "../src/i18n";
import { pushRecent, resetPlaceIndexCache } from "../src/places";
import type { Lot } from "../src/types";

const lot = (id: string, n: string, a = "信義區"): Lot => ({ i: 0, id, n, a, y: 25.03, x: 121.56, c: 10, t: "民營停車場", p: { k: "unknown" } });
const LOTS = [lot("TPE1", "台北101停車場"), lot("TPE2", "臺北車站停車場", "中正區")];
const INDEX = { v: 1, built: 1, source: "x", rows: [["台北101", "Taipei 101", "attraction", 25.0339, 121.5645, "信義"], ["忠孝東路四段216巷", "", "minor_road", 25.04, 121.55, "大安"], ["西門町", "", "locality", 25.04, 121.5, ""]] };

/** A promise a test resolves by hand, so a fetch can be held open across a blur. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function storage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

beforeEach(() => {
  resetPlaceIndexCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(INDEX))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PlaceSearch", () => {
  it("finds car parks at once and landmarks, streets and areas once the index has loaded, grouped", async () => {
    const onSelect = vi.fn();
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={onSelect} lang="en" storage={storage()} />);
    const box = screen.getByRole("combobox", { name: t("en").searchLabel });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "台北" } });
    expect(screen.getByText("台北101停車場")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("台北101")).toBeInTheDocument());
    const list = screen.getByTestId("search-results");
    // Each run of one kind is a `role="group"` named by its own heading, so the
    // grouping is something a screen reader announces rather than a row it skips.
    const groups = within(list).getAllByRole("group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAccessibleName(t("en").groupCarParks);
    expect(groups[1]).toHaveAccessibleName(t("en").groupLandmarks);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("selects a street with the keyboard and remembers it", async () => {
    const onSelect = vi.fn();
    const store = storage();
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={onSelect} lang="en" storage={store} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "忠孝東路" } });
    await screen.findByText("忠孝東路四段216巷");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "忠孝東路四段216巷", kind: "street", qualifier: "大安" }));
    expect((box as HTMLInputElement).value).toBe("忠孝東路四段216巷");
    expect(screen.getByTestId("search-results")).not.toBeVisible();
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.focus(box);
    expect(screen.getByText(t("en").recentSearches)).toBeInTheDocument();
    expect(screen.getByText("忠孝東路四段216巷")).toBeInTheDocument();
  });

  it("still searches the roster when the index cannot be loaded, and says nothing matched otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={() => {}} lang="en" storage={storage()} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "臺北車站" } });
    expect(screen.getByText("臺北車站停車場")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "月球" } });
    await waitFor(() => expect(screen.getByTestId("search-no-match")).toBeInTheDocument());
  });

  it("hands a chosen car park back with its lot id", () => {
    const onSelect = vi.fn();
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={onSelect} lang="zh" storage={storage()} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "101" } });
    fireEvent.click(screen.getByText("台北101停車場"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "carpark", lotId: "TPE1" }));
  });

  it("does not point aria-activedescendant at a stale option once the choices change without a keystroke", async () => {
    const store = storage();
    pushRecent(store, { name: "西門町", en: "", kind: "area", detail: "locality", lat: 25.04, lon: 121.5, qualifier: "" });
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={() => {}} lang="en" storage={store} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "台北" } });
    // Three matches once the index has loaded (two car parks, one landmark), so two
    // ArrowDowns land on index 2 without wrapping back to 0.
    await waitFor(() => expect(screen.getAllByTestId("search-option")).toHaveLength(3));
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: t("en").clearSearch }));
    fireEvent.focus(box);
    const options = screen.getAllByTestId("search-option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    const activeId = box.getAttribute("aria-activedescendant");
    expect(activeId).toBe(options[0]!.id);
    expect(document.getElementById(activeId!)).not.toBeNull();
  });

  it("retries a failed index fetch on the next focus, after a blur", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response("", { status: 503 }) : new Response(JSON.stringify(INDEX));
    }));
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={() => {}} lang="en" storage={storage()} />);
    const box = screen.getByRole("combobox");
    const wrapper = box.closest(".search") as HTMLElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "台北" } });
    expect(screen.getByText("台北101停車場")).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.blur(wrapper, { relatedTarget: document.body });
    fireEvent.focus(box);
    await waitFor(() => expect(screen.getByText("台北101")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries after a blur that cancelled a fetch still in flight", async () => {
    // The stuck-`loading` bug, from the one angle the case above cannot reach:
    // the box blurs while the fetch is *still open*, so the effect's cleanup
    // flips that fetch's `cancelled` flag and its `.then` returns before
    // `setLoading(false)` ever runs. With `loading` left `true`, the guard
    // `if (!focused || index !== null || loading) return` refuses every later
    // attempt for the rest of the session. Hence the deferred promise: a fetch
    // that had already settled before the blur would pass either way.
    const gate = deferred<void>();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await gate.promise;
        return new Response("", { status: 503 });
      }
      return new Response(JSON.stringify(INDEX));
    }));
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={() => {}} lang="en" storage={storage()} />);
    const box = screen.getByRole("combobox");
    const wrapper = box.closest(".search") as HTMLElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "台北" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    // Blurred first, and only then does the first attempt land.
    fireEvent.blur(wrapper, { relatedTarget: document.body });
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });

    fireEvent.focus(box);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("台北101")).toBeInTheDocument());
  });

  it("stays open when a touch-scroll on the results blurs the input with no relatedTarget", () => {
    // The reported bug: dragging a finger on the results `<ul>` blurs the input
    // (the list and its options are not focusable), so `relatedTarget` is `null`
    // and the old `onBlur`'s `contains(null)` check reads as "focus left the
    // control" -- dismissing the list on the very touch that was meant to
    // scroll it. A `pointerdown` inside the list, immediately followed by a
    // `blur` with `relatedTarget: null`, is that sequence without a browser.
    const onSelect = vi.fn();
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={onSelect} lang="en" storage={storage()} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "台北101" } });
    const list = screen.getByTestId("search-results");
    expect(list).toBeVisible();
    const option = within(list).getAllByTestId("search-option")[0]!;
    fireEvent.pointerDown(option);
    fireEvent.blur(box, { relatedTarget: null });
    expect(list).toBeVisible();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still closes on a pointerdown outside the control", () => {
    const onSelect = vi.fn();
    render(<PlaceSearch lots={LOTS} indexUrl="/places/taipei.json" onSelect={onSelect} lang="en" storage={storage()} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "台北101" } });
    const list = screen.getByTestId("search-results");
    expect(list).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(list).not.toBeVisible();
  });
});
