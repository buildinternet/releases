import { describe, it, expect } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import { extractFirecrawlMarkdown } from "./firecrawl-extract.js";

// Minimal fake Anthropic client whose messages.stream() returns the expected shape.
function makeFakeAnthropicClient() {
  return {
    messages: {
      stream: (_args: unknown) => ({
        finalMessage: async () => ({
          content: [
            {
              type: "tool_use" as const,
              name: "extract_releases",
              input: {
                releases: [
                  {
                    title: "v1.2.0",
                    content: "Added X. Fixed Y.",
                    version: "v1.2.0",
                    isBreaking: false,
                  },
                ],
              },
              id: "tu_1",
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          stop_reason: "tool_use",
        }),
      }),
    },
  };
}

const fakeSource: Source = {
  id: "src_1",
  slug: "acme",
  url: "https://acme.com/changelog",
} as Source;

const fakeLogger = {
  info(_msg: string) {},
  warn(_msg: string) {},
  debug(_msg: string) {},
  error(_msg: string) {},
};

describe("extractFirecrawlMarkdown", () => {
  it("extracts releases from markdown via extractFromBody", async () => {
    const anthropicClient = makeFakeAnthropicClient();

    const { releases } = await extractFirecrawlMarkdown("# v1.2.0\nAdded X.", fakeSource, {
      anthropicClient: anthropicClient as never,
      agentModel: "claude-sonnet-4-6",
      logger: fakeLogger,
    });

    expect(releases.length).toBe(1);
    expect(releases[0].title).toBe("v1.2.0");
    expect(releases[0].version).toBe("v1.2.0");
    // mapEntries synthesizes an anchor URL from the version
    expect(releases[0].url).toBeTruthy();
    expect(releases[0].url).toMatch(/https:\/\/acme\.com\/changelog/);
  });
});
