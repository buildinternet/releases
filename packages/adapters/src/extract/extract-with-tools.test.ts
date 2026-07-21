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

function makeDeps(client: unknown, agentModel = "claude-sonnet-5"): ExtractDeps {
  return {
    anthropicClient: client as never,
    agentModel,
    logger: silentLogger,
    cloudflare: null,
    repo: {} as never,
    extractToolLoopEnabled: false,
  };
}

/** Capture each beta.messages.stream params object; replay sequential finalMessages. */
function capturingBetaClient(
  captured: Array<Record<string, unknown>>,
  responses: Array<Record<string, unknown>>,
) {
  let i = 0;
  return {
    beta: {
      messages: {
        stream: ((params: Record<string, unknown>) => {
          captured.push(params);
          const response = responses[i++] ?? responses[responses.length - 1]!;
          return { finalMessage: async () => response } as never;
        }) as never,
      },
    },
  };
}

function toolUseResponse(opts: {
  id: string;
  name: string;
  input: unknown;
  diagnostics?: {
    cache_miss_reason: { type: string; cache_missed_input_tokens?: number } | null;
  } | null;
  cacheRead?: number;
  cacheCreate?: number;
}): Record<string, unknown> {
  return {
    id: opts.id,
    type: "message",
    role: "assistant",
    model: "x",
    content: [
      {
        type: "tool_use",
        id: `t_${opts.id}`,
        name: opts.name,
        input: opts.input,
        caller: { type: "direct" as const },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: opts.cacheCreate ?? 0,
    },
    diagnostics: opts.diagnostics ?? null,
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
  // The determinism knob (temperature 0) is model-gated: models released after
  // Opus 4.6 (Sonnet 5, Opus 4.7+, Fable) reject a non-default temperature with a
  // 400, so it's omitted there and kept on models that still accept it (Sonnet
  // 4.6 / Haiku). See modelAcceptsTemperature in shared.ts.
  function captureToolLoopParams(agentModel: string) {
    const captured: Array<Record<string, unknown>> = [];
    const client = capturingBetaClient(captured, [
      {
        ...toolUseResponse({
          id: "msg_1",
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
        }),
        model: agentModel,
      },
    ]);
    return { captured, client };
  }

  const loopOpts = {
    body: JSON.stringify({ nodes: [{ title: "v1.0" }] }),
    systemPrompt: "test",
    userMessage: "Extract from:",
    sourceUrl: "https://x.test",
    fetchUrl: "https://x.test/feed.json",
  };

  test("tool-loop rounds omit temperature on Sonnet 5 (rejects non-default temperature)", async () => {
    const { captured, client } = captureToolLoopParams("claude-sonnet-5");
    await extractWithTools(loopOpts, makeDeps(client, "claude-sonnet-5"));
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured.every((p) => p.temperature === undefined)).toBe(true);
  });

  test("tool-loop rounds request temperature 0 on models that still accept it", async () => {
    const { captured, client } = captureToolLoopParams("claude-sonnet-4-6");
    await extractWithTools(loopOpts, makeDeps(client, "claude-sonnet-4-6"));
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
  const twoRoundSliceThenExtract = [
    toolUseResponse({
      id: "msg_round1",
      name: "get_slice",
      input: { start: 0, length: 5 },
      cacheCreate: 800,
    }),
    toolUseResponse({
      id: "msg_round2",
      name: "extract_releases",
      input: { releases: [] },
      cacheRead: 50,
      diagnostics: {
        cache_miss_reason: { type: "messages_changed", cache_missed_input_tokens: 900 },
      },
    }),
  ];

  test("marks most-recent tool_result with cache_control on each new round", async () => {
    const captured: Array<Record<string, unknown>> = [];
    await extractWithTools(
      {
        body: "abcdef",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/",
      },
      makeDeps(capturingBetaClient(captured, twoRoundSliceThenExtract)),
    );

    expect(captured.length).toBeGreaterThanOrEqual(2);
    const msgs = (captured[1] as { messages: Anthropic.MessageParam[] }).messages;
    const lastUser = msgs[msgs.length - 1]!;
    expect(lastUser.role).toBe("user");
    const content = lastUser.content as Anthropic.ToolResultBlockParam[];
    expect(content[content.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("opts into cache diagnostics and threads previous_message_id across rounds", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const warns: string[] = [];
    await extractWithTools(
      {
        body: "abcdef",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/",
      },
      {
        ...makeDeps(capturingBetaClient(captured, twoRoundSliceThenExtract)),
        logger: { info: () => {}, debug: () => {}, warn: (msg: string) => warns.push(msg) },
      },
    );

    expect(captured).toHaveLength(2);
    expect(captured[0]!.betas).toEqual(["cache-diagnosis-2026-04-07"]);
    expect(captured[0]!.diagnostics).toEqual({ previous_message_id: null });
    expect(captured[1]!.diagnostics).toEqual({ previous_message_id: "msg_round1" });
    expect(
      warns.some((w) => w.includes("type=messages_changed") && w.includes("missedTokens=900")),
    ).toBe(true);
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

describe("extractWithTools — in-band record validation (#1874)", () => {
  test("accepts a batch where every entry passes validation, unchanged", async () => {
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
                  content: "Adds a new feature.",
                  isBreaking: false,
                  publishedAt: "2026-04-01",
                  url: "https://x.test/r/1",
                },
              ],
            },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ]);

    const result = await extractWithTools(
      {
        body: "irrelevant",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(client),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.toolRounds).toBe(0);
  });

  test("rejects a bad record in-band, then accepts the corrected resubmission", async () => {
    const client = mockAnthropicClient([
      {
        // Round 1: bad URL (wrong host) — should be rejected in-band, not returned.
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
                  content: "Adds a new feature.",
                  isBreaking: false,
                  publishedAt: "2026-04-01",
                  url: "https://totally-unrelated-domain.org/r/1",
                },
              ],
            },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      {
        // Round 2: corrected URL — should terminate successfully.
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "extract_releases",
            caller: { type: "direct" as const },
            input: {
              releases: [
                {
                  title: "v1.0",
                  content: "Adds a new feature.",
                  isBreaking: false,
                  publishedAt: "2026-04-01",
                  url: "https://x.test/r/1",
                },
              ],
            },
          },
        ],
        usage: { input_tokens: 120, output_tokens: 15 },
      },
    ]);

    const result = await extractWithTools(
      {
        body: "irrelevant",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(client),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.url).toBe("https://x.test/r/1");
    // One retry round was consumed getting the model to correct its answer.
    expect(result.toolRounds).toBe(1);
    expect(result.totalInput).toBe(220);
  });

  test("sends an actionable tool_result back to the model on rejection", async () => {
    const captured: Array<Record<string, unknown>> = [];
    await extractWithTools(
      {
        body: "irrelevant",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(
        capturingBetaClient(captured, [
          toolUseResponse({
            id: "m1",
            name: "extract_releases",
            input: {
              releases: [{ title: "", content: "x", isBreaking: false, url: "https://x.test/1" }],
            },
          }),
          toolUseResponse({
            id: "m2",
            name: "extract_releases",
            input: {
              releases: [{ title: "v1", content: "x", isBreaking: false, url: "https://x.test/1" }],
            },
          }),
        ]),
      ),
    );

    expect(captured.length).toBe(2);
    const msgs = (captured[1] as { messages: Anthropic.MessageParam[] }).messages;
    const lastUser = msgs[msgs.length - 1]!;
    const content = lastUser.content as Anthropic.ToolResultBlockParam[];
    const rejectionResult = content.find((c) => c.tool_use_id === "t_m1")!;
    expect(rejectionResult.content).toContain("rejected and NOT recorded");
    expect(rejectionResult.content).toContain("empty title");
  });

  test("fails open after the validation retry cap — accepts a persistently bad record", async () => {
    // The model keeps emitting the same bad record every round; after
    // MAX_VALIDATION_RETRIES the loop must stop retrying and accept it so
    // post-hoc validation (the backstop) can handle it, rather than looping
    // forever or throwing a fallback.
    const badRelease = {
      title: "v1.0",
      content: "x",
      isBreaking: false,
      url: "https://totally-unrelated-domain.org/r/1",
    };
    const badResponse = {
      stop_reason: "tool_use" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "t",
          name: "extract_releases",
          input: { releases: [badRelease] },
          caller: { type: "direct" as const },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 10 },
    };

    // MAX_VALIDATION_RETRIES rejections, then one more identical call that
    // must now be accepted (retries exhausted).
    const client = mockAnthropicClient([badResponse, badResponse, badResponse]);

    const result = await extractWithTools(
      {
        body: "irrelevant",
        systemPrompt: "test",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(client),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.url).toBe("https://totally-unrelated-domain.org/r/1");
    expect(result.toolRounds).toBe(2);
  });
});

describe("extractWithTools — guidance placement", () => {
  const terminal = [
    toolUseResponse({ id: "m1", name: "extract_releases", input: { releases: [] } }),
  ];

  test("emits guidance in a trailing system block after the cached static block", async () => {
    const captured: Array<Record<string, unknown>> = [];
    await extractWithTools(
      {
        body: JSON.stringify({ a: 1 }),
        systemPrompt: "BASE_PROMPT",
        guidance: { parseInstructions: "PER_SOURCE_NOTE", playbookContext: "ORG_PLAYBOOK" },
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(capturingBetaClient(captured, terminal)),
    );

    const sys = (captured[0] as { system: Anthropic.TextBlockParam[] }).system;
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
    const captured: Array<Record<string, unknown>> = [];
    await extractWithTools(
      {
        body: JSON.stringify({ a: 1 }),
        systemPrompt: "BASE_PROMPT",
        userMessage: "Extract from:",
        sourceUrl: "https://x.test",
        fetchUrl: "https://x.test/feed.json",
      },
      makeDeps(capturingBetaClient(captured, terminal)),
    );

    const sys = (captured[0] as { system: Anthropic.TextBlockParam[] }).system;
    expect(sys).toHaveLength(1);
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
  });
});
