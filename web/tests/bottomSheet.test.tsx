import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "../src/layout/BottomSheet";
import { t } from "../src/i18n";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("BottomSheet", () => {
  it("exposes a real button that expands and collapses it", () => {
    const onSnapChange = vi.fn();
    render(<BottomSheet snap="peek" onSnapChange={onSnapChange} header={<b>h</b>} lang="en">body</BottomSheet>);
    const grip = screen.getByRole("button", { name: t("en").expandList });
    expect(grip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(grip);
    expect(onSnapChange).toHaveBeenCalledWith("full");
  });

  it("marks the full state so the body can scroll, and settles a drag to the nearest point", () => {
    const onSnapChange = vi.fn();
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const { rerender } = render(<BottomSheet snap="full" onSnapChange={onSnapChange} header={<b>h</b>} lang="en">body</BottomSheet>);
    expect(screen.getByTestId("sheet")).toHaveClass("sheet--full");
    rerender(<BottomSheet snap="half" onSnapChange={onSnapChange} header={<b>h</b>} lang="en">body</BottomSheet>);
    const grip = screen.getByRole("button", { name: t("en").expandList });
    fireEvent.pointerDown(grip, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientY: 600, pointerId: 1 });   // dragged down 200 px, slowly
    fireEvent.pointerUp(grip, { clientY: 600, pointerId: 1 });
    expect(onSnapChange).toHaveBeenLastCalledWith("peek");
  });

  it("clears the drag guard a tick later, so a later keyboard activation still toggles", () => {
    vi.useFakeTimers();
    const onSnapChange = vi.fn();
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    render(<BottomSheet snap="half" onSnapChange={onSnapChange} header={<b>h</b>} lang="en">body</BottomSheet>);
    const grip = screen.getByRole("button", { name: t("en").expandList });
    fireEvent.pointerDown(grip, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientY: 600, pointerId: 1 });   // dragged down 200 px, slowly
    fireEvent.pointerUp(grip, { clientY: 600, pointerId: 1 });
    expect(onSnapChange).toHaveBeenLastCalledWith("peek");
    vi.runAllTimers();
    fireEvent.click(grip); // e.g. a later Space/Enter activation, not part of the drag
    expect(onSnapChange).toHaveBeenLastCalledWith("full");
  });
});
