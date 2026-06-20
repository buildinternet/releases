import { test, expect } from "bun:test";
import { generateOverview, buildOverviewUserText } from "./overview-content";
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

test("buildOverviewUserText labels each release with its citation source", () => {
  const txt = buildOverviewUserText(input);
  expect(txt).toContain("https://acme.dev/releases/v2");
  expect(txt).toContain("Added a streaming API.");
  expect(txt).toContain("Acme");
});

test("generateOverview returns body + resolved citations from the model output", async () => {
  const model = fakeModel(
    "Acme shipped a streaming API.\n\n" +
      '```json\n[{"url":"https://acme.dev/releases/v2","quote":"streaming API"}]\n```',
  );
  const { body, citations } = await generateOverview(model, input);
  expect(body).toBe("Acme shipped a streaming API.");
  expect(citations).toHaveLength(1);
  expect(citations[0].sourceUrl).toBe("https://acme.dev/releases/v2");
});

test("generateOverview degrades to no citations when the model omits the block", async () => {
  const { body, citations } = await generateOverview(fakeModel("Acme shipped things."), input);
  expect(body).toBe("Acme shipped things.");
  expect(citations).toEqual([]);
});
