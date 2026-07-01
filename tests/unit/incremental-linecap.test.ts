/**
 * Tests for IncrementalOptions.lineCap in runIncrementalExtraction.
 *
 * The 200-line default is appropriate for single-page changelogs where the
 * newest entries appear near the top. When markdown is multi-page concatenated
 * output from acquireCrawlMarkdown, per-post bodies live well past line 200 —
 * passing lineCap: Infinity ensures the model sees the full body.
 *
 * These tests mock the Anthropic client's messages.create call and assert on
 * the user message content that would have been sent, so they never hit a real
 * API.
 */

import { describe, it, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Source } from "@buildinternet/releases-core/schema";
import { runIncrementalExtraction } from "../../packages/adapters/src/extract/run-incremental.js";
import type {
  ExtractDeps,
  ExtractLogger,
  KnownRelease,
} from "../../packages/adapters/src/extract/types.js";

// ── Fixtures ────────────────────────────────────────────────────────

const silentLogger: ExtractLogger = { info: () => {}, warn: () => {}, debug: () => {} };

function makeSource(): Source {
  return {
    id: "src_test",
    slug: "test-source",
    name: "Test Source",
    type: "scrape",
    url: "https://example.com/changelog",
    orgId: "org_test",
    productId: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    lastFetchedAt: null,
    changeDetectedAt: null,
    lastPolledAt: null,
    fetchPriority: "normal",
    consecutiveNoChange: 0,
    consecutiveErrors: 0,
    nextFetchAfter: null,
    etag: null,
    isHidden: 0,
    isPrimary: 0,
    discovery: "curated",
    suppressed: 0,
  } as unknown as Source;
}

const oneKnownRelease: KnownRelease[] = [
  { title: "v1.0.0", version: "1.0.0", publishedAt: "2026-01-01" },
];

/**
 * Build a markdown string with `lineCount` lines. The line at position
 * `sentinelLine` (1-based) embeds a unique sentinel string for assertion.
 */
function makeMarkdown(lineCount: number, sentinelLine: number, sentinelText: string): string {
  return Array.from({ length: lineCount }, (_, i) => {
    const line = i + 1;
    return line === sentinelLine ? `${sentinelText} — line ${line}` : `Line ${line} content here`;
  }).join("\n");
}

/** Captured call from the mock client. */
interface CapturedCall {
  params: Anthropic.MessageCreateParams;
}

/**
 * Minimal mock of Anthropic client's messages.create. Returns a minimal
 * tool_use response with zero releases, and records every call for assertion.
 */
function mockCreateClient(): { client: Pick<Anthropic, "messages">; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];

  const minimalResponse: Anthropic.Message = {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [
      {
        type: "tool_use",
        id: "t1",
        name: "extract_releases",
        input: { releases: [], needsMoreContext: false },
      } as Anthropic.ToolUseBlock,
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };

  const client: Pick<Anthropic, "messages"> = {
    messages: {
      create: ((params: Anthropic.MessageCreateParams) => {
        calls.push({ params });
        return Promise.resolve(minimalResponse);
      }) as never,
    } as never,
  };

  return { client, calls };
}

function makeDeps(client: unknown): ExtractDeps {
  return {
    anthropicClient: client as never,
    agentModel: "claude-sonnet-5",
    logger: silentLogger,
    cloudflare: null,
    repo: {} as never,
    extractToolLoopEnabled: false,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function getUserMessageContent(calls: CapturedCall[]): string {
  const params = calls[0]!.params;
  const userMsg = (params.messages as Anthropic.MessageParam[]).find((m) => m.role === "user");
  return typeof userMsg?.content === "string" ? userMsg.content : "";
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runIncrementalExtraction — lineCap", () => {
  it("default (lineCap: undefined) caps at 200 lines — sentinel at line 400 is NOT in the prompt", async () => {
    const SENTINEL = "SENTINEL_PAST_DEFAULT_CAP";
    // 500 lines with the sentinel at line 400 (well past the 200-line default)
    const markdown = makeMarkdown(500, 400, SENTINEL);

    const { client, calls } = mockCreateClient();
    await runIncrementalExtraction(
      makeSource(),
      { markdown, knownReleases: oneKnownRelease },
      makeDeps(client),
    );

    expect(calls).toHaveLength(1);
    const content = getUserMessageContent(calls);
    expect(content).not.toContain(SENTINEL);
    // Sanity: the slice header says lines 1–200 of 500
    expect(content).toContain("lines 1–200 of 500 total");
  });

  it("lineCap: Infinity includes content past line 200 — sentinel at line 400 IS in the prompt", async () => {
    const SENTINEL = "SENTINEL_BEYOND_DEFAULT_CAP";
    const markdown = makeMarkdown(500, 400, SENTINEL);

    const { client, calls } = mockCreateClient();
    await runIncrementalExtraction(
      makeSource(),
      { markdown, knownReleases: oneKnownRelease, lineCap: Number.POSITIVE_INFINITY },
      makeDeps(client),
    );

    expect(calls).toHaveLength(1);
    const content = getUserMessageContent(calls);
    expect(content).toContain(SENTINEL);
    // Sanity: the slice header covers all 500 lines
    expect(content).toContain("lines 1–500 of 500 total");
  });

  it("lineCap: 300 includes lines up to 300 but not beyond — sentinel at 400 absent, sentinel at 250 present", async () => {
    const SENTINEL_IN = "SENTINEL_WITHIN_CAP";
    const SENTINEL_OUT = "SENTINEL_BEYOND_CAP";
    // Build markdown with two sentinels
    const lines = Array.from({ length: 500 }, (_, i) => {
      const line = i + 1;
      if (line === 250) return `${SENTINEL_IN} — line ${line}`;
      if (line === 400) return `${SENTINEL_OUT} — line ${line}`;
      return `Line ${line} content`;
    });
    const markdown = lines.join("\n");

    const { client, calls } = mockCreateClient();
    await runIncrementalExtraction(
      makeSource(),
      { markdown, knownReleases: oneKnownRelease, lineCap: 300 },
      makeDeps(client),
    );

    expect(calls).toHaveLength(1);
    const content = getUserMessageContent(calls);
    expect(content).toContain(SENTINEL_IN);
    expect(content).not.toContain(SENTINEL_OUT);
    expect(content).toContain("lines 1–300 of 500 total");
  });
});
