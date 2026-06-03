import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { extractWithTools } from "./extract-with-tools.js";
import { MAX_ROUNDS } from "./shared.js";
import { mockAnthropicClient } from "./test-helpers/anthropic-mock.js";
import type { ExtractDeps, ExtractLogger } from "./types.js";

const silentLogger: ExtractLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

function makeDeps(client: unknown): ExtractDeps {
  return {
    anthropicClient: client as never,
    agentModel: "claude-sonnet-4-6",
    logger: silentLogger,
    cloudflare: null,
    repo: {} as never,
    extractToolLoopEnabled: false,
  };
}

describe("extractWithTools — happy path", () => {
  test("returns entries when model emits extract_releases in round 1", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "extract_releases",
            caller: { type: "direct" as const },
            input: {
              releases: [
                {
                  title: "v1.0",
                  content: "initial",
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
          cache_creation_input_tokens: 500,
        },
      },
    ]);

    const result = await extractWithTools(
      {
        body: JSON.stringify({ nodes: [{ title: "v1.0" }] }),
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(client),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("v1.0");
    expect(result.mode).toBe("toolloop");
    expect(result.toolRounds).toBe(0);
    expect(result.totalInput).toBe(1000);
    expect(result.cacheWriteTokens).toBe(500);
  });
});

describe("extractWithTools — deterministic extraction", () => {
  test("tool-loop rounds request temperature 0 so extraction is reproducible", async () => {
    // Same determinism rationale as the oneshot path (see extract-from-body):
    // at the SDK default (1.0) a forced/structured tool extraction can vary on
    // identical input. The large-body tool loop must be deterministic too.
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
                model: "claude-sonnet-4-6",
                content: [
                  {
                    type: "tool_use",
                    id: "t1",
                    name: "extract_releases",
                    input: {
                      releases: [
                        {
                          title: "v1.0",
                          content: "initial",
                          isBreaking: false,
                          publishedAt: "2026-04-01",
                          url: "https://x.test/r/1",
                        },
                      ],
                    },
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

    await extractWithTools(
      {
        body: JSON.stringify({ nodes: [{ title: "v1.0" }] }),
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(client),
    );

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured.every((p) => p.temperature === 0)).toBe(true);
  });
});

describe("extractWithTools — multi-round", () => {
  test("handles a query_json round followed by extract_releases", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "query_json",
            input: { path: "$.nodes[*]" },
            caller: { type: "direct" as const },
          },
        ],
        usage: { input_tokens: 1200, output_tokens: 100 },
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "extract_releases",
            input: {
              releases: [
                {
                  title: "v1",
                  content: "a",
                  isBreaking: false,
                  publishedAt: "2026-04-01",
                  url: "https://x.test/1",
                },
                {
                  title: "v2",
                  content: "b",
                  isBreaking: false,
                  publishedAt: "2026-04-02",
                  url: "https://x.test/2",
                },
              ],
            },
            caller: { type: "direct" as const },
          },
        ],
        usage: { input_tokens: 1400, output_tokens: 300 },
      },
    ]);

    const body = JSON.stringify({ nodes: [{ title: "v1" }, { title: "v2" }] });
    const result = await extractWithTools(
      {
        body,
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(client),
    );

    expect(result.entries).toHaveLength(2);
    expect(result.toolRounds).toBe(1);
    expect(result.toolChars).toBeGreaterThan(0);
    expect(result.totalInput).toBe(2600);
  });
});

describe("extractWithTools — budget exhaustion", () => {
  test("forces a final emit turn when MAX_ROUNDS reached", async () => {
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
    const finalEmitResponse = {
      stop_reason: "tool_use" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "tfinal",
          name: "extract_releases",
          input: {
            releases: [
              {
                title: "v-last",
                content: "x",
                isBreaking: false,
                publishedAt: "2026-04-01",
                url: "https://x.test/l",
              },
            ],
          },
          caller: { type: "direct" as const },
        },
      ],
      usage: { input_tokens: 600, output_tokens: 100 },
    };

    // MAX_ROUNDS non-terminal responses drain the main loop, then one
    // terminal response satisfies the force-emit turn.
    const client = mockAnthropicClient([
      ...Array.from({ length: MAX_ROUNDS }, () => keepQueryingResponse),
      finalEmitResponse,
    ]);

    const result = await extractWithTools(
      {
        body: "abcdefghijkl",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/",
      },
      makeDeps(client),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.toolRounds).toBe(MAX_ROUNDS);
  });

  test("throws max_rounds fallback when force-emit round still doesn't terminate", async () => {
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
    // MAX_ROUNDS + 1 non-terminal responses — drains the main loop AND the force-emit turn.
    const client = mockAnthropicClient(
      Array.from({ length: MAX_ROUNDS + 1 }, () => keepQueryingResponse),
    );

    await expect(
      extractWithTools(
        {
          body: "abcdefghij",
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "max_rounds" });
  });
});

describe("extractWithTools — prompt caching", () => {
  test("marks most-recent tool_result with cache_control on each new round", async () => {
    const captured: Anthropic.MessageCreateParams[] = [];
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        stream: ((params: Anthropic.MessageCreateParams) => {
          captured.push(params);
          const round = captured.length;
          if (round === 1) {
            return {
              finalMessage: async () =>
                ({
                  id: "m1",
                  type: "message",
                  role: "assistant",
                  model: "x",
                  content: [
                    {
                      type: "tool_use",
                      id: "t1",
                      name: "get_slice",
                      input: { start: 0, length: 5 },
                      caller: { type: "direct" as const },
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
          }
          return {
            finalMessage: async () =>
              ({
                id: "m2",
                type: "message",
                role: "assistant",
                model: "x",
                content: [
                  {
                    type: "tool_use",
                    id: "t2",
                    name: "extract_releases",
                    input: { releases: [] },
                    caller: { type: "direct" as const },
                  },
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: {
                  input_tokens: 100,
                  output_tokens: 10,
                  cache_read_input_tokens: 50,
                  cache_creation_input_tokens: 0,
                },
              }) as Anthropic.Message,
          } as never;
        }) as never,
      } as never,
    };

    await extractWithTools(
      {
        body: "abcdef",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/",
      },
      makeDeps(client),
    );

    // Second stream() call should include a tool_result block with cache_control set.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const round2 = captured[1]!;
    const msgs = round2.messages;
    const lastUser = msgs[msgs.length - 1]!;
    expect(lastUser.role).toBe("user");
    const content = lastUser.content as Anthropic.ToolResultBlockParam[];
    const lastBlock = content[content.length - 1]!;
    expect(lastBlock.type).toBe("tool_result");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("extractWithTools — fallback triggers", () => {
  test("tool handler throw triggers LoopFallbackError('tool_error')", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "query_json",
            input: { path: "??invalid??" },
            caller: { type: "direct" as const },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ]);

    await expect(
      extractWithTools(
        {
          body: JSON.stringify({ a: 1 }),
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/feed.json",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "tool_error" });
  });

  test("no_terminal_call fires when model emits text with no tool_use", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I don't know how to do this", citations: [] }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ]);

    await expect(
      extractWithTools(
        {
          body: JSON.stringify({ a: 1 }),
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/feed.json",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "no_terminal_call" });
  });

  test("malformed main-loop terminal (releases not an array) fires LoopFallbackError('tool_error')", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "extract_releases",
            input: { releases: "not-an-array" },
            caller: { type: "direct" as const },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ]);

    await expect(
      extractWithTools(
        {
          body: JSON.stringify({ a: 1 }),
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/feed.json",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "tool_error" });
  });

  test("malformed force-emit terminal (releases not an array) fires LoopFallbackError('tool_error')", async () => {
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
    const malformedEmitResponse = {
      stop_reason: "tool_use" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "tfinal",
          name: "extract_releases",
          input: { releases: { not: "an array" } },
          caller: { type: "direct" as const },
        },
      ],
      usage: { input_tokens: 600, output_tokens: 100 },
    };

    // Drain the main loop, then malformed force-emit response.
    const client = mockAnthropicClient([
      ...Array.from({ length: MAX_ROUNDS }, () => keepQueryingResponse),
      malformedEmitResponse,
    ]);

    await expect(
      extractWithTools(
        {
          body: "abcdefghij",
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "tool_error" });
  });

  test("max_tokens in a round fires LoopFallbackError('max_tokens')", async () => {
    const client = mockAnthropicClient([
      {
        stop_reason: "max_tokens",
        content: [
          {
            type: "tool_use",
            id: "tx",
            name: "get_slice",
            input: { start: 0, length: 10 },
            caller: { type: "direct" as const },
          },
        ],
        usage: { input_tokens: 500, output_tokens: 16_384 },
      },
    ]);

    await expect(
      extractWithTools(
        {
          body: "abcdefghij",
          systemPrompt: "test",
          userMessage: "Extract from:",
          sourceUrl: "https://x.test",
          fetchUrl: "https://x.test/",
        },
        makeDeps(client),
      ),
    ).rejects.toMatchObject({ name: "LoopFallbackError", reason: "max_tokens" });
  });
});

describe("extractWithTools — guidance placement", () => {
  function capturingClient(captured: Anthropic.MessageCreateParams[]): Pick<Anthropic, "messages"> {
    return {
      messages: {
        stream: ((params: Anthropic.MessageCreateParams) => {
          captured.push(params);
          return {
            finalMessage: async () =>
              ({
                id: "m1",
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
    };
  }

  test("emits guidance in a trailing system block after the cached static block", async () => {
    const captured: Anthropic.MessageCreateParams[] = [];
    await extractWithTools(
      {
        body: JSON.stringify({ a: 1 }),
        systemPrompt: "BASE_PROMPT",
        guidance: { parseInstructions: "PER_SOURCE_NOTE", playbookContext: "ORG_PLAYBOOK" },
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(capturingClient(captured)),
    );

    const sys = captured[0]!.system as Anthropic.TextBlockParam[];
    expect(sys).toHaveLength(2);
    // Static block carries the breakpoint and is free of volatile guidance —
    // so the prefix stays byte-identical (and cacheable) across sources.
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(sys[0]!.text).toContain("BASE_PROMPT");
    expect(sys[0]!.text).not.toContain("PER_SOURCE_NOTE");
    expect(sys[0]!.text).not.toContain("ORG_PLAYBOOK");
    // Guidance trails the breakpoint, uncached, but still delivered to the model.
    expect(sys[1]!.cache_control).toBeUndefined();
    expect(sys[1]!.text).toContain("PER_SOURCE_NOTE");
    expect(sys[1]!.text).toContain("ORG_PLAYBOOK");
  });

  test("omits the trailing block when no guidance is supplied", async () => {
    const captured: Anthropic.MessageCreateParams[] = [];
    await extractWithTools(
      {
        body: JSON.stringify({ a: 1 }),
        systemPrompt: "BASE_PROMPT",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(capturingClient(captured)),
    );

    const sys = captured[0]!.system as Anthropic.TextBlockParam[];
    expect(sys).toHaveLength(1);
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
  });
});
