import { describe, it, expect } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  CLOUDFLARE_SYSTEM_PROMPT,
  CRAWL_PAGE_SYSTEM_PROMPT,
  extractReleasesToolFull,
  extractReleasesToolCrawl,
} from "@releases/adapters/extract";
import {
  extractFirecrawlMarkdown,
  extractChangelogAllWindows,
  planWindowOffsets,
} from "./firecrawl-extract.js";

// Minimal fake Anthropic client whose messages.stream() returns the expected
// shape. `calls` records the user-message content, the system prompt, AND the
// tools actually sent to the model so tests can assert what body (full vs.
// windowed) reached extraction and which prompt + tool schema (summarizing vs.
// body-preserving) was selected.
function makeFakeAnthropicClient() {
  const calls: Array<{ body: string; system: string; tools: unknown[] }> = [];
  const client = {
    messages: {
      stream: (args: {
        messages: Array<{ role: string; content: string }>;
        system: Array<{ text: string }>;
        tools: unknown[];
      }) => {
        calls.push({
          body: args.messages[0].content,
          system: args.system[0].text,
          tools: args.tools,
        });
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
      agentModel: "claude-sonnet-5",
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
      agentModel: "claude-sonnet-5",
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
      agentModel: "claude-sonnet-5",
      logger: fakeLogger,
    });

    expect(result.droppedChars).toBeGreaterThan(0);
    // The windowed body sent to the model is far smaller than the full page,
    // and carries the most-recent (top) entries — not the ancient tail.
    expect(calls[0].body.length).toBeLessThan(big.length);
    expect(calls[0].body).toContain("## Entry 0");
    expect(calls[0].body).not.toContain("## Entry 599");
  });

  it("attributes releases to the BARE per-page URL when pageUrl is set (crawl monitor)", async () => {
    // A crawl monitor scrapes a single discovered per-entry page. Existing
    // crawl-ingested rows use the BARE page URL with no #anchor (e.g. replit's
    // https://docs.replit.com/updates/.../changelog). We must produce the exact
    // same scheme so re-ingest no-ops on UNIQUE(source_id, url) instead of
    // duplicating — NOT the `${sourceUrl}#${slug}` anchor mapEntries synthesizes
    // for single-page scrape monitors.
    const { client } = makeFakeAnthropicClient();
    const pageUrl = "https://docs.replit.com/updates/2026/05/15/changelog";
    const { releases } = await extractFirecrawlMarkdown(
      "# Update\nShipped X.",
      fakeSource,
      {
        anthropicClient: client as never,
        agentModel: "claude-haiku-4-5-20251001",
        logger: fakeLogger,
      },
      { pageUrl },
    );

    expect(releases).toHaveLength(1);
    expect(releases[0].url).toBe(pageUrl);
    expect(releases[0].url).not.toContain("#");
  });

  it("keeps source.url anchor attribution when pageUrl is absent (scrape monitor)", async () => {
    const { client } = makeFakeAnthropicClient();
    const { releases } = await extractFirecrawlMarkdown("# v1.2.0\nAdded X.", fakeSource, {
      anthropicClient: client as never,
      agentModel: "claude-haiku-4-5-20251001",
      logger: fakeLogger,
    });

    expect(releases).toHaveLength(1);
    // Unchanged behavior: a synthesized #anchor hanging off source.url.
    expect(releases[0].url).toMatch(/^https:\/\/acme\.com\/changelog#/);
  });

  it("selects the body-preserving prompt for a crawl-target page (pageUrl set)", async () => {
    // A crawl monitor's webhook page is exactly one post, so extraction must
    // preserve its full body, not condense it. The crawl-vs-scrape signal is
    // already in hand as pageUrl — when present, swap to CRAWL_PAGE_SYSTEM_PROMPT
    // ("Do NOT summarize") instead of the summarizing CLOUDFLARE_SYSTEM_PROMPT.
    const { client, calls } = makeFakeAnthropicClient();
    await extractFirecrawlMarkdown(
      "# beehiiv MCP v2\nFuller prose body that must survive verbatim.",
      fakeSource,
      {
        anthropicClient: client as never,
        agentModel: "claude-haiku-4-5-20251001",
        logger: fakeLogger,
      },
      { pageUrl: "https://product.beehiiv.com/p/beehiiv-mcp-v2" },
    );

    expect(calls[0].system).toBe(CRAWL_PAGE_SYSTEM_PROMPT);
    expect(calls[0].system).not.toBe(CLOUDFLARE_SYSTEM_PROMPT);
  });

  it("keeps the summarizing CLOUDFLARE prompt for a scrape monitor (pageUrl absent)", async () => {
    // A scrape monitor watches a single multi-entry index page; condensing many
    // entries off one page is correct there, so the prompt must NOT change.
    const { client, calls } = makeFakeAnthropicClient();
    await extractFirecrawlMarkdown("# v1.2.0\nAdded X.", fakeSource, {
      anthropicClient: client as never,
      agentModel: "claude-haiku-4-5-20251001",
      logger: fakeLogger,
    });

    expect(calls[0].system).toBe(CLOUDFLARE_SYSTEM_PROMPT);
  });

  it("uses the body-preserving extract_releases tool for a crawl-target page", async () => {
    // The prompt alone isn't enough: the tool schema's `content` field also
    // instructs the model. CRAWL_PAGE_SYSTEM_PROMPT says "do NOT summarize", so
    // the tool must carry a matching verbatim content description — otherwise the
    // schema pulls the model back toward condensing. See #1343 review.
    const { client, calls } = makeFakeAnthropicClient();
    await extractFirecrawlMarkdown(
      "# Post\nFull post body to preserve.",
      fakeSource,
      {
        anthropicClient: client as never,
        agentModel: "claude-haiku-4-5-20251001",
        logger: fakeLogger,
      },
      { pageUrl: "https://product.beehiiv.com/p/beehiiv-mcp-v2" },
    );

    expect(calls[0].tools[0]).toBe(extractReleasesToolCrawl);
    expect(calls[0].tools[0]).not.toBe(extractReleasesToolFull);
  });

  it("uses the standard (summarizing) extract_releases tool for a scrape monitor", async () => {
    const { client, calls } = makeFakeAnthropicClient();
    await extractFirecrawlMarkdown("# v1.2.0\nAdded X.", fakeSource, {
      anthropicClient: client as never,
      agentModel: "claude-haiku-4-5-20251001",
      logger: fakeLogger,
    });

    expect(calls[0].tools[0]).toBe(extractReleasesToolFull);
  });
});

// Fake whose every extract call returns a distinct version, so accumulation
// across windows is observable (N windows -> N pre-dedup releases).
function makeCountingFakeClient() {
  let n = 0;
  const client = {
    messages: {
      stream: (_args: { messages: Array<{ role: string; content: string }> }) => {
        n++;
        const v = `v1.${n}.0`;
        return {
          finalMessage: async () => ({
            content: [
              {
                type: "tool_use" as const,
                name: "extract_releases",
                input: { releases: [{ title: v, content: `body ${v}`, version: v }] },
                id: `tu_${n}`,
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
  return { client };
}

// ~2000 short newest-first sections => well past one 10K-token window.
const deepChangelog = Array.from(
  { length: 2000 },
  (_, i) =>
    `## Entry ${i}\n\nChangelog body text for entry number ${i} describing assorted fixes and features in adequate detail.`,
).join("\n\n");

describe("extractChangelogAllWindows", () => {
  it("loops all windows of a deep changelog and accumulates entries", async () => {
    const { client } = makeCountingFakeClient();
    const result = await extractChangelogAllWindows(deepChangelog, fakeSource, {
      anthropicClient: client as never,
      agentModel: "claude-haiku-4-5-20251001",
      logger: fakeLogger,
    });

    expect(result.windows).toBeGreaterThan(1);
    expect(result.cappedAtWindow).toBe(false);
    expect(result.droppedChars).toBe(0);
    // The counting fake returns one (distinct) release per window.
    expect(result.releases.length).toBe(result.windows);
  });

  it("respects maxWindows and reports the dropped tail", async () => {
    const { client } = makeCountingFakeClient();
    const result = await extractChangelogAllWindows(
      deepChangelog,
      fakeSource,
      {
        anthropicClient: client as never,
        agentModel: "claude-haiku-4-5-20251001",
        logger: fakeLogger,
      },
      { maxWindows: 1 },
    );

    expect(result.windows).toBe(1);
    expect(result.cappedAtWindow).toBe(true);
    expect(result.droppedChars).toBeGreaterThan(0);
    expect(result.releases.length).toBe(1);
  });

  it("completes a single small window uncapped", async () => {
    const { client } = makeCountingFakeClient();
    const result = await extractChangelogAllWindows("# v1.2.0\nAdded X.", fakeSource, {
      anthropicClient: client as never,
      agentModel: "claude-haiku-4-5-20251001",
      logger: fakeLogger,
    });

    expect(result.windows).toBe(1);
    expect(result.cappedAtWindow).toBe(false);
    expect(result.droppedChars).toBe(0);
    expect(result.releases.length).toBe(1);
  });
});

// DEFAULT_CHANGELOG_SLICE_TOKENS = 10_000; tokens ≈ chars/4, so ~40_000 chars
// per window. Build a fixture that reliably spans multiple windows by repeating
// a short section ~2000 times (same shape as deepChangelog above, ~200KB).
const multiWindowMarkdown = Array.from(
  { length: 2000 },
  (_, i) =>
    `## Entry ${i}\n\nChangelog body text for entry number ${i} describing assorted fixes and features in adequate detail.`,
).join("\n\n");

describe("planWindowOffsets", () => {
  it("returns multiple ascending offsets starting at 0 for a multi-window doc", () => {
    const plan = planWindowOffsets(multiWindowMarkdown);

    expect(plan.offsets.length).toBeGreaterThan(1);
    expect(plan.offsets[0]).toBe(0);
    // Offsets must be strictly ascending
    for (let i = 1; i < plan.offsets.length; i++) {
      expect(plan.offsets[i]).toBeGreaterThan(plan.offsets[i - 1]);
    }
    expect(plan.cappedAtWindow).toBe(false);
    expect(plan.droppedChars).toBe(0);
  });

  it("caps at maxWindows=1 and reports droppedChars > 0", () => {
    const plan = planWindowOffsets(multiWindowMarkdown, { maxWindows: 1 });

    expect(plan.offsets.length).toBe(1);
    expect(plan.offsets[0]).toBe(0);
    expect(plan.cappedAtWindow).toBe(true);
    expect(plan.droppedChars).toBeGreaterThan(0);
  });

  it("handles a tiny single-window doc: length 1, uncapped, droppedChars 0", () => {
    const plan = planWindowOffsets("# v1.2.0\nAdded X.");

    expect(plan.offsets.length).toBe(1);
    expect(plan.offsets[0]).toBe(0);
    expect(plan.cappedAtWindow).toBe(false);
    expect(plan.droppedChars).toBe(0);
  });
});
