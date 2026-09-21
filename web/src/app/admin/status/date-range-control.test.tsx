import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DateRangeControl } from "./date-range-control.tsx";

describe("DateRangeControl", () => {
  it("shows the selected range as a compact chip plus its label", () => {
    const html = renderToStaticMarkup(<DateRangeControl value="week" onChange={() => {}} />);

    expect(html).toContain('aria-label="Date range"');
    expect(html).toContain(">1w<");
    expect(html).toContain("This Week");
    // Closed control is one menu, not a row of range pills.
    expect(html).not.toContain("This Month");
    expect(html).not.toContain("All Time");
  });
});
