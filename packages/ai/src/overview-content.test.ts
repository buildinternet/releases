import { test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { generateOverview, buildOverviewUserText, lintOverviewBody } from "./overview-content";
import type { OverviewRequestInput } from "./overview-content";

const input: OverviewRequestInput = {
  org: { name: "Acme", description: "infra" },
  sources: [{ name: "Changelog" }],
  selected: [
    {
      id: "rel_1",
      title: "v2.0",
      version: "2.0.0",
      content: "Added a streaming API.",
      publishedAt: "2026-06-01T00:00:00.000Z",
      url: "https://acme.dev/releases/v2",
    },
  ],
  existingContent: null,
  totalAvailable: 1,
};

type OverviewObject = { body: string; citations: Array<{ url: string; quote: string }> };

/**
 * A mock `LanguageModel` (AI SDK v7 / LanguageModelV3) that returns the given
 * structured overview object(s) in sequence (repeating the last), each with the
 * paired finishReason ("stop" default, "length" = truncated). `generateText` +
 * `Output.object` parses the plain-text JSON body into `result.output`.
 */
function mockOverviewModel(
  objects: OverviewObject[],
  finishReasons: Array<"stop" | "length"> = [],
): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const idx = Math.min(i, objects.length - 1);
      const unified = finishReasons[idx] ?? "stop";
      i++;
      return {
        content: [{ type: "text", text: JSON.stringify(objects[idx]) }],
        finishReason: { unified, raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

/** Call count for a mock (the AI SDK invokes `doGenerate` once per model call). */
function callsOf(model: MockLanguageModelV3): number {
  return model.doGenerateCalls.length;
}

test("buildOverviewUserText labels each release with its citation source", () => {
  const txt = buildOverviewUserText(input);
  expect(txt).toContain("https://acme.dev/releases/v2");
  expect(txt).toContain("Added a streaming API.");
  expect(txt).toContain("Acme");
  // The structured-output path instructs the model to return citations as a typed
  // field (a verbatim quote + source URL), not a fenced ```json block.
  expect(txt).toContain("copied VERBATIM");
});

test("generateOverview returns body + resolved citations from the model output", async () => {
  const model = mockOverviewModel([
    {
      body: "Shipped a streaming API.",
      citations: [{ url: "https://acme.dev/releases/v2", quote: "streaming API" }],
    },
  ]);
  const { body, citations } = await generateOverview(model as unknown as LanguageModel, input);
  expect(body).toBe("Shipped a streaming API.");
  expect(citations).toHaveLength(1);
  expect(citations[0]!.sourceUrl).toBe("https://acme.dev/releases/v2");
  expect(body.slice(citations[0]!.startIndex, citations[0]!.endIndex)).toBe("streaming API");
});

test("generateOverview degrades to no citations when the model omits the block", async () => {
  const model = mockOverviewModel([{ body: "Shipped things.", citations: [] }]);
  const { body, citations } = await generateOverview(model as unknown as LanguageModel, input);
  expect(body).toBe("Shipped things.");
  expect(citations).toEqual([]);
});

test("generateOverview reports truncated=false on a complete draft", async () => {
  const model = mockOverviewModel([{ body: "Shipped things.", citations: [] }], ["stop"]);
  const { truncated } = await generateOverview(model as unknown as LanguageModel, input);
  expect(truncated).toBe(false);
});

// On a `finishReason: "length"` finish the AI SDK leaves `.output` unparsed
// (accessing it throws), so `generateOverview` salvages the partial JSON via
// `parsePartialJson`: the complete body + fully-serialized citations survive and
// `truncated` is reported true.
test("generateOverview surfaces truncated=true and salvages the body on a length-capped draft", async () => {
  const model = mockOverviewModel(
    [
      {
        body: "Shipped a streaming API.",
        citations: [{ url: "https://acme.dev/releases/v2", quote: "streaming API" }],
      },
    ],
    ["length"],
  );
  const { body, citations, truncated } = await generateOverview(
    model as unknown as LanguageModel,
    input,
  );
  expect(truncated).toBe(true);
  expect(body).toBe("Shipped a streaming API.");
  // The fully-serialized citation is recovered from the salvaged partial JSON.
  expect(citations).toHaveLength(1);
});

test("generateOverview salvages a complete body from genuinely truncated JSON, dropping the cut citation", async () => {
  // Raw response cut off mid-second-citation: the body + first citation fully
  // serialized, the second did not. parsePartialJson recovers the valid prefix.
  const truncatedJson =
    '{"body":"Shipped a streaming API and faster cold starts.",' +
    '"citations":[{"url":"https://acme.dev/releases/v2","quote":"streaming API"},' +
    '{"url":"https://acme.dev/rel'; // cut mid-URL: salvaged fragment lacks a quote → dropped
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: truncatedJson }],
      finishReason: { unified: "length", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const { body, citations, truncated } = await generateOverview(
    model as unknown as LanguageModel,
    input,
  );
  expect(truncated).toBe(true);
  expect(body).toBe("Shipped a streaming API and faster cold starts.");
  expect(body).not.toContain('"url"');
  // Only the citation that fully serialized before the cut is resolved.
  expect(citations).toHaveLength(1);
  expect(citations[0]!.citedText).toBe("streaming API");
});

test("lintOverviewBody flags format/voice violations and passes clean bodies", () => {
  expect(lintOverviewBody("Intro line.\n\n## Section\n\nMore.", "Acme")).toContain(
    "markdown-heading",
  );
  expect(lintOverviewBody("Acme shipped a streaming API.", "Acme")).toContain(
    "org-as-subject-opener",
  );
  expect(lintOverviewBody("**v2.0** is the headline here.", "Acme")).toContain(
    "version-lead-tease",
  );
  expect(lintOverviewBody("Delivered a seamless API.", "Acme")).toContain("banned-phrase:seamless");
  const longOpener = `Shipped ${"word ".repeat(30)}today.`;
  expect(lintOverviewBody(longOpener, "Acme")).toContain("opener-too-long");
  expect(lintOverviewBody("Shipped a fast streaming API.", "Acme")).toEqual([]);
});

test("generateOverview runs one corrective regen and keeps the clean rewrite", async () => {
  const model = mockOverviewModel([
    { body: "Delivered a powerful streaming API.", citations: [] }, // banned-phrase:powerful
    { body: "Delivered a fast streaming API.", citations: [] }, // clean
  ]);
  const { body } = await generateOverview(model as unknown as LanguageModel, input);
  expect(body).toBe("Delivered a fast streaming API.");
  expect(callsOf(model)).toBe(2);
});

test("generateOverview makes a single call when the first draft is clean", async () => {
  const model = mockOverviewModel([{ body: "Delivered a fast streaming API.", citations: [] }]);
  await generateOverview(model as unknown as LanguageModel, input);
  expect(callsOf(model)).toBe(1);
});

test("generateOverview keeps the first draft when the corrective is worse", async () => {
  const model = mockOverviewModel([
    { body: "Delivered a powerful streaming API.", citations: [] }, // 1 violation (powerful)
    { body: "Acme's seamless comprehensive API.", citations: [] }, // org-as-subject + 2 banned = worse
  ]);
  const { body } = await generateOverview(model as unknown as LanguageModel, input);
  expect(body).toBe("Delivered a powerful streaming API.");
  expect(callsOf(model)).toBe(2);
});
