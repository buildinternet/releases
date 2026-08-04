/**
 * AI SDK v7 fields that project onto Cloudflare Agents dashboard identity.
 * Pure option bag — no Workers/`agents` dependency. Spans only appear when the
 * worker has registered `createAISDKTelemetry()` (`workers/api/src/lib/agent-tracing.ts`).
 *
 * Prefer typed entity ids (`src_…`, `rel_…`); never put secrets or PII here.
 *
 * @see https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/#ai-sdk
 */

export const RELEASES_AGENT_ID = "releases-api";

export interface AgentTelemetryOpts {
  /** Lane name → `gen_ai.agent.name` (via functionId). */
  functionId: string;
  /** Instance id → `gen_ai.agent.id`. Defaults to `releases-api`. */
  agentId?: string;
  /** Explicit conversation key; else `releaseId` then `sourceId`. */
  conversationId?: string;
  sourceId?: string;
  releaseId?: string;
}

/** Spread into `generateText({ ...agentTelemetry({ functionId }) })`. */
export function agentTelemetry(opts: AgentTelemetryOpts) {
  const agentId = opts.agentId ?? RELEASES_AGENT_ID;
  const conversationId = opts.conversationId ?? opts.releaseId ?? opts.sourceId;

  const runtimeContext = {
    agentId,
    ...(conversationId ? { conversationId } : {}),
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    ...(opts.releaseId ? { releaseId: opts.releaseId } : {}),
  };

  // Include every key we put on runtimeContext so CF maps them onto span attrs.
  const includeRuntimeContext = Object.fromEntries(
    Object.keys(runtimeContext).map((k) => [k, true as const]),
  );

  return {
    runtimeContext,
    telemetry: {
      functionId: opts.functionId,
      includeRuntimeContext,
    },
  };
}
