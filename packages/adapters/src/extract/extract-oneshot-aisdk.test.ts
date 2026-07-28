/**
 * Unit tests for the AI-SDK one-shot extraction path (issue #2166). Mirrors the
 * `extract-with-tools-aisdk.spike.test.ts` pattern: drives the loop against a
 * mocked Anthropic `fetch` via `anthropicSpikeModel` (exported by the tool-loop
 * module, reused here) so we get real wire-shape assertions with no network.
 */
import { describe, expect, it } from "bun:test";
import { anthropicSpikeModel } from "./extract-with-tools-aisdk.js";
import { runOneShotAiSdk, type OneShotAiSdkDeps } from "./extract-oneshot-aisdk.js";

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

interface AnthropicWireBody {
  system?: Array<{ type: string; text: string; cache_control?: { type: string } }> | string;
  temperature?: number;
  tool_choice?: { type: string; name?: string };
  max_tokens?: number;
}

function anthropicResponse(content: unknown[], usage: Record<string, number> = {}): Response {
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
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const terminalContent = [
  {
    type: "tool_use",
    id: "tu_1",
    name: "extract_releases",
    input: {
      releases: [{ title: "v1.0", content: "First release.", isBreaking: false }],
    },
  },
];

function makeDeps(overrides: {
  modelLabel: string;
  mockFetch: typeof globalThis.fetch;
}): OneShotAiSdkDeps {
  return {
    model: anthropicSpikeModel({
      apiKey: "sk-test",
      model: overrides.modelLabel,
      fetch: overrides.mockFetch,
    }),
    modelLabel: overrides.modelLabel,
    logger: silentLogger,
  };
}

const baseOpts = {
  body: "# Changelog\n\n## v1.0\nFirst release.\n",
  systemPrompt: "You are a changelog parser.",
  userMessage: "Extract all releases.",
  maxOutputTokens: 16_384,
};

describe("runOneShotAiSdk", () => {
  it("sends a single forced extract_releases call and parses the terminal", async () => {
    const requests: AnthropicWireBody[] = [];
    const mockFetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as AnthropicWireBody);
      return anthropicResponse(terminalContent, { input_tokens: 500, output_tokens: 30 });
    }) as unknown as typeof globalThis.fetch;

    const result = await runOneShotAiSdk(
      baseOpts,
      makeDeps({ modelLabel: "claude-haiku-4-5", mockFetch }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.tool_choice).toEqual({ type: "tool", name: "extract_releases" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("v1.0");
    expect(result.totalInput).toBe(500);
    expect(result.totalOutput).toBe(30);
    expect(result.hitMaxTokens).toBe(false);
  });

  it("requests temperature 0 on a model that accepts it", async () => {
    const requests: AnthropicWireBody[] = [];
    const mockFetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as AnthropicWireBody);
      return anthropicResponse(terminalContent);
    }) as unknown as typeof globalThis.fetch;

    await runOneShotAiSdk(baseOpts, makeDeps({ modelLabel: "claude-haiku-4-5", mockFetch }));

    expect(requests[0]!.temperature).toBe(0);
  });

  it("omits temperature on a model that rejects it (Sonnet 5)", async () => {
    const requests: AnthropicWireBody[] = [];
    const mockFetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as AnthropicWireBody);
      return anthropicResponse(terminalContent);
    }) as unknown as typeof globalThis.fetch;

    await runOneShotAiSdk(baseOpts, makeDeps({ modelLabel: "claude-sonnet-5", mockFetch }));

    expect(requests[0]!.temperature).toBeUndefined();
  });

  it("places the static cache_control breakpoint on the system prefix", async () => {
    const requests: AnthropicWireBody[] = [];
    const mockFetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as AnthropicWireBody);
      return anthropicResponse(terminalContent);
    }) as unknown as typeof globalThis.fetch;

    await runOneShotAiSdk(baseOpts, makeDeps({ modelLabel: "claude-haiku-4-5", mockFetch }));

    const sys = requests[0]!.system as Array<{ text: string; cache_control?: { type: string } }>;
    expect(Array.isArray(sys)).toBe(true);
    const cached = sys.find((b) => b.cache_control?.type === "ephemeral");
    expect(cached).toBeDefined();
    expect(cached!.text).toContain("changelog parser");
  });

  it("appends the guardrail as a second, uncached system block when set", async () => {
    const requests: AnthropicWireBody[] = [];
    const mockFetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as AnthropicWireBody);
      return anthropicResponse(terminalContent);
    }) as unknown as typeof globalThis.fetch;

    await runOneShotAiSdk(
      { ...baseOpts, guardrail: "GUARDRAIL_TEXT" },
      makeDeps({ modelLabel: "claude-haiku-4-5", mockFetch }),
    );

    const sys = requests[0]!.system as Array<{ text: string; cache_control?: { type: string } }>;
    expect(sys.length).toBeGreaterThanOrEqual(2);
    const guardrailBlock = sys.find((b) => b.text === "GUARDRAIL_TEXT");
    expect(guardrailBlock).toBeDefined();
    expect(guardrailBlock!.cache_control).toBeUndefined();
  });

  it("reports hitMaxTokens when the response stops on length", async () => {
    const lengthMockFetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_len",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          stop_reason: "max_tokens",
          stop_sequence: null,
          content: [],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;

    const result = await runOneShotAiSdk(
      baseOpts,
      makeDeps({ modelLabel: "claude-haiku-4-5", mockFetch: lengthMockFetch }),
    );

    expect(result.hitMaxTokens).toBe(true);
    expect(result.entries).toHaveLength(0);
  });

  it("returns no entries when the terminal input has a malformed releases field", async () => {
    const mockFetch = (async () =>
      anthropicResponse([
        { type: "tool_use", id: "tu_bad", name: "extract_releases", input: { releases: "nope" } },
      ])) as unknown as typeof globalThis.fetch;

    const result = await runOneShotAiSdk(
      baseOpts,
      makeDeps({ modelLabel: "claude-haiku-4-5", mockFetch }),
    );

    expect(result.entries).toHaveLength(0);
  });
});
