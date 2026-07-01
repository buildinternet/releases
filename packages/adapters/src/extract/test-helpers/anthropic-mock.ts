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
}

/**
 * Produces a stand-in for an Anthropic client whose messages.stream() returns
 * the provided responses in order — one call per round. Throws if the test
 * asks for more rounds than were pre-seeded.
 */
export function mockAnthropicClient(responses: MockedResponse[]): Pick<Anthropic, "messages"> {
  let i = 0;
  return {
    messages: {
      stream: (() => {
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
        } as Anthropic.Message);
        return { finalMessage: () => finalMessage } as never;
      }) as never,
    } as never,
  };
}
