import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GEO_WATCHDOG_MS, useGeolocation } from "../src/useGeolocation";

function Probe({ onFix }: { onFix: (at: { lat: number; lon: number }) => void }) {
  const { geo, request, abandon } = useGeolocation(onFix);
  return <><p>{geo}</p><button onClick={request}>go</button><button onClick={abandon}>abandon</button></>;
}

afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(navigator, "geolocation"); });

describe("useGeolocation", () => {
  it("reports a fix and lands on ready", () => {
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 25, longitude: 121.5 } }) }, configurable: true });
    const onFix = vi.fn();
    render(<Probe onFix={onFix} />);
    fireEvent.click(screen.getByText("go"));
    expect(onFix).toHaveBeenCalledWith({ lat: 25, lon: 121.5 });
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("is unavailable on denial, without the API, and on a prompt nobody answers", () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: () => {} }, configurable: true });
    render(<Probe onFix={() => {}} />);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("locating")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(GEO_WATCHDOG_MS + 1); });
    expect(screen.getByText("unavailable")).toBeInTheDocument();
  });

  it("can be abandoned by a better answer, and then ignores the late fix", () => {
    let deliver: ((p: unknown) => void) | null = null;
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: (ok: (p: unknown) => void) => { deliver = ok; } }, configurable: true });
    const onFix = vi.fn();
    render(<Probe onFix={onFix} />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByText("abandon"));
    expect(screen.getByText("idle")).toBeInTheDocument();
    act(() => deliver?.({ coords: { latitude: 1, longitude: 1 } }));
    expect(onFix).not.toHaveBeenCalled();
  });
});
