import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SemanticAlertPreviewPanel } from "./preview-panel.tsx";

describe("SemanticAlertPreviewPanel", () => {
  it("explains the demo source, the cap, and purge", () => {
    const html = renderToStaticMarkup(<SemanticAlertPreviewPanel />);
    expect(html).toContain("semantic-alerts-demo");
    expect(html).toContain("release.created");
    expect(html).toContain("[demo]");
    expect(html).toContain("At most 20");
    expect(html).toContain("Insert demo releases");
    expect(html).toContain("Purge synthetic rows");
    expect(html).toContain("src_… or org/source");
  });
});
