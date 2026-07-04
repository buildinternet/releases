import { describe, expect, test } from "bun:test";
import { formatSlackMessage, type SlackReleaseInput } from "./slack-message.js";

function release(overrides: Partial<SlackReleaseInput> = {}): SlackReleaseInput {
  return {
    id: "rel_abc",
    title: "Next.js",
    version: "15.4.0",
    publishedAt: "2026-06-24T10:00:00.000Z",
    summary: "Turbopack is now stable for production builds.",
    sourceName: "Next.js Releases",
    org: {
      name: "Vercel",
      avatarUrl: "https://media.releases.sh/orgs/vercel.png",
      githubHandle: "vercel",
    },
    product: null,
    ...overrides,
  };
}

describe("formatSlackMessage", () => {
  test("links the title with version and includes the summary", () => {
    const body = formatSlackMessage(release());
    const section = body.blocks[0] as any;
    expect(section.type).toBe("section");
    expect(section.text.text).toContain("<https://releases.sh/release/rel_abc|Next.js 15.4.0>");
    expect(section.text.text).toContain("Turbopack is now stable");
    expect(body.text).toBe("Vercel — Next.js 15.4.0");
  });

  test("prefers the slugged webUrl over the bare-ID fallback (#1906)", () => {
    const section = formatSlackMessage(
      release({ webUrl: "https://releases.sh/release/rel_abc-next-js-15-4-0" }),
    ).blocks[0] as any;
    expect(section.text.text).toContain(
      "<https://releases.sh/release/rel_abc-next-js-15-4-0|Next.js 15.4.0>",
    );
  });

  test("renders org avatar + localized date in the context row", () => {
    const ctx = formatSlackMessage(release()).blocks[1] as any;
    expect(ctx.type).toBe("context");
    expect(ctx.elements[0]).toEqual({
      type: "image",
      image_url: "https://media.releases.sh/orgs/vercel.png",
      alt_text: "Vercel",
    });
    expect(ctx.elements[1].text).toContain("Vercel · <!date^");
    expect(ctx.elements[1].text).toContain("|2026-06-24>");
  });

  test("falls back to the github avatar when avatarUrl is null", () => {
    const ctx = formatSlackMessage(
      release({ org: { name: "Vercel", avatarUrl: null, githubHandle: "vercel" } }),
    ).blocks[1] as any;
    expect(ctx.elements[0].image_url).toBe("https://github.com/vercel.png");
  });

  test("omits the avatar element when no org/avatar resolves", () => {
    const ctx = formatSlackMessage(release({ org: null })).blocks[1] as any;
    expect(ctx.elements[0].type).toBe("mrkdwn");
    expect(ctx.elements[0].text).toContain("Next.js Releases");
  });

  test("omits the avatar element when avatarUrl and githubHandle are both null", () => {
    const ctx = formatSlackMessage(
      release({ org: { name: "Vercel", avatarUrl: null, githubHandle: null } }),
    ).blocks[1] as any;
    expect(ctx.elements).toHaveLength(1);
    expect(ctx.elements[0].type).toBe("mrkdwn");
    expect(ctx.elements[0].text).toContain("Vercel");
  });

  test("title-only section when summary is null", () => {
    const section = formatSlackMessage(release({ summary: null })).blocks[0] as any;
    expect(section.text.text).toBe("*<https://releases.sh/release/rel_abc|Next.js 15.4.0>*");
  });

  test("drops the version suffix when version is null", () => {
    const section = formatSlackMessage(release({ version: null })).blocks[0] as any;
    expect(section.text.text).toContain("|Next.js>");
  });

  test("truncates a long summary on a word boundary with an ellipsis", () => {
    const long = "word ".repeat(100).trim();
    const section = formatSlackMessage(release({ summary: long })).blocks[0] as any;
    const line = section.text.text.split("\n")[1];
    expect(line.length).toBeLessThanOrEqual(301);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("wor…");
  });

  test("omits the date when publishedAt is null", () => {
    const ctx = formatSlackMessage(release({ publishedAt: null })).blocks[1] as any;
    expect(ctx.elements.at(-1).text).not.toContain("<!date");
  });

  test("escapes mrkdwn-sensitive characters in title and summary", () => {
    const section = formatSlackMessage(release({ title: "A & B <C>", summary: "x < y & z" }))
      .blocks[0] as any;
    expect(section.text.text).toContain("A &amp; B &lt;C&gt;");
    expect(section.text.text).toContain("x &lt; y &amp; z");
  });

  test("honors a custom baseUrl", () => {
    const section = formatSlackMessage(release(), { baseUrl: "https://staging.releases.sh" })
      .blocks[0] as any;
    expect(section.text.text).toContain("https://staging.releases.sh/release/rel_abc");
  });
});
