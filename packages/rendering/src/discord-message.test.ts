import { describe, expect, test } from "bun:test";
import { formatDiscordMessage, type DiscordReleaseInput } from "./discord-message.js";

function release(overrides: Partial<DiscordReleaseInput> = {}): DiscordReleaseInput {
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

describe("formatDiscordMessage", () => {
  test("links the title with version and includes the summary", () => {
    const body = formatDiscordMessage(release());
    const embed = body.embeds[0]!;
    expect(embed.title).toBe("Next.js 15.4.0");
    expect(embed.url).toBe("https://releases.sh/release/rel_abc");
    expect(embed.description).toBe("Turbopack is now stable for production builds.");
    expect(body.content).toBe("Vercel — Next.js 15.4.0");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(embed.color).toBe(0x5865f2);
  });

  test("prefers the slugged webUrl over the bare-ID fallback", () => {
    const embed = formatDiscordMessage(
      release({ webUrl: "https://releases.sh/release/rel_abc-next-js-15-4-0" }),
    ).embeds[0]!;
    expect(embed.url).toBe("https://releases.sh/release/rel_abc-next-js-15-4-0");
  });

  test("renders org avatar + ISO timestamp on the embed", () => {
    const embed = formatDiscordMessage(release()).embeds[0]!;
    expect(embed.author).toEqual({
      name: "Vercel",
      icon_url: "https://media.releases.sh/orgs/vercel.png",
    });
    expect(embed.timestamp).toBe("2026-06-24T10:00:00.000Z");
  });

  test("falls back to the github avatar when avatarUrl is null", () => {
    const embed = formatDiscordMessage(
      release({ org: { name: "Vercel", avatarUrl: null, githubHandle: "vercel" } }),
    ).embeds[0]!;
    expect(embed.author.icon_url).toBe("https://github.com/vercel.png");
  });

  test("omits the avatar icon when no org/avatar resolves", () => {
    const embed = formatDiscordMessage(release({ org: null })).embeds[0]!;
    expect(embed.author).toEqual({ name: "Next.js Releases" });
    expect(embed.author.icon_url).toBeUndefined();
  });

  test("omits the avatar icon when avatarUrl and githubHandle are both null", () => {
    const embed = formatDiscordMessage(
      release({ org: { name: "Vercel", avatarUrl: null, githubHandle: null } }),
    ).embeds[0]!;
    expect(embed.author).toEqual({ name: "Vercel" });
  });

  test("title-only embed when summary is null", () => {
    const embed = formatDiscordMessage(release({ summary: null })).embeds[0]!;
    expect(embed.title).toBe("Next.js 15.4.0");
    expect(embed.description).toBeUndefined();
  });

  test("drops the version suffix when version is null", () => {
    const embed = formatDiscordMessage(release({ version: null })).embeds[0]!;
    expect(embed.title).toBe("Next.js");
    expect(formatDiscordMessage(release({ version: null })).content).toBe("Vercel — Next.js");
  });

  test("truncates a long summary on a word boundary with an ellipsis", () => {
    const long = "word ".repeat(100).trim();
    const embed = formatDiscordMessage(release({ summary: long })).embeds[0]!;
    expect(embed.description!.length).toBeLessThanOrEqual(301);
    expect(embed.description!.endsWith("…")).toBe(true);
    expect(embed.description).not.toContain("wor…");
  });

  test("omits the timestamp when publishedAt is null", () => {
    const embed = formatDiscordMessage(release({ publishedAt: null })).embeds[0]!;
    expect(embed.timestamp).toBeUndefined();
  });

  test("omits the timestamp when publishedAt is unparseable", () => {
    const embed = formatDiscordMessage(release({ publishedAt: "not-a-date" })).embeds[0]!;
    expect(embed.timestamp).toBeUndefined();
  });

  test("uses product name when org is absent", () => {
    const body = formatDiscordMessage(release({ org: null, product: { name: "Next.js" } }));
    expect(body.content).toBe("Next.js — Next.js 15.4.0");
    expect(body.embeds[0]!.author.name).toBe("Next.js");
  });

  test("honors a custom baseUrl", () => {
    const embed = formatDiscordMessage(release(), { baseUrl: "https://staging.releases.sh" })
      .embeds[0]!;
    expect(embed.url).toBe("https://staging.releases.sh/release/rel_abc");
  });
});
