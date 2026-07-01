import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { extractFromBody } from "./extract-from-body.js";
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
 *  extract_releases response. Lets tests assert which `model` each call used. */
function capturingClient(params: Anthropic.MessageCreateParams[]) {
  return {
    messages: {
      stream: ((p: Anthropic.MessageCreateParams) => {
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
            }) as Anthropic.Message,
        } as never;
      }) as never,
    } as never,
  } as Pick<Anthropic, "messages">;
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
                model: "claude-sonnet-5",
                content: [
                  {
                    type: "tool_use",
                    id: "t1",
                    name: "extract_releases",
                    input: { releases: [] },
                  },
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: {
                  input_tokens: 100,
                  output_tokens: 10,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              }) as Anthropic.Message,
          } as never;
        }) as never,
      } as never,
    };

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
              }) as Anthropic.Message,
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
    let callIdx = 0;
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        stream: ((_params: Anthropic.MessageCreateParams) => {
          callIdx++;
          if (callIdx === 1) {
            throw new Error("boom");
          }
          // Subsequent call is from runOneShot fallback
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
              }) as Anthropic.Message,
          } as never;
        }) as never,
      } as never,
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
