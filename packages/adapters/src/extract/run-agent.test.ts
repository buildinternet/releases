import { describe, expect, test } from "bun:test";
import { buildAgentUsageRows } from "./run-agent.js";
import type { ExtractFromBodyResult } from "./extract-from-body.js";

const AGENT_MODEL = "claude-sonnet-4-6";
const ONESHOT_MODEL = "claude-haiku-4-5-20251001";

function makeResult(over: Partial<ExtractFromBodyResult> = {}): ExtractFromBodyResult {
  return {
    entries: [],
    totalInput: 0,
    totalOutput: 0,
    hitMaxTokens: false,
    mode: "oneshot",
    toolRounds: null,
    toolChars: null,
    fallbackReason: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelUsed: AGENT_MODEL,
    ...over,
  };
}

const webFetchUsage = {
  totalInput: 1200,
  totalOutput: 300,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  entryCount: 1,
};

describe("buildAgentUsageRows", () => {
  test("splits into two model-attributed rows when web_fetch + CF spend on different models", () => {
    // `result` here is the post-aggregation combined object (web_fetch + CF).
    const result = makeResult({ totalInput: 9200, totalOutput: 800, modelUsed: ONESHOT_MODEL });
    const cfResult = makeResult({
      entries: [{ title: "cf" } as never],
      totalInput: 8000,
      totalOutput: 500,
      modelUsed: ONESHOT_MODEL,
      cacheReadTokens: 40,
    });

    const rows = buildAgentUsageRows({
      sourceSlug: "s",
      agentModel: AGENT_MODEL,
      result,
      webFetchUsage,
      cfResult,
    });

    expect(rows).toHaveLength(2);
    // Row 1: web_fetch spend under the agentic (Sonnet) model — not the combined total.
    expect(rows[0]!.model).toBe(AGENT_MODEL);
    expect(rows[0]!.inputTokens).toBe(1200);
    expect(rows[0]!.outputTokens).toBe(300);
    // Row 2: Cloudflare one-shot spend under its own (Haiku) model.
    expect(rows[1]!.model).toBe(ONESHOT_MODEL);
    expect(rows[1]!.inputTokens).toBe(8000);
    expect(rows[1]!.cacheReadTokens).toBe(40);
    // No double-counting: the two rows sum to the combined totals.
    expect(rows[0]!.inputTokens + rows[1]!.inputTokens).toBe(result.totalInput);
  });

  test("emits a single combined row when both extractions used the same model", () => {
    const cfResult = makeResult({ totalInput: 8000, totalOutput: 500, modelUsed: AGENT_MODEL });
    const result = makeResult({ totalInput: 9200, totalOutput: 800, modelUsed: AGENT_MODEL });

    const rows = buildAgentUsageRows({
      sourceSlug: "s",
      agentModel: AGENT_MODEL,
      result,
      webFetchUsage,
      cfResult,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe(AGENT_MODEL);
    expect(rows[0]!.inputTokens).toBe(9200);
  });

  test("emits a single row from result when the CF fallback never ran (jsRendered / no fallback)", () => {
    const result = makeResult({ totalInput: 5000, totalOutput: 400, modelUsed: ONESHOT_MODEL });

    const rows = buildAgentUsageRows({
      sourceSlug: "s",
      agentModel: AGENT_MODEL,
      result,
      webFetchUsage: null,
      cfResult: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe(ONESHOT_MODEL);
    expect(rows[0]!.inputTokens).toBe(5000);
  });

  test("does not split when the CF fallback spent nothing", () => {
    const cfResult = makeResult({ totalInput: 0, totalOutput: 0, modelUsed: ONESHOT_MODEL });
    const result = makeResult({ totalInput: 1200, totalOutput: 300, modelUsed: AGENT_MODEL });

    const rows = buildAgentUsageRows({
      sourceSlug: "s",
      agentModel: AGENT_MODEL,
      result,
      webFetchUsage,
      cfResult,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe(AGENT_MODEL);
  });
});
