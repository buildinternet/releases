import { describe, it, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { extractArticle } from "@releases/ai-internal/article-extract";

function fakeClient(text: string): Anthropic {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  } as unknown as Anthropic;
}

describe("extractArticle", () => {
  it("returns the verbatim body inside <article> and reports usage", async () => {
    const client = fakeClient(
      "<article>## Heading\n\nFull paragraph one.\n\nFull paragraph two.</article>",
    );
    const { content, usage } = await extractArticle(client, {
      markdown: "nav junk\n## Heading\n\nFull paragraph one.\n\nFull paragraph two.\nfooter",
      title: "Heading",
      model: "claude-haiku-4-5",
    });
    expect(content).toContain("Full paragraph one.");
    expect(content).toContain("Full paragraph two.");
    expect(content).not.toContain("nav junk");
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
  });

  it("returns empty content when the model emits no <article>", async () => {
    const client = fakeClient("sorry, no content");
    const { content } = await extractArticle(client, {
      markdown: "x",
      title: "t",
      model: "claude-haiku-4-5",
    });
    expect(content).toBe("");
  });
});
