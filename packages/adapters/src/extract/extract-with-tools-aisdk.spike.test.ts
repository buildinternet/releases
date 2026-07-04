/**
 * SPIKE parity test (issue #1536). Drives the AI-SDK port of the extraction
 * tool-loop against a mocked Anthropic `fetch`, captures the outgoing wire
 * requests, and asserts the two cache breakpoints land exactly where the
 * hand-rolled `extract-with-tools.ts` puts them:
 *
 *   1. STATIC: the system prefix block carries `cache_control: ephemeral` on
 *      every request.
 *   2. SLIDING: after a tool round, the most-recent `tool_result` block carries
 *      `cache_control: ephemeral` and earlier user content does not.
 *
 * It also confirms the loop terminates on `extract_releases`, parses the
 * entries, and maps cache-read / cache-write usage. No network, no API key.
 */

import { describe, expect, it } from "bun:test";
import {
  anthropicSpikeModel,
  extractWithToolsAiSdk,
  type AiSdkExtractDeps,
} from "./extract-with-tools-aisdk.js";
import type { ExtractWithToolsOpts } from "./extract-with-tools.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
};

interface AnthropicWireBody {
  system?: Array<{ type: string; text: string; cache_control?: { type: string } }> | string;
  messages: Array<{
    role: string;
    content:
      | string
      | Array<{ type: string; cache_control?: { type: string }; [k: string]: unknown }>;
  }>;
}

function anthropicResponse(content: unknown[], usage: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      stop_reason: "tool_use",
      stop_sequence: null,
      content,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeOpts(overrides: Partial<ExtractWithToolsOpts> = {}): ExtractWithToolsOpts {
  return {
    // Plain markdown (not JSON) so query_json is unavailable and the loop uses get_slice.
    body: "# Changelog\n\n## v1.0\nFirst release.\n\n## v0.9\nBeta.\n".repeat(50),
    systemPrompt: "You are a changelog parser.",
    userMessage: "Extract all releases.",
    sourceUrl: "https://example.com/changelog",
    fetchUrl: "https://example.com/changelog",
    approxTokens: 60_000,
    ...overrides,
  };
}

describe("extractWithToolsAiSdk (spike) — cache-breakpoint parity", () => {
  it("places static + sliding cache_control breakpoints and parses the terminal", async () => {
    const requests: AnthropicWireBody[] = [];
    let call = 0;

    const mockFetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as AnthropicWireBody);
      call++;
      if (call === 1) {
        // Round 1: model asks for a slice of the body.
        return anthropicResponse(
          [{ type: "tool_use", id: "toolu_1", name: "get_slice", input: { start: 0, length: 80 } }],
          { input_tokens: 1000, output_tokens: 20, cache_creation_input_tokens: 800 },
        );
      }
      // Round 2: model emits the terminal extract_releases call.
      return anthropicResponse(
        [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "extract_releases",
            input: { releases: [{ title: "v1.0", content: "First release.", isBreaking: false }] },
          },
        ],
        { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 1800 },
      );
    }) as unknown as typeof globalThis.fetch;

    const deps: AiSdkExtractDeps = {
      model: anthropicSpikeModel({
        apiKey: "sk-test",
        model: "claude-haiku-4-5",
        fetch: mockFetch,
      }),
      logger: silentLogger,
    };

    const result = await extractWithToolsAiSdk(makeOpts(), deps);

    // ── Loop reached the terminal and parsed entries. ──
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("v1.0");
    expect(result.toolRounds).toBeGreaterThanOrEqual(1);

    // ── Usage mapping: cache read/write summed across steps. ──
    expect(result.cacheReadTokens).toBe(1800);
    expect(result.cacheWriteTokens).toBe(800);
    expect(result.totalInput).toBe(2200);
    expect(result.totalOutput).toBe(60);

    // ── Two requests captured (round 1 + terminal round). ──
    expect(requests).toHaveLength(2);

    // STATIC breakpoint: every request's system prefix block is cached.
    for (const req of requests) {
      expect(Array.isArray(req.system)).toBe(true);
      const sys = req.system as Array<{ text: string; cache_control?: { type: string } }>;
      const cachedPrefix = sys.find((b) => b.cache_control?.type === "ephemeral");
      expect(cachedPrefix).toBeDefined();
      expect(cachedPrefix!.text).toContain("changelog parser");
    }

    // SLIDING breakpoint: in the terminal-round request (which carries the
    // get_slice tool_result), the tool_result block is cached.
    const second = requests[1]!;
    const toolResultBlocks = (second.messages as Array<{ content: unknown }>)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is { type: string; cache_control?: { type: string } } =>
        Boolean(b && typeof b === "object" && (b as { type?: string }).type === "tool_result"),
      );
    expect(toolResultBlocks.length).toBeGreaterThanOrEqual(1);
    const cachedToolResult = toolResultBlocks.find((b) => b.cache_control?.type === "ephemeral");
    expect(cachedToolResult).toBeDefined();

    // No stray breakpoint on a plain user text block.
    const userTextBlocks = (second.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) => m.content as Array<{ type: string; cache_control?: { type: string } }>)
      .filter((b) => b.type === "text");
    for (const b of userTextBlocks) {
      expect(b.cache_control).toBeUndefined();
    }
  });

  it("forces tool_choice=extract_releases on the final step (reasoning-model recovery)", async () => {
    // The smoke run showed reasoning-first models loop without committing the
    // terminal; the loop forces it on the last allowed step. Here the model only
    // ever asks for slices — the forced step is what makes it terminate.
    const requests: Array<{ tool_choice?: { type: string; name?: string } }> = [];
    let forcedSeen = false;

    const mockFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        tool_choice?: { type: string; name?: string };
      };
      requests.push(body);
      // Anthropic represents a forced specific tool as { type: "tool", name }.
      const forced =
        body.tool_choice?.type === "tool" && body.tool_choice.name === "extract_releases";
      if (forced) {
        forcedSeen = true;
        return anthropicResponse(
          [
            {
              type: "tool_use",
              id: "toolu_final",
              name: "extract_releases",
              input: { releases: [{ title: "forced", content: "x", isBreaking: false }] },
            },
          ],
          { input_tokens: 10, output_tokens: 5 },
        );
      }
      // Otherwise keep stalling with slice requests (never volunteers the terminal).
      return anthropicResponse(
        [{ type: "tool_use", id: "toolu_s", name: "get_slice", input: { start: 0, length: 10 } }],
        { input_tokens: 10, output_tokens: 5 },
      );
    }) as unknown as typeof globalThis.fetch;

    const deps: AiSdkExtractDeps = {
      model: anthropicSpikeModel({
        apiKey: "sk-test",
        model: "claude-haiku-4-5",
        fetch: mockFetch,
      }),
      logger: silentLogger,
    };

    const result = await extractWithToolsAiSdk(makeOpts(), deps);
    expect(forcedSeen).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("forced");
  });
});
