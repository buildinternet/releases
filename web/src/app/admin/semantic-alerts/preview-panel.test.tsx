import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewResultView, SemanticAlertPreviewPanel } from "./preview-panel.tsx";

describe("SemanticAlertPreviewPanel", () => {
  it("explains the demo source, the cap, and purge", () => {
    const html = renderToStaticMarkup(<SemanticAlertPreviewPanel />);
    expect(html).toContain("semantic-alerts-demo");
    expect(html).toContain("release.created");
    expect(html).toContain("[demo]");
    expect(html).toContain("At most 20");
    expect(html).toContain("follows the org");
    expect(html).toContain("leaves the follow");
    expect(html).toContain("Insert demo releases");
    expect(html).toContain("Purge synthetic rows");
    expect(html).toContain("src_… or org/source");
  });

  it("says the account follows the demo org when preview ensured the follow", () => {
    const html = renderToStaticMarkup(
      <PreviewResultView
        result={{
          inserted: 1,
          published: 1,
          seed: "seed",
          source: {
            id: "src_demo",
            slug: "preview",
            orgSlug: "semantic-alerts-demo",
            demo: true,
            followsEligible: true,
          },
          follow: { slug: "semantic-alerts-demo", ensured: true },
          releases: [],
          matcher: { status: "scored", userId: "user_1", matches: [] },
        }}
      />,
    );
    expect(html).toContain("follows");
    expect(html).toContain("semantic-alerts-demo");
    expect(html).toContain("leaves the follow");
  });

  it("still asks the operator to follow when preview did not write one", () => {
    const html = renderToStaticMarkup(
      <PreviewResultView
        result={{
          inserted: 1,
          published: 1,
          seed: "seed",
          source: {
            id: "src_acme",
            slug: "changelog",
            orgSlug: "acme",
            demo: false,
            followsEligible: true,
          },
          follow: { slug: "acme", ensured: false },
          releases: [],
          matcher: { status: "skipped", userId: null, matches: [] },
        }}
      />,
    );
    expect(html).toContain("Follow");
    expect(html).toContain("acme");
    expect(html).not.toContain("leaves the follow");
  });
});
