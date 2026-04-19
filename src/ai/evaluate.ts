import type { Source } from "@releases/core-internal/schema";
import { updateSourceMeta } from "../adapters/feed.js";
import { buildMetadataFromEvaluation, type EvaluationResult } from "@releases/ai-internal/evaluate";

export {
  buildMetadataFromEvaluation,
  evaluateChangelog,
  type EvaluationResult,
} from "@releases/ai-internal/evaluate";

/** DB-coupled: persist an evaluation result onto a source row. CLI-only. */
export async function applyEvaluation(source: Source, result: EvaluationResult): Promise<void> {
  const meta = buildMetadataFromEvaluation(result);
  await updateSourceMeta(source, meta);
}
