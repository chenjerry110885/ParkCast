import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_QUERY, useMediaQuery } from "../src/layout/useMediaQuery";

function Probe() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return <p>{desktop ? "desktop" : "phone"}</p>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("useMediaQuery", () => {
  it("follows the query and its changes", () => {
    let listener: ((e: { matches: boolean }) => void) | null = null;
    const mql = { matches: false, addEventListener: (_: string, cb: typeof listener) => { listener = cb; }, removeEventListener: () => {} };
    vi.stubGlobal("matchMedia", vi.fn(() => mql));
    render(<Probe />);
    expect(screen.getByText("phone")).toBeInTheDocument();
    act(() => listener?.({ matches: true }));
    expect(screen.getByText("desktop")).toBeInTheDocument();
  });

  it("is false where matchMedia does not exist", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Probe />);
    expect(screen.getByText("phone")).toBeInTheDocument();
  });
});
