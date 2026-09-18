import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as icons from "../src/icons";

afterEach(cleanup);

describe("icons", () => {
  it("exports every icon the spec names, each an aria-hidden svg by default", () => {
    const names = ["Search", "Locate", "Walk", "Price", "Spaces", "Clock", "Pin", "Station", "Landmark", "Street", "Area", "CarPark", "Info", "Chevron", "Globe", "Cross", "Scooter", "Charging"] as const;
    for (const name of names) {
      const Icon = icons[name];
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      unmount();
    }
  });

  it("becomes an image with a name when labelled", () => {
    const { getByRole } = render(<icons.Walk label="walk" />);
    expect(getByRole("img", { name: "walk" })).toBeInTheDocument();
  });
});
