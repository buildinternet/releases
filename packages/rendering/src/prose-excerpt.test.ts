import { describe, expect, it } from "bun:test";
import { displaySummary, proseExcerpt } from "./prose-excerpt.js";

const HERO =
  '![Agents make decisions at runtime—your security controls should too](https://web-assets.dd-static.net/42588/ai-guard-hero.png?format=auto&fit=crop&width=1400&height=711&dpr=1 "Agents make decisions at runtime—your security controls should too")';

describe("proseExcerpt", () => {
  it("skips a leading hero image and returns the following prose", () => {
    const body = `${HERO}\n\nAI agents are creating a virtually unbounded attack surface. To be useful, they need access to internal systems.`;
    expect(proseExcerpt(body, { title: "Agents make decisions at runtime" })).toBe(
      "AI agents are creating a virtually unbounded attack surface. To be useful, they need access to internal systems.",
    );
  });

  it("skips a leading H1 that duplicates the title, then the hero, then excerpts prose", () => {
    const title = "Bits investigations are faster, more accurate, and cost less";
    const body = `# ${title}\n\n![${title}](https://web-assets.dd-static.net/bits-hero.png "${title}")\n\nWhen we [launched Bits](https://www.datadoghq.com/blog/bits-ai-sre/) in December 2025, our goal was to investigate every alert.`;
    expect(proseExcerpt(body, { title })).toBe(
      "When we launched Bits in December 2025, our goal was to investigate every alert.",
    );
  });

  it("does not return an empty preview when the body opens with only an image", () => {
    const title = "Export RUM and Product Analytics data with Export Pipelines";
    const body = `![${title}](https://web-assets.dd-static.net/export-pipelines-hero.png "${title}")\n\n[Datadog RUM](https://www.datadoghq.com/product/real-user-monitoring/) and Product Analytics help teams understand user sessions.`;
    const out = proseExcerpt(body, { title });
    expect(out.startsWith("![")).toBe(false);
    expect(out).toContain("help teams understand user sessions");
  });

  it("drops contributor avatar img tags instead of excerpting them", () => {
    const body =
      '### Features\n\n- **llmobs:** Add a global switch.\n\n<img src="https://github.com/watson.png?size=48" alt="@watson" />';
    expect(proseExcerpt(body, { title: "6.23.0" })).toBe("llmobs: Add a global switch.");
  });

  it("truncates on a word boundary", () => {
    const body = "word ".repeat(80);
    const out = proseExcerpt(body, { maxChars: 40 });
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.includes("  ")).toBe(false);
  });
});

describe("displaySummary", () => {
  it("keeps a stored AI summary", () => {
    expect(displaySummary("A crisp summary.", "![x](https://cdn.example.com/a.png)\n\nBody.")).toBe(
      "A crisp summary.",
    );
  });

  it("falls back to prose instead of a raw slice", () => {
    const content = `${HERO}\n\nAI agents need access to internal systems.`;
    expect(displaySummary(null, content, "Agents")).toBe(
      "AI agents need access to internal systems.",
    );
  });
});
