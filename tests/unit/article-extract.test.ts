import { describe, it, expect } from "bun:test";
import { extractArticle, MAX_OUTPUT_TOKENS } from "@releases/ai-internal/article-extract";
import type { TextModel, TextModelRequest } from "@releases/ai-internal/text-model";

/** Fake TextModel: capture the request and return a canned response — exercises
 *  extractArticle's use of the seam without any provider call. */
function fakeModel(text: string): { model: TextModel; calls: TextModelRequest[] } {
  const calls: TextModelRequest[] = [];
  const model: TextModel = {
    id: "fake:test-model",
    async complete(req) {
      calls.push(req);
      return { text, usage: { input: 100, output: 50, cacheCreate: 0, cacheRead: 5 } };
    },
  };
  return { model, calls };
}

describe("extractArticle", () => {
  it("returns the verbatim body inside <article>, reports usage, and wires the seam", async () => {
    const { model, calls } = fakeModel(
      "<article>## Heading\n\nFull paragraph one.\n\nFull paragraph two.</article>",
    );
    const { content, usage } = await extractArticle(model, {
      markdown: "nav junk\n## Heading\n\nFull paragraph one.\n\nFull paragraph two.\nfooter",
      title: "Heading",
    });
    expect(content).toContain("Full paragraph one.");
    expect(content).toContain("Full paragraph two.");
    expect(content).not.toContain("nav junk");
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
    // Seam contract feed-enrich relies on: the static system prompt is cached, the
    // title rides the user message, and the output cap is the article ceiling.
    expect(calls).toHaveLength(1);
    expect(calls[0].cacheSystem).toBe(true);
    expect(calls[0].maxTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(calls[0].user).toContain("Heading");
  });

  it("returns empty content when the model emits no <article>", async () => {
    const { model } = fakeModel("sorry, no content");
    const { content } = await extractArticle(model, { markdown: "x", title: "t" });
    expect(content).toBe("");
  });

  it("returns empty content for an explicitly empty <article></article>", async () => {
    // The prompt tells the model to emit an empty article for JS shells / index
    // pages — a present-but-empty body must stay empty, never get salvaged.
    const { model } = fakeModel("<article></article>");
    const { content } = await extractArticle(model, { markdown: "x", title: "t" });
    expect(content).toBe("");
  });

  it("salvages the emitted body when output is truncated before </article>", async () => {
    // Long articles (e.g. Discord's monthly patch notes) can exceed the output
    // token cap, so the model stops mid-body and never emits the closing tag.
    // The strict <article>…</article> match would discard a full body of good
    // content; recover the emitted prefix instead.
    const { model } = fakeModel(
      "<article>## May 4 Patch Notes\n\nFixed a bug on Desktop where a message that was still sen",
    );
    const { content } = await extractArticle(model, {
      markdown: "nav junk\n## May 4 Patch Notes\n\nFixed a bug...",
      title: "Discord Patch Notes: May 4, 2026",
    });
    expect(content).toContain("## May 4 Patch Notes");
    expect(content).toContain("Fixed a bug on Desktop");
    expect(content).not.toContain("<article>");
  });
});
