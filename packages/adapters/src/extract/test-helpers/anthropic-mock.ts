import type Anthropic from "@anthropic-ai/sdk";

interface MockedResponse {
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  content: Anthropic.ContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** Optional cache-diagnosis payload (tool-loop beta path). */
  diagnostics?: {
    cache_miss_reason: { type: string; cache_missed_input_tokens?: number } | null;
  } | null;
}

/**
 * Stand-in Anthropic client. Both `beta.messages.stream` (tool-loop) and
 * `messages.stream` (one-shot) share one response queue so tiered fallbacks
 * keep working. Throws if a test exhausts the pre-seeded responses.
 */
export function mockAnthropicClient(
  responses: MockedResponse[],
): Pick<Anthropic, "messages" | "beta"> {
  let i = 0;
  const stream = (() => {
    if (i >= responses.length) {
      throw new Error(`mockAnthropicClient ran out of responses after ${i} calls`);
    }
    const resp = responses[i++]!;
    const finalMessage = Promise.resolve({
      id: `msg_${i}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: resp.content,
      stop_reason: resp.stop_reason,
      stop_sequence: null,
      usage: {
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
        cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: resp.usage.cache_creation_input_tokens ?? 0,
      },
      diagnostics: resp.diagnostics ?? null,
    });
    return { finalMessage: () => finalMessage } as never;
  }) as never;

  return {
    messages: { stream } as never,
    beta: { messages: { stream } } as never,
  };
}
