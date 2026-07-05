import { test, expect } from "bun:test";
import { generateOverview, buildOverviewUserText, lintOverviewBody } from "./overview-content";
import type { TextModel } from "./text-model";
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

function fakeModel(text: string): TextModel {
  return {
    id: "openrouter:test",
    async complete() {
      return { text, usage: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 } };
    },
  };
}

/** A model that returns each text in turn (repeating the last), counting calls. */
function fakeModelSeq(...texts: string[]): { model: TextModel; calls: () => number } {
  let i = 0;
  const model: TextModel = {
    id: "openrouter:test",
    async complete() {
      const text = texts[Math.min(i, texts.length - 1)];
      i++;
      return { text, usage: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 } };
    },
  };
  return { model, calls: () => i };
}

test("buildOverviewUserText labels each release with its citation source", () => {
  const txt = buildOverviewUserText(input);
  expect(txt).toContain("https://acme.dev/releases/v2");
  expect(txt).toContain("Added a streaming API.");
  expect(txt).toContain("Acme");
});

test("generateOverview returns body + resolved citations from the model output", async () => {
  const model = fakeModel(
    "Shipped a streaming API.\n\n" +
      '```json\n[{"url":"https://acme.dev/releases/v2","quote":"streaming API"}]\n```',
  );
  const { body, citations } = await generateOverview(model, input);
  expect(body).toBe("Shipped a streaming API.");
  expect(citations).toHaveLength(1);
  expect(citations[0].sourceUrl).toBe("https://acme.dev/releases/v2");
});

test("generateOverview degrades to no citations when the model omits the block", async () => {
  const { body, citations } = await generateOverview(fakeModel("Shipped things."), input);
  expect(body).toBe("Shipped things.");
  expect(citations).toEqual([]);
});

test("generateOverview reports truncated=false on a complete draft", async () => {
  const { truncated } = await generateOverview(fakeModel("Shipped things."), input);
  expect(truncated).toBe(false);
});

test("generateOverview surfaces truncated + strips the cut-off citation block", async () => {
  // Model hit its cap mid-citation-list: unterminated ```json block, truncated flag set.
  const model: TextModel = {
    id: "openrouter:test",
    async complete() {
      return {
        text:
          "Shipped a streaming API.\n\n" +
          '```json\n[{"url":"https://acme.dev/releases/v2","quote":"streaming AP',
        truncated: true,
        usage: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 },
      };
    },
  };
  const { body, citations, truncated } = await generateOverview(model, input);
  expect(truncated).toBe(true);
  expect(body).toBe("Shipped a streaming API.");
  expect(body).not.toContain("```json");
  expect(citations).toEqual([]);
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
  const { model, calls } = fakeModelSeq(
    "Delivered a powerful streaming API.\n```json\n[]\n```", // banned-phrase:powerful
    "Delivered a fast streaming API.\n```json\n[]\n```", // clean
  );
  const { body } = await generateOverview(model, input);
  expect(body).toBe("Delivered a fast streaming API.");
  expect(calls()).toBe(2);
});

test("generateOverview makes a single call when the first draft is clean", async () => {
  const { model, calls } = fakeModelSeq("Delivered a fast streaming API.\n```json\n[]\n```");
  await generateOverview(model, input);
  expect(calls()).toBe(1);
});

test("generateOverview keeps the first draft when the corrective is worse", async () => {
  const { model, calls } = fakeModelSeq(
    "Delivered a powerful streaming API.\n```json\n[]\n```", // 1 violation (powerful)
    "Acme's seamless comprehensive API.\n```json\n[]\n```", // org-as-subject + 2 banned = worse
  );
  const { body } = await generateOverview(model, input);
  expect(body).toBe("Delivered a powerful streaming API.");
  expect(calls()).toBe(2);
});
