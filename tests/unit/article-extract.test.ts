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

  it("returns empty content for an explicitly empty <article></article>", async () => {
    // The prompt tells the model to emit an empty article for JS shells / index
    // pages — a present-but-empty body must stay empty, never get salvaged.
    const client = fakeClient("<article></article>");
    const { content } = await extractArticle(client, {
      markdown: "x",
      title: "t",
      model: "claude-haiku-4-5",
    });
    expect(content).toBe("");
  });

  it("salvages the emitted body when output is truncated before </article>", async () => {
    // Long articles (e.g. Discord's monthly patch notes) can exceed the output
    // token cap, so the model stops mid-body and never emits the closing tag.
    // The strict <article>…</article> match would discard a full body of good
    // content; recover the emitted prefix instead.
    const client = fakeClient(
      "<article>## May 4 Patch Notes\n\nFixed a bug on Desktop where a message that was still sen",
    );
    const { content } = await extractArticle(client, {
      markdown: "nav junk\n## May 4 Patch Notes\n\nFixed a bug...",
      title: "Discord Patch Notes: May 4, 2026",
      model: "claude-haiku-4-5",
    });
    expect(content).toContain("## May 4 Patch Notes");
    expect(content).toContain("Fixed a bug on Desktop");
    expect(content).not.toContain("<article>");
  });
});
