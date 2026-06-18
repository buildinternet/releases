import { describe, expect, test } from "bun:test";
import {
  buildCollectionDayBlock,
  parseCollectionSummary,
  summarizeCollectionDay,
  type CollectionDayInput,
} from "./collection-summary";
import type { TextModel } from "./text-model";

const INPUT: CollectionDayInput = {
  collectionName: "Coding agents",
  date: "2026-06-11",
  releases: [
    {
      org: "Anthropic",
      product: "Claude Code",
      title: "Sub-agents land in Claude Code",
      summary: "Spawn parallel sub-agents.",
      body: "Sub-agents can now run in parallel with isolated context windows.",
    },
    {
      org: "Cursor",
      product: null,
      title: "Background agents GA",
      summary: "Background agents are generally available.",
      body: null,
    },
  ],
};

describe("buildCollectionDayBlock", () => {
  test("renders collection, date, and one line per release", () => {
    const block = buildCollectionDayBlock(INPUT);
    expect(block).toContain("Collection: Coding agents");
    expect(block).toContain("Date: 2026-06-11");
    expect(block).toContain("Anthropic / Claude Code: Sub-agents land in Claude Code");
    expect(block).toContain("Cursor: Background agents GA");
  });

  test("collapses the label when product equals org", () => {
    const block = buildCollectionDayBlock({
      collectionName: "Payments",
      date: "2026-06-11",
      releases: [
        { org: "Stripe", product: "Stripe", title: "Tax API v2", summary: null, body: null },
      ],
    });
    expect(block).toContain("- Stripe: Tax API v2");
    expect(block).not.toContain("Stripe / Stripe");
  });

  test("includes an indented body excerpt when a release carries notes", () => {
    const block = buildCollectionDayBlock({
      collectionName: "SDKs",
      date: "2026-06-11",
      releases: [
        {
          org: "Browserbase",
          product: "Stagehand",
          title: "v2.5.9",
          summary: null,
          body: "### Patch Changes\n- Fix flaky act() retries on slow pages",
        },
      ],
    });
    expect(block).toContain("- Browserbase / Stagehand: v2.5.9");
    expect(block).toContain("    ### Patch Changes");
    expect(block).toContain("    - Fix flaky act() retries on slow pages");
  });
});

describe("parseCollectionSummary", () => {
  test("extracts title, summary, and bullet takeaways", () => {
    const raw = [
      "<title>Labs pile on agentic coding</title>",
      "<summary>Three labs shipped agent updates today.</summary>",
      "<takeaways><item>Anthropic added sub-agents to Claude Code</item><item>Cursor shipped background agents GA</item></takeaways>",
    ].join("\n");
    expect(parseCollectionSummary(raw)).toEqual({
      title: "Labs pile on agentic coding",
      summary: "Three labs shipped agent updates today.",
      takeaways: [
        "Anthropic added sub-agents to Claude Code",
        "Cursor shipped background agents GA",
      ],
    });
  });

  test("throws when the title tag is missing", () => {
    expect(() => parseCollectionSummary("<summary>x</summary>")).toThrow();
  });

  test("throws when the summary tag is missing", () => {
    expect(() => parseCollectionSummary("<title>x</title><takeaways></takeaways>")).toThrow();
  });

  test("tolerates surrounding prose and zero bullets", () => {
    const raw =
      "Here you go:\n<title>Quiet day</title><summary>One SDK bump.</summary><takeaways></takeaways>";
    expect(parseCollectionSummary(raw)).toEqual({
      title: "Quiet day",
      summary: "One SDK bump.",
      takeaways: [],
    });
  });
});

describe("summarizeCollectionDay", () => {
  test("passes the system prompt + day block to the model and returns parsed fields", async () => {
    let seenUser = "";
    const fake: TextModel = {
      id: "openrouter:test/cheap",
      async complete({ user }) {
        seenUser = user;
        return {
          text: "<title>T</title><summary>S</summary><takeaways><item>b1</item></takeaways>",
          usage: { input: 10, output: 5, cacheCreate: 0, cacheRead: 0 },
        };
      },
    };
    const res = await summarizeCollectionDay(fake, INPUT);
    expect(seenUser).toContain("Collection: Coding agents");
    expect(res.title).toBe("T");
    expect(res.takeaways).toEqual(["b1"]);
    expect(res.usage.input).toBe(10);
  });
});
