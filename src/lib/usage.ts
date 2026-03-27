import { getDb } from "../db/connection.js";
import { usageLog } from "../db/schema.js";
import { isRemoteMode } from "./mode.js";

export async function logUsage(params: {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  sourceSlug?: string;
  releaseCount?: number;
}) {
  if (isRemoteMode()) return; // Usage logging is local-only for now
  const db = getDb();
  await db.insert(usageLog).values({
    operation: params.operation,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    sourceSlug: params.sourceSlug ?? null,
    releaseCount: params.releaseCount ?? null,
  });
}
