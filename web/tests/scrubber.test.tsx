/**
 * The scrubber's three promises: it offers the horizons the grid has, it
 * reports arrival times rather than column indices, and it can be operated
 * without seeing it.
 *
 * The middle one is the load-bearing case. `App` adds the artifact's age to the
 * requested horizon before reading the grid, so a scrubber that "helpfully"
 * reported a column -- or pre-applied the age itself -- would put a second
 * conversion in the path and silently double-count it.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scrubber } from "../src/components/Scrubber";

// No `globals: true` in this project's vitest config, so RTL's own auto-cleanup
// never registers: without this, three renders leave three sliders in the DOM
// and `getByRole` matches all of them.
afterEach(cleanup);

describe("Scrubber", () => {
  it("offers exactly the horizons the grid actually has", () => {
    render(<Scrubber value={15} stepMin={5} count={24} onChange={() => {}} lang="en" />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("min", "5");
    expect(slider).toHaveAttribute("max", "120");
    expect(slider).toHaveAttribute("step", "5");
  });

  it("reports the arrival time the user picked, not a grid column", () => {
    const onChange = vi.fn();
    render(<Scrubber value={15} stepMin={5} count={24} onChange={onChange} lang="en" />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "45" } });
    expect(onChange).toHaveBeenCalledWith(45);
  });

  it("is labelled for screen readers", () => {
    render(<Scrubber value={15} stepMin={5} count={24} onChange={() => {}} lang="en" />);
    expect(screen.getByRole("slider")).toHaveAccessibleName();
  });
});
