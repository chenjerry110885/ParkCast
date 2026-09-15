import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatClock } from "../src/arrival";
import { ArrivalStrip } from "../src/components/ArrivalStrip";
import { t } from "../src/i18n";

const BASE = 1788677280;               // 14:48 Taipei
const NOW = BASE + 240;                 // 14:52
const options = [BASE + 720, BASE + 1020, BASE + 1320, BASE + 1620]; // 15:00 15:05 15:10 15:15

// A controlled wrapper: `onChange` feeds straight back into `value`, the way `App`
// actually drives the strip -- needed to prove that an arrow key's DOM focus follows
// the selection it just moved, not just the reported unix time.
function Controlled({ initial }: { initial: number }) {
  const [value, setValue] = useState(initial);
  return <ArrivalStrip options={options} value={value} nowSec={NOW} onChange={setValue} expired={false} lang="en" />;
}

afterEach(cleanup);

describe("ArrivalStrip", () => {
  it("offers each option as a clock-time radio and shows the selection with its lead time", () => {
    render(<ArrivalStrip options={options} value={BASE + 1320} nowSec={NOW} onChange={() => {}} expired={false} lang="en" />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["15:00", "15:05", "15:10", "15:15"]);
    expect(screen.getByRole("radio", { name: "15:10" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("arrival-time")).toHaveTextContent("15:10");
    expect(screen.getByText("in 18 min")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup")).toHaveAccessibleName(t("en").arrivalGroupLabel);
  });

  it("reports the chosen unix time on click and on arrow keys", () => {
    const onChange = vi.fn();
    render(<ArrivalStrip options={options} value={BASE + 1020} nowSec={NOW} onChange={onChange} expired={false} lang="en" />);
    fireEvent.click(screen.getByRole("radio", { name: "15:15" }));
    expect(onChange).toHaveBeenLastCalledWith(BASE + 1620);
    fireEvent.keyDown(screen.getByRole("radio", { name: "15:05" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(BASE + 1320);
    fireEvent.keyDown(screen.getByRole("radio", { name: "15:05" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(BASE + 720);
  });

  it("ends with the honest tail and renders no chips once the forecast has expired", () => {
    const { rerender } = render(<ArrivalStrip options={options} value={options[0]!} nowSec={NOW} onChange={() => {}} expired={false} lang="zh" />);
    expect(screen.getByText(t("zh").noForecastBeyond)).toBeInTheDocument();
    rerender(<ArrivalStrip options={options} value={options[0]!} nowSec={NOW} onChange={() => {}} expired lang="zh" />);
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.getByText(t("zh").noForecastBeyond)).toBeInTheDocument();
  });

  it("formats the selected time exactly as the card will", () => {
    render(<ArrivalStrip options={options} value={BASE + 1620} nowSec={NOW} onChange={() => {}} expired={false} lang="en" />);
    expect(screen.getByTestId("arrival-time")).toHaveTextContent(formatClock(BASE + 1620));
  });

  it("moves focus to the newly checked chip when an arrow key moves the selection", () => {
    render(<Controlled initial={BASE + 1020} />);
    const start = screen.getByRole("radio", { name: "15:05" });
    start.focus();
    expect(document.activeElement).toBe(start);
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "15:10" }));
  });
});
