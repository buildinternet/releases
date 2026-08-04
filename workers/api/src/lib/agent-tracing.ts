/**
 * Cloudflare Agents dashboard tracing for AI SDK `generateText` calls.
 *
 * Workers traces are already on in wrangler; this registers the Agents AI SDK
 * adapter so model/tool spans show under the Agents tab. Payload recording is
 * gated by Flagship `agent-trace-payloads-enabled` (default off). Fail-open
 * outside Workers (bun tests) — dynamic import of `cloudflare:workers` rejects.
 *
 * @see https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/
 */

import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";

/** Brand set by `createAISDKTelemetry` — used to replace rather than stack. */
const AGENTS_TELEMETRY_BRAND = Symbol.for("cloudflare.agents.ai-sdk-telemetry");

export interface AgentTracingEnv {
  FLAGS?: FlagshipBinding;
  AGENT_TRACE_PAYLOADS_ENABLED?: string;
}

type GlobalWithTelemetry = typeof globalThis & {
  AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[];
};

let installed: { storePayloads: boolean; ready: Promise<void> } | null = null;

function isAgentsTelemetry(integration: unknown): boolean {
  return (
    typeof integration === "object" && integration !== null && AGENTS_TELEMETRY_BRAND in integration
  );
}

async function register(storePayloads: boolean): Promise<void> {
  try {
    const [{ createAISDKTelemetry }] = await Promise.all([
      import("agents/observability/ai"),
      import("ai"), // ensure the AI SDK global integrations array exists
    ]);
    const g = globalThis as GlobalWithTelemetry;
    g.AI_SDK_TELEMETRY_INTEGRATIONS = [
      ...(g.AI_SDK_TELEMETRY_INTEGRATIONS ?? []).filter((i) => !isAgentsTelemetry(i)),
      createAISDKTelemetry({ storeMessages: storePayloads, storeTools: storePayloads }),
    ];
  } catch {
    // Outside Workers or agents package missing — leave generateText untraced.
  }
}

/**
 * Safe to await from every model-resolver path. Re-reads the payload flag each
 * call so a Flagship flip takes effect on the next AI call (replaces the branded
 * integration rather than stacking a second one).
 */
export async function ensureAgentTracing(env: AgentTracingEnv = {}): Promise<void> {
  const storePayloads = await flag(
    env.FLAGS,
    env.AGENT_TRACE_PAYLOADS_ENABLED,
    FLAGS.agentTracePayloadsEnabled,
  );
  if (installed?.storePayloads === storePayloads) return installed.ready;

  const ready = register(storePayloads);
  installed = { storePayloads, ready };
  return ready;
}
