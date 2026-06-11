import { describe, expect, test } from "bun:test";
import { tokenizeQuery, matchRanges } from "./highlight";

/** Render the matched substrings for readable assertions. */
function matched(text: string, tokens: string[]): string[] {
  return matchRanges(text, tokens).map(({ start, end }) => text.slice(start, end));
}

describe("tokenizeQuery", () => {
  test("splits on whitespace and separators, lowercases, dedupes", () => {
    expect(tokenizeQuery("Next.js AI ai")).toEqual(["next.js", "ai"]);
  });

  test("drops single-char tokens and empty input", () => {
    expect(tokenizeQuery("a b cd")).toEqual(["cd"]);
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery(null)).toEqual([]);
  });
});

describe("matchRanges (word-boundary highlighting)", () => {
  test("matches at the start of a word", () => {
    expect(matched("AI agents ship fast", ["ai"])).toEqual(["AI"]);
  });

  test("does NOT match mid-word — the Em·ai·l bug", () => {
    expect(matched("Email digests", ["ai"])).toEqual([]);
    expect(matched("maintain raised", ["ai"])).toEqual([]);
  });

  test("matches camelCase transitions like entity-match", () => {
    expect(matched("OpenAI models", ["ai"])).toEqual(["AI"]);
  });

  test("matches after punctuation and slashes", () => {
    expect(matched("vercel/ai sdk", ["ai"])).toEqual(["ai"]);
    expect(matched("(ai) tools", ["ai"])).toEqual(["ai"]);
  });

  test("multiple tokens each match independently", () => {
    expect(matched("Claude Code for AI work", ["claude", "ai"])).toEqual(["Claude", "AI"]);
  });

  test("boundary applies per occurrence, not per string", () => {
    // First occurrence is mid-word, second is word-anchored.
    expect(matched("email ai", ["ai"])).toEqual(["ai"]);
  });

  test("regex metacharacters in tokens are escaped", () => {
    expect(matched("Next.js 15 released", ["next.js"])).toEqual(["Next.js"]);
    // The "." must not act as a wildcard ("nextejs" would match unescaped).
    expect(matched("nextXjs", ["next.js"])).toEqual([]);
  });

  test("no tokens or no text yields no ranges", () => {
    expect(matched("anything", [])).toEqual([]);
    expect(matched("", ["ai"])).toEqual([]);
  });
});
