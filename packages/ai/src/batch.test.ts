import { describe, it, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { submitBatch, pollBatch, collectResults } from "./batch.js";

type MessageBatch = Anthropic.Messages.Batches.MessageBatch;
type MessageBatchIndividualResponse = Anthropic.Messages.Batches.MessageBatchIndividualResponse;

type BatchesShape = {
  create: (params: unknown) => Promise<MessageBatch>;
  retrieve: (id: string) => Promise<MessageBatch>;
  results: (id: string) => Promise<AsyncIterable<MessageBatchIndividualResponse>>;
};

const stub = (name: string) => async () => {
  throw new Error(`${name} not stubbed`);
};

function makeClient(overrides: Partial<BatchesShape> = {}): Anthropic {
  return {
    messages: {
      batches: {
        create: overrides.create ?? stub("create"),
        retrieve: overrides.retrieve ?? stub("retrieve"),
        results: overrides.results ?? stub("results"),
      },
    },
  } as unknown as Anthropic;
}

const parseFirstTextBlock = (msg: Anthropic.Message): string => {
  const block = msg.content[0];
  if (!block || block.type !== "text") throw new Error("no text");
  return block.text;
};

function makeStream(
  lines: MessageBatchIndividualResponse[],
): AsyncIterable<MessageBatchIndividualResponse> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const line of lines) yield line;
    },
  };
}

const baseBatch: MessageBatch = {
  id: "msgbatch_abc",
  type: "message_batch",
  processing_status: "in_progress",
  archived_at: null,
  cancel_initiated_at: null,
  created_at: "2026-05-15T00:00:00Z",
  ended_at: null,
  expires_at: "2026-05-16T00:00:00Z",
  results_url: null,
  request_counts: { canceled: 0, errored: 0, expired: 0, processing: 0, succeeded: 0 },
};

describe("submitBatch", () => {
  it("forwards requests under a { requests } envelope and returns the batch", async () => {
    let captured: unknown = null;
    const client = makeClient({
      create: async (params) => {
        captured = params;
        return baseBatch;
      },
    });
    const requests = [
      {
        custom_id: "rel_1",
        params: {
          model: "claude-haiku-4-5",
          max_tokens: 100,
          messages: [{ role: "user" as const, content: "hi" }],
        },
      },
    ];
    const res = await submitBatch(client, requests);
    expect(captured).toEqual({ requests });
    expect(res.id).toBe("msgbatch_abc");
  });
});

describe("pollBatch", () => {
  it("polls with exponential backoff and returns when status === 'ended'", async () => {
    const delays: number[] = [];
    let n = 0;
    const client = makeClient({
      retrieve: async () => {
        n++;
        return { ...baseBatch, processing_status: n < 3 ? "in_progress" : "ended" };
      },
    });
    const res = await pollBatch(client, "msgbatch_abc", {
      initialDelayMs: 100,
      maxDelayMs: 400,
      backoffFactor: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(res.processing_status).toBe("ended");
    expect(delays).toEqual([100, 200, 400]);
    expect(n).toBe(3);
  });

  it("caps backoff at maxDelayMs", async () => {
    const delays: number[] = [];
    let n = 0;
    const client = makeClient({
      retrieve: async () => {
        n++;
        return { ...baseBatch, processing_status: n < 5 ? "in_progress" : "ended" };
      },
    });
    await pollBatch(client, "msgbatch_abc", {
      initialDelayMs: 100,
      maxDelayMs: 300,
      backoffFactor: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    // 100, 200, 300 (capped), 300, 300
    expect(delays).toEqual([100, 200, 300, 300, 300]);
  });

  it("throws when timeoutMs is exceeded", async () => {
    let n = 0;
    const client = makeClient({
      retrieve: async () => {
        n++;
        return { ...baseBatch, processing_status: "in_progress" };
      },
    });
    await expect(
      pollBatch(client, "msgbatch_abc", {
        initialDelayMs: 100,
        timeoutMs: 50,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(ms, 60))),
      }),
    ).rejects.toThrow(/timed out/);
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("invokes onPoll for each retrieve call", async () => {
    let n = 0;
    const statuses: string[] = [];
    const client = makeClient({
      retrieve: async () => {
        n++;
        return { ...baseBatch, processing_status: n < 2 ? "in_progress" : "ended" };
      },
    });
    await pollBatch(client, "msgbatch_abc", {
      initialDelayMs: 1,
      sleep: async () => {},
      onPoll: (b) => {
        statuses.push(b.processing_status);
      },
    });
    expect(statuses).toEqual(["in_progress", "ended"]);
  });
});

describe("collectResults", () => {
  it("maps succeeded lines through parse and keys by custom_id", async () => {
    const client = makeClient({
      results: async () =>
        makeStream([
          {
            custom_id: "rel_1",
            result: {
              type: "succeeded",
              message: { content: [{ type: "text", text: "x" }] } as unknown as Anthropic.Message,
            },
          },
          {
            custom_id: "rel_2",
            result: {
              type: "succeeded",
              message: { content: [{ type: "text", text: "y" }] } as unknown as Anthropic.Message,
            },
          },
        ]),
    });
    const out = await collectResults(client, "msgbatch_abc", parseFirstTextBlock);
    expect(out.get("rel_1")).toEqual({ kind: "succeeded", value: "x" });
    expect(out.get("rel_2")).toEqual({ kind: "succeeded", value: "y" });
  });

  it("surfaces upstream errored lines without poisoning siblings", async () => {
    const client = makeClient({
      results: async () =>
        makeStream([
          {
            custom_id: "rel_ok",
            result: {
              type: "succeeded",
              message: { content: [{ type: "text", text: "ok" }] } as unknown as Anthropic.Message,
            },
          },
          {
            custom_id: "rel_bad",
            result: {
              type: "errored",
              error: {
                type: "error",
                request_id: "req_bad",
                error: { type: "invalid_request_error", message: "bad input" },
              },
            },
          },
          {
            custom_id: "rel_ok2",
            result: {
              type: "succeeded",
              message: { content: [{ type: "text", text: "ok2" }] } as unknown as Anthropic.Message,
            },
          },
        ]),
    });
    const out = await collectResults(client, "msgbatch_abc", parseFirstTextBlock);
    expect(out.get("rel_ok")).toEqual({ kind: "succeeded", value: "ok" });
    expect(out.get("rel_bad")?.kind).toBe("errored");
    expect(out.get("rel_ok2")).toEqual({ kind: "succeeded", value: "ok2" });
  });

  it("catches parse exceptions and reports them as errored", async () => {
    const client = makeClient({
      results: async () =>
        makeStream([
          {
            custom_id: "rel_1",
            result: {
              type: "succeeded",
              message: { content: [] } as unknown as Anthropic.Message,
            },
          },
        ]),
    });
    const out = await collectResults(client, "msgbatch_abc", () => {
      throw new Error("parse fail");
    });
    const outcome = out.get("rel_1");
    expect(outcome?.kind).toBe("errored");
    if (outcome?.kind === "errored") {
      expect((outcome.error as Error).message).toBe("parse fail");
    }
  });

  it("maps canceled and expired outcomes", async () => {
    const client = makeClient({
      results: async () =>
        makeStream([
          { custom_id: "rel_c", result: { type: "canceled" } },
          { custom_id: "rel_e", result: { type: "expired" } },
        ]),
    });
    const out = await collectResults(client, "msgbatch_abc", (msg) => msg.content);
    expect(out.get("rel_c")).toEqual({ kind: "canceled" });
    expect(out.get("rel_e")).toEqual({ kind: "expired" });
  });

  it("passes the custom_id to parse for error context", async () => {
    const seen: string[] = [];
    const client = makeClient({
      results: async () =>
        makeStream([
          {
            custom_id: "rel_xyz",
            result: {
              type: "succeeded",
              message: { content: [{ type: "text", text: "v" }] } as unknown as Anthropic.Message,
            },
          },
        ]),
    });
    await collectResults(client, "msgbatch_abc", (_msg, id) => {
      seen.push(id);
      return id;
    });
    expect(seen).toEqual(["rel_xyz"]);
  });
});
