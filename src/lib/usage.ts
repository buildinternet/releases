import { getDb } from "../db/connection.js";
import { usageLog } from "../db/schema.js";
import { isRemoteMode } from "./mode.js";
import * as apiClient from "../api/client.js";

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

  if (isRemoteMode()) {
    // Fire-and-forget — usage logging shouldn't block the caller
    apiClient.postUsageLog(values).catch(() => {});
    return;
  }
  const db = getDb();
  await db.insert(usageLog).values(values);
}
