import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleaseThumb } from "./release-thumb.tsx";

describe("ReleaseThumb", () => {
  it("renders an img with the src and alt", () => {
    const html = renderToStaticMarkup(<ReleaseThumb src="https://cdn/a.png" alt="Shot" />);
    expect(html).toContain('src="https://cdn/a.png"');
    expect(html).toContain('alt="Shot"');
  });

  it("renders nothing when src is empty", () => {
    expect(renderToStaticMarkup(<ReleaseThumb src="" alt="x" />)).toBe("");
  });

  it("applies the small size class when size=sm", () => {
    const html = renderToStaticMarkup(<ReleaseThumb src="https://cdn/a.png" size="sm" />);
    expect(html).toContain("w-8");
    expect(html).toContain("h-8");
  });
});
