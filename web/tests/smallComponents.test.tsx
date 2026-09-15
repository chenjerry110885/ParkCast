import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfidencePill } from "../src/components/ConfidencePill";
import { FreshnessBadge } from "../src/components/FreshnessBadge";
import { Notice } from "../src/components/Notice";
import { ProbabilityRing } from "../src/components/ProbabilityRing";
import { Skeleton } from "../src/components/Skeleton";
import { t } from "../src/i18n";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const reduced = () => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));

describe("ProbabilityRing", () => {
  it("shows the percentage and the arc for a known probability", () => {
    reduced();
    render(<ProbabilityRing probability={0.86} unknownText="No data" label="space" />);
    expect(screen.getByTestId("lot-probability")).toHaveTextContent("86%");
    const arc = document.querySelector(".ring__arc") as SVGCircleElement;
    expect(arc).not.toBeNull();
    expect(Number(arc.getAttribute("stroke-dashoffset"))).toBeGreaterThan(0);
  });

  it("says no data with an empty grey ring for null, and never 0%", () => {
    reduced();
    render(<ProbabilityRing probability={null} unknownText="No data" label="space" />);
    expect(screen.getByTestId("lot-probability")).toHaveTextContent("No data");
    expect(screen.getByTestId("lot-probability")).not.toHaveTextContent("0%");
    expect(document.querySelector(".ring")).toHaveClass("ring--unknown");
  });

  it("glows only for the best pick", () => {
    reduced();
    const { rerender } = render(<ProbabilityRing probability={0.5} unknownText="No data" label="space" best />);
    expect(document.querySelector(".ring")).toHaveClass("ring--glow");
    rerender(<ProbabilityRing probability={0.5} unknownText="No data" label="space" />);
    expect(document.querySelector(".ring")).not.toHaveClass("ring--glow");
  });
});

describe("ConfidencePill", () => {
  it("names the level and explains itself on tap", () => {
    render(<ConfidencePill level="medium" lang="en" />);
    const pill = screen.getByRole("button", { name: /confidence.*medium/i });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("note")).toHaveTextContent(t("en").confidenceWhyMedium);
  });
});

describe("FreshnessBadge", () => {
  it("reports the age, turns amber past ten minutes and grey when expired", () => {
    const { rerender } = render(<FreshnessBadge ageMin={4} expired={false} lang="en" />);
    const badge = screen.getByTestId("staleness");
    expect(badge).toHaveTextContent("data from 4 min ago");
    expect(badge).not.toHaveClass("fresh--warn");
    rerender(<FreshnessBadge ageMin={12} expired={false} lang="en" />);
    expect(badge).toHaveClass("fresh--warn");
    rerender(<FreshnessBadge ageMin={130} expired lang="en" />);
    expect(badge).toHaveClass("fresh--expired");
    expect(badge).toHaveTextContent("expired");
  });

  it("flashes once when a fresher reading lands", () => {
    vi.useFakeTimers();
    const { rerender } = render(<FreshnessBadge ageMin={9} expired={false} lang="en" />);
    rerender(<FreshnessBadge ageMin={1} expired={false} lang="en" />);
    expect(screen.getByTestId("staleness")).toHaveClass("fresh--flash");
    act(() => { vi.advanceTimersByTime(800); });
    expect(screen.getByTestId("staleness")).not.toHaveClass("fresh--flash");
    vi.useRealTimers();
  });

  it("clears an in-flight flash rather than sticking it on when the next update isn't a drop", () => {
    vi.useFakeTimers();
    const { rerender } = render(<FreshnessBadge ageMin={9} expired={false} lang="en" />);
    rerender(<FreshnessBadge ageMin={1} expired={false} lang="en" />);
    expect(screen.getByTestId("staleness")).toHaveClass("fresh--flash");
    act(() => { vi.advanceTimersByTime(300); });
    rerender(<FreshnessBadge ageMin={5} expired={false} lang="en" />);
    expect(screen.getByTestId("staleness")).not.toHaveClass("fresh--flash");
    vi.useRealTimers();
  });
});

describe("Skeleton and Notice", () => {
  it("renders hidden placeholders and a toned notice", () => {
    render(<><Skeleton count={3} /><Notice tone="warn" testId="n">hello</Notice></>);
    expect(document.querySelectorAll(".skeleton-card").length).toBe(3);
    expect(document.querySelector(".skeleton-stack")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("n")).toHaveClass("notice--warn");
  });
});
