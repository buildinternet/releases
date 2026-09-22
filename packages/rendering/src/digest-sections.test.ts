import { describe, expect, test } from "bun:test";
import {
  digestSectionAnchor,
  parseDigestSections,
  rewriteDigestReleaseLinks,
  releaseIdFromPath,
} from "./digest-sections";

const A = "rel_JotzQfuFf_u8NV4btlouH";
const B = "rel_ACOkQGJzq0IqqkhoWRR7C";
const C = "rel_1SjjEYFg34YFzPatqXk3o";

const BODY = `Intro paragraph that is not a section.

### Agents learn to talk

The week's most visible shift is that coding agents started speaking. [Codex CLI 0.155.0](/release/${A}-voice-conversations) added \`/voice\`, and [Devin](/release/${B}) shipped voice mode. Later [Codex again](/release/${A}-voice-conversations).

Second paragraph is ignored for the lede.

### Claude Code's week: hardening the edges

**Claude Code** closed gaps. See [v2.1.275](/release/${C}-memory-file).
`;

describe("digestSectionAnchor", () => {
  test("slugifies headings deterministically", () => {
    expect(digestSectionAnchor("Agents learn to talk")).toBe("agents-learn-to-talk");
    expect(digestSectionAnchor("Claude Code's week: hardening the edges")).toBe(
      "claude-codes-week-hardening-the-edges",
    );
    expect(digestSectionAnchor("Codex goes multimodal, OpenAI’s SDKs")).toBe(
      "codex-goes-multimodal-openais-sdks",
    );
  });
});

describe("parseDigestSections", () => {
  test("splits on ### headings, ignoring the preamble", () => {
    const sections = parseDigestSections(BODY);
    expect(sections.map((s) => s.heading)).toEqual([
      "Agents learn to talk",
      "Claude Code's week: hardening the edges",
    ]);
    expect(sections[0].anchor).toBe("agents-learn-to-talk");
  });

  test("collects unique cited release ids in first-seen order", () => {
    const [first, second] = parseDigestSections(BODY);
    expect(first.releaseIds).toEqual([A, B]);
    expect(second.releaseIds).toEqual([C]);
  });

  test("lede is the first sentence of the first paragraph, markdown stripped", () => {
    const [first, second] = parseDigestSections(BODY);
    expect(first.lede).toBe(
      "The week's most visible shift is that coding agents started speaking.",
    );
    expect(second.lede).toBe("Claude Code closed gaps.");
  });

  test("body with no ### headings yields no sections", () => {
    expect(parseDigestSections("Just prose.")).toEqual([]);
  });
});

describe("releaseIdFromPath", () => {
  test("extracts the id from slugged and bare release paths", () => {
    expect(releaseIdFromPath(`/release/${A}-voice-conversations`)).toBe(A);
    expect(releaseIdFromPath(`/release/${B}`)).toBe(B);
    expect(releaseIdFromPath("https://example.com/release/x")).toBeNull();
    expect(releaseIdFromPath("/collections/x")).toBeNull();
  });
});

describe("rewriteDigestReleaseLinks", () => {
  test("swaps /release/ links for upstream urls when known", () => {
    const urls = new Map<string, string | null>([
      [A, "https://developers.openai.com/codex/changelog/#0-155-0"],
      [B, null],
    ]);
    const out = rewriteDigestReleaseLinks(BODY, urls);
    expect(out).toContain(
      "[Codex CLI 0.155.0](https://developers.openai.com/codex/changelog/#0-155-0)",
    );
    expect(out).toContain("[Codex again](https://developers.openai.com/codex/changelog/#0-155-0)");
    // No upstream url → keep the internal fallback.
    expect(out).toContain(`[Devin](/release/${B})`);
    // Unknown id → untouched.
    expect(out).toContain(`[v2.1.275](/release/${C}-memory-file)`);
  });

  test("ignores non-http upstream urls", () => {
    const out = rewriteDigestReleaseLinks(
      `[x](/release/${A})`,
      new Map([[A, "javascript:alert(1)"]]),
    );
    expect(out).toBe(`[x](/release/${A})`);
  });
});
