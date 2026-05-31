import { describe, it, expect } from "bun:test";
import {
  SYSTEM_PROMPT,
  MAX_OUTPUT_TOKENS,
  MODEL,
  buildArticleInput,
} from "@releases/ai-internal/article-extract";
import { buildEnrichBatchRequests } from "../../workers/api/src/lib/enrich-apply.js";

describe("buildEnrichBatchRequests", () => {
  it("builds one extractArticle request per item, keyed by releaseId", () => {
    const requests = buildEnrichBatchRequests([
      { releaseId: "rel_1", title: "First", markdown: "# First\n\nbody one" },
      { releaseId: "rel_2", title: "Second", markdown: "# Second\n\nbody two" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.custom_id)).toEqual(["rel_1", "rel_2"]);
  });

  it("targets the article model + output cap and carries the cacheable system prompt", () => {
    const [req] = buildEnrichBatchRequests([
      { releaseId: "rel_1", title: "T", markdown: "page md" },
    ]);
    expect(req.params.model).toBe(MODEL);
    expect(req.params.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(req.params.system).toEqual([
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
  });

  it("sends the per-item user message built by buildArticleInput (respecting the input cap)", () => {
    const markdown = "X".repeat(80_000); // exceeds MAX_INPUT_CHARS so buildArticleInput truncates
    const [req] = buildEnrichBatchRequests([{ releaseId: "rel_1", title: "Big", markdown }]);
    expect(req.params.messages).toEqual([
      { role: "user", content: buildArticleInput({ markdown, title: "Big" }) },
    ]);
    // sanity: the cap actually engaged so we're not just re-deriving an identity
    expect((req.params.messages[0].content as string).length).toBeLessThan(markdown.length);
  });

  it("returns an empty request list for no items", () => {
    expect(buildEnrichBatchRequests([])).toEqual([]);
  });
});
