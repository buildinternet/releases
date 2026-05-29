import { describe, it, expect } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import { extractFirecrawlMarkdown } from "./firecrawl-extract.js";

// Minimal fake Anthropic client whose messages.stream() returns the expected
// shape. `calls` records the user-message content actually sent to the model so
// tests can assert what body (full vs. windowed) reached extraction.
function makeFakeAnthropicClient() {
  const calls: Array<{ body: string }> = [];
  const client = {
    messages: {
      stream: (args: { messages: Array<{ role: string; content: string }> }) => {
        calls.push({ body: args.messages[0].content });
        return {
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
        };
      },
    },
  };
  return { client, calls };
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
    const { client } = makeFakeAnthropicClient();

    const { releases } = await extractFirecrawlMarkdown("# v1.2.0\nAdded X.", fakeSource, {
      anthropicClient: client as never,
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

  it("passes a small body through untouched (droppedChars 0)", async () => {
    const { client, calls } = makeFakeAnthropicClient();
    const small = "# v1.2.0\nAdded X.";

    const result = await extractFirecrawlMarkdown(small, fakeSource, {
      anthropicClient: client as never,
      agentModel: "claude-sonnet-4-6",
      logger: fakeLogger,
    });

    expect(result.droppedChars).toBe(0);
    // The full small body reaches the model (appended after the user message).
    expect(calls[0].body).toContain(small);
  });

  it("windows a years-deep changelog to a recent slice so output stays bounded", async () => {
    // ~600 dated sections, newest at the top — comfortably past the 10K-token
    // recent-window budget. A one-shot extract of the whole thing is what blew
    // the output cap on the OpenAI page; we should only send the recent window.
    const big = Array.from(
      { length: 600 },
      (_, i) =>
        `## Entry ${i}\n\nChangelog body text for entry number ${i} describing assorted fixes and features in adequate detail.`,
    ).join("\n\n");

    const { client, calls } = makeFakeAnthropicClient();
    const result = await extractFirecrawlMarkdown(big, fakeSource, {
      anthropicClient: client as never,
      agentModel: "claude-sonnet-4-6",
      logger: fakeLogger,
    });

    expect(result.droppedChars).toBeGreaterThan(0);
    // The windowed body sent to the model is far smaller than the full page,
    // and carries the most-recent (top) entries — not the ancient tail.
    expect(calls[0].body.length).toBeLessThan(big.length);
    expect(calls[0].body).toContain("## Entry 0");
    expect(calls[0].body).not.toContain("## Entry 599");
  });
});
