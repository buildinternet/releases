import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { extractFromBody } from "./extract-from-body.js";
import { anthropicSpikeModel } from "./extract-with-tools-aisdk.js";
import { mockAnthropicClient } from "./test-helpers/anthropic-mock.js";
import type { ExtractDeps, ExtractLogger } from "./types.js";

const silentLogger: ExtractLogger = { info: () => {}, warn: () => {}, debug: () => {} };

function makeDeps(client: unknown, overrides?: Partial<ExtractDeps>): ExtractDeps {
  return {
    anthropicClient: client as never,
    agentModel: "claude-sonnet-5",
    logger: silentLogger,
    cloudflare: null,
    repo: {} as never,
    extractToolLoopEnabled: false,
    ...overrides,
  };
}

/** Capturing client: records each stream() params object and replays a fixed
 *  extract_releases response. Lets tests assert which `model` each call used.
 *  Exposes both `messages` (one-shot) and `beta.messages` (tool-loop with
 *  cache diagnostics) so either tier can capture. */
function capturingClient(params: Anthropic.MessageCreateParams[]) {
  const stream = ((p: Anthropic.MessageCreateParams) => {
    params.push(p);
    return {
      finalMessage: async () =>
        ({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "x",
          content: [
            { type: "tool_use", id: "t1", name: "extract_releases", input: { releases: [] } },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          diagnostics: null,
        }) as never,
    } as never;
  }) as never;
  return {
    messages: { stream } as never,
    beta: { messages: { stream } } as never,
  } as Pick<Anthropic, "messages" | "beta">;
}

/** A small body well under the 50K-token threshold. */
const SMALL_BODY = JSON.stringify({ nodes: [{ title: "v1.0" }] });

/**
 * A body large enough to exceed the 50K-token threshold.
 * Must exceed 262_144 chars (256KB) to bypass js-tiktoken's live BPE encoder
 * and use the fast chars/4 heuristic (avoids O(n²) on repetitive input).
 * 270K chars → ~67.5K tokens under the heuristic, comfortably above 50K.
 */
const LARGE_BODY = "x".repeat(270_000);

/** Reusable extract_releases response fixture. */
const extractReleasesResponse = {
  stop_reason: "tool_use" as const,
  content: [
    {
      type: "tool_use" as const,
      id: "t1",
      name: "extract_releases",
      caller: { type: "direct" as const },
      input: {
        releases: [
          {
            title: "v1.0",
            content: "initial release",
            isBreaking: false,
            publishedAt: "2026-04-01",
            url: "https://x.test/r/1",
          },
        ],
      },
    },
  ],
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

describe("extractFromBody — tier gate: oneshot", () => {
  test("mode: oneshot when useToolLoop is false, regardless of body size", async () => {
    const client = mockAnthropicClient([extractReleasesResponse]);

    const result = await extractFromBody(
      {
        body: SMALL_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
        useToolLoop: false,
      },
      makeDeps(client),
    );

    expect(result.mode).toBe("oneshot");
    expect(result.toolRounds).toBeNull();
    expect(result.toolChars).toBeNull();
    expect(result.fallbackReason).toBeNull();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("v1.0");
  });

  test("mode: oneshot when useToolLoop is true but body is below threshold", async () => {
    const client = mockAnthropicClient([extractReleasesResponse]);

    const result = await extractFromBody(
      {
        body: SMALL_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
        useToolLoop: true,
      },
      makeDeps(client),
    );

    // Small body should NOT trigger tool-loop even with useToolLoop: true
    expect(result.mode).toBe("oneshot");
    expect(result.toolRounds).toBeNull();
    expect(result.toolChars).toBeNull();
    expect(result.fallbackReason).toBeNull();
  });
});

describe("extractFromBody — tier gate: toolloop", () => {
  test("mode: toolloop when useToolLoop is true AND body exceeds threshold", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "tool_use" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "extract_releases",
            caller: { type: "direct" as const },
            input: {
              releases: [
                {
                  title: "v2.0",
                  content: "large body release",
                  isBreaking: false,
                  publishedAt: "2026-04-10",
                  url: "https://x.test/r/2",
                },
              ],
            },
          },
        ],
        usage: {
          input_tokens: 2000,
          output_tokens: 300,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    const result = await extractFromBody(
      {
        body: LARGE_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
        useToolLoop: true,
      },
      makeDeps(client),
    );

    expect(result.mode).toBe("toolloop");
    expect(result.toolRounds).toBe(0);
    expect(result.fallbackReason).toBeNull();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("v2.0");
  });
});

describe("extractFromBody — model selection", () => {
  test("one-shot path uses oneShotModel and reports it as modelUsed", async () => {
    const params: Anthropic.MessageCreateParams[] = [];
    const result = await extractFromBody(
      {
        body: SMALL_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
        useToolLoop: false,
      },
      makeDeps(capturingClient(params), { oneShotModel: "claude-haiku-4-5-20251001" }),
    );

    expect(params).toHaveLength(1);
    expect(params[0]!.model).toBe("claude-haiku-4-5-20251001");
    expect(result.modelUsed).toBe("claude-haiku-4-5-20251001");
  });

  test("one-shot falls back to agentModel when oneShotModel is unset (back-compat)", async () => {
    const params: Anthropic.MessageCreateParams[] = [];
    const result = await extractFromBody(
      {
        body: SMALL_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
        useToolLoop: false,
      },
      makeDeps(capturingClient(params)), // no oneShotModel
    );

    expect(params[0]!.model).toBe("claude-sonnet-5");
    expect(result.modelUsed).toBe("claude-sonnet-5");
  });

  test("tool-loop path stays on agentModel even when oneShotModel is Haiku", async () => {
    const params: Anthropic.MessageCreateParams[] = [];
    const result = await extractFromBody(
      {
        body: LARGE_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
        useToolLoop: true,
      },
      makeDeps(capturingClient(params), { oneShotModel: "claude-haiku-4-5-20251001" }),
    );

    // Agentic loop must not be downgraded — every call runs on agentModel.
    // Guard against a vacuous `.every` pass: assert calls were actually made.
    expect(params.length).toBeGreaterThan(0);
    expect(params.every((p) => p.model === "claude-sonnet-5")).toBe(true);
    expect(result.mode).toBe("toolloop");
    expect(result.modelUsed).toBe("claude-sonnet-5");
  });
});

describe("extractFromBody — guidance plumbing", () => {
  test("tool-loop path bakes parseInstructions and playbookContext into the system prompt", async () => {
    const captured: Anthropic.MessageCreateParams[] = [];
    const client = capturingClient(captured);

    await extractFromBody(
      {
        body: LARGE_BODY,
        systemPrompt: "BASE_PROMPT",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
        useToolLoop: true,
        guidance: {
          parseInstructions: "FIND_THE_FIVE_MOST_RECENT_BUCKETS",
          playbookContext: "ORG_PLAYBOOK_NOTES",
        },
      },
      makeDeps(client),
    );

    expect(captured.length).toBe(1);
    const systemBlocks = captured[0]!.system as Anthropic.TextBlockParam[];
    expect(Array.isArray(systemBlocks)).toBe(true);
    const systemText = systemBlocks.map((b) => b.text).join("\n");
    expect(systemText).toContain("BASE_PROMPT");
    expect(systemText).toContain("FIND_THE_FIVE_MOST_RECENT_BUCKETS");
    expect(systemText).toContain("ORG_PLAYBOOK_NOTES");
  });
});

describe("extractFromBody — deterministic extraction", () => {
  // Regression: with no temperature the SDK defaults to 1.0, and the forced
  // extract_releases tool call intermittently returns `releases: []` on the same
  // input (observed 1-in-4 on the OpenAI changelog). temperature 0 makes the
  // parse deterministic — but only on models that still accept it. Models
  // released after Opus 4.6 (Sonnet 5, Opus 4.7+, Fable) reject a non-default
  // temperature with a 400, so the knob is model-gated (modelAcceptsTemperature).
  function captureOneShotParams(respModel: string) {
    const captured: Anthropic.MessageCreateParams[] = [];
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        stream: ((params: Anthropic.MessageCreateParams) => {
          captured.push(params);
          return {
            finalMessage: async () =>
              ({
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: respModel,
                content: [
                  { type: "tool_use", id: "t1", name: "extract_releases", input: { releases: [] } },
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: {
                  input_tokens: 100,
                  output_tokens: 10,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              }) as never,
          } as never;
        }) as never,
      } as never,
    };
    return { captured, client };
  }

  const oneShotOpts = {
    body: SMALL_BODY,
    systemPrompt: "test",
    userMessage: "Extract from:",
    sourceUrl: "https://x.test",
    fetchUrl: "https://x.test/feed.json",
    useToolLoop: false as const,
  };

  test("oneshot path requests temperature 0 on the Haiku one-shot model", async () => {
    const { captured, client } = captureOneShotParams("claude-haiku-4-5-20251001");
    await extractFromBody(
      oneShotOpts,
      makeDeps(client, { oneShotModel: "claude-haiku-4-5-20251001" }),
    );
    expect(captured.length).toBe(1);
    expect(captured[0]!.temperature).toBe(0);
  });

  test("oneshot path omits temperature when it falls back to Sonnet 5 (rejects it)", async () => {
    const { captured, client } = captureOneShotParams("claude-sonnet-5");
    // No oneShotModel → falls back to agentModel (claude-sonnet-5).
    await extractFromBody(oneShotOpts, makeDeps(client));
    expect(captured.length).toBe(1);
    expect(captured[0]!.model).toBe("claude-sonnet-5");
    expect(captured[0]!.temperature).toBeUndefined();
  });
});

describe("extractFromBody — fallback paths", () => {
  test("mode: fallback_to_oneshot + fallbackReason: max_rounds when tool-loop exhausts budget", async () => {
    const keepQueryingResponse = {
      stop_reason: "tool_use" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "tx",
          name: "get_slice",
          input: { start: 0, length: 10 },
          caller: { type: "direct" as const },
        },
      ],
      usage: { input_tokens: 500, output_tokens: 50 },
    };

    // MAX_ROUNDS=8 main-loop rounds + 1 force-emit round, all non-terminal,
    // cause LoopFallbackError("max_rounds"). Then one extract_releases response
    // for the runOneShot fallback call.
    const client = mockAnthropicClient([
      ...Array.from({ length: 9 }, () => keepQueryingResponse),
      extractReleasesResponse,
    ]);

    const result = await extractFromBody(
      {
        body: LARGE_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/",
        useToolLoop: true,
      },
      makeDeps(client),
    );

    expect(result.mode).toBe("fallback_to_oneshot");
    expect(result.fallbackReason).toBe("max_rounds");
    // Partial loop usage is preserved on fallback so observability reflects the
    // full cost (loop + retry), not just the retry. The main loop ran MAX_ROUNDS
    // times before the force-emit turn, each pulling a 10-char get_slice result.
    expect(result.toolRounds).toBe(8);
    expect(result.toolChars).toBe(80);
    // And input/output tokens must be summed across loop + oneshot retry.
    // 9 loop API calls × 500 input + 1 oneshot × 1000 input = 5500.
    expect(result.totalInput).toBe(5500);
    expect(result.entries).toHaveLength(1);
  });

  test("mode: fallback_to_oneshot + fallbackReason: sdk_error when tool-loop throws a generic Error", async () => {
    // Tool-loop uses beta.messages; one-shot fallback uses messages.
    const client = {
      beta: {
        messages: {
          stream: () => {
            throw new Error("boom");
          },
        },
      },
      messages: {
        stream: ((_params: Anthropic.MessageCreateParams) => {
          return {
            finalMessage: async () =>
              ({
                id: "msg_fallback",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-5",
                content: [
                  {
                    type: "tool_use",
                    id: "t_fallback",
                    name: "extract_releases",
                    caller: { type: "direct" as const },
                    input: {
                      releases: [
                        {
                          title: "fallback-entry",
                          content: "recovered via fallback",
                          isBreaking: false,
                          publishedAt: "2026-04-01",
                          url: "https://x.test/fallback",
                        },
                      ],
                    },
                  },
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: {
                  input_tokens: 800,
                  output_tokens: 150,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              }) as never,
          } as never;
        }) as never,
      },
    };

    const result = await extractFromBody(
      {
        body: LARGE_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/",
        useToolLoop: true,
      },
      makeDeps(client),
    );

    expect(result.mode).toBe("fallback_to_oneshot");
    expect(result.fallbackReason).toBe("sdk_error");
    expect(result.toolRounds).toBeNull();
    expect(result.toolChars).toBeNull();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("fallback-entry");
  });
});

describe("extractFromBody — one-shot AI-SDK routing (issue #2166)", () => {
  test("routes through the AI-SDK seam when oneShotAiSdkModel is set, bypassing anthropicClient", async () => {
    // A legacy-path client that throws if hit — asserting it's never called is
    // the proof the AI-SDK branch took over instead of falling through.
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        stream: (() => {
          throw new Error("legacy Anthropic-direct path should not run");
        }) as never,
      } as never,
    };

    const aiSdkRequests: Array<{ model: string }> = [];
    const mockFetch = (async (_url: string, init: RequestInit) => {
      aiSdkRequests.push(JSON.parse(init.body as string) as { model: string });
      return new Response(
        JSON.stringify({
          id: "msg_aisdk",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          stop_reason: "tool_use",
          stop_sequence: null,
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "extract_releases",
              input: {
                releases: [{ title: "aisdk-entry", content: "via aisdk", isBreaking: false }],
              },
            },
          ],
          usage: {
            input_tokens: 42,
            output_tokens: 7,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const model = anthropicSpikeModel({
      apiKey: "sk-test",
      model: "claude-haiku-4-5",
      fetch: mockFetch,
    });

    const result = await extractFromBody(
      {
        body: SMALL_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
        useToolLoop: false,
      },
      makeDeps(client, {
        oneShotAiSdkModel: model,
        oneShotAiSdkModelLabel: "claude-haiku-4-5",
        oneShotAiSdkProvider: "anthropic",
      }),
    );

    expect(aiSdkRequests.length).toBeGreaterThan(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("aisdk-entry");
    expect(result.modelUsed).toBe("claude-haiku-4-5");
    expect(result.mode).toBe("oneshot");
  });

  test("falls back to the legacy Anthropic-direct path when oneShotAiSdkModel is unset", async () => {
    const params: Anthropic.MessageCreateParams[] = [];
    const client = capturingClient(params);

    const result = await extractFromBody(
      {
        body: SMALL_BODY,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
        useToolLoop: false,
      },
      makeDeps(client, { oneShotModel: "claude-haiku-4-5-20251001" }),
    );

    expect(params).toHaveLength(1);
    expect(result.modelUsed).toBe("claude-haiku-4-5-20251001");
  });
});

describe("extractFromBody — one-shot ai_usage telemetry (issue #2166)", () => {
  /** Drive the AI-SDK one-shot branch with a fixed usage payload and capture the
   *  emitted log lines. `logEvent` writes structured JSON to console.log. */
  async function captureUsageEvent(opts: {
    provider: "anthropic" | "openrouter";
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }): Promise<Record<string, unknown> | undefined> {
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        stream: (() => {
          throw new Error("legacy Anthropic-direct path should not run");
        }) as never,
      } as never,
    };
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_usage",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          stop_reason: "tool_use",
          stop_sequence: null,
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "extract_releases",
              input: { releases: [{ title: "t", content: "c", isBreaking: false }] },
            },
          ],
          usage: {
            input_tokens: opts.inputTokens,
            output_tokens: 11,
            cache_creation_input_tokens: opts.cacheWriteTokens,
            cache_read_input_tokens: opts.cacheReadTokens,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;

    const model = anthropicSpikeModel({
      apiKey: "sk-test",
      model: "claude-haiku-4-5",
      fetch: mockFetch,
    });

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await extractFromBody(
        {
          body: SMALL_BODY,
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/feed.json",
          useToolLoop: false,
        },
        makeDeps(client, {
          oneShotAiSdkModel: model,
          oneShotAiSdkModelLabel: "claude-haiku-4-5",
          oneShotAiSdkProvider: opts.provider,
        }),
      );
    } finally {
      console.log = origLog;
    }

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.event === "ai_usage") return parsed;
      } catch {
        // non-JSON log line — ignore
      }
    }
    return undefined;
  }

  // The point of this lane's telemetry is comparing Anthropic against OpenRouter.
  // Anthropic reports the non-cached prompt portion, so the cached tokens have to
  // be added back to get a total comparable with OpenRouter's.
  test("adds cached tokens back into promptTokens on Anthropic", async () => {
    const ev = await captureUsageEvent({
      provider: "anthropic",
      inputTokens: 100,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
    });
    expect(ev).toBeDefined();
    expect(ev!.lane).toBe("extract-oneshot");
    expect(ev!.provider).toBe("anthropic");
    expect(ev!.input).toBe(100);
    expect(ev!.promptTokens).toBe(500);
    expect(ev!.cacheHitRate).toBeCloseTo(0.6, 5);
  });

  // OpenRouter's prompt count already includes the cached portion, so adding it
  // again would double-count and understate the cache hit rate.
  test("does not double-count cached tokens on OpenRouter", async () => {
    const ev = await captureUsageEvent({
      provider: "openrouter",
      inputTokens: 500,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
    });
    expect(ev).toBeDefined();
    expect(ev!.provider).toBe("openrouter");
    expect(ev!.promptTokens).toBe(500);
    expect(ev!.cacheHitRate).toBeCloseTo(0.6, 5);
  });

  test("reports a zero cacheHitRate rather than NaN when there are no prompt tokens", async () => {
    const ev = await captureUsageEvent({
      provider: "anthropic",
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(ev).toBeDefined();
    expect(ev!.promptTokens).toBe(0);
    expect(ev!.cacheHitRate).toBe(0);
  });
});
