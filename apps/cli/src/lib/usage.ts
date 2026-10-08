import { postUsageLog } from "../api/sources.js";

export async function logUsage(params: {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  sourceSlug?: string;
  releaseCount?: number;
}) {
  const values = {
    operation: params.operation,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    sourceSlug: params.sourceSlug ?? null,
    releaseCount: params.releaseCount ?? null,
  };

  // Fire-and-forget — usage logging shouldn't block the caller.
  postUsageLog(values).catch(() => {});
}
