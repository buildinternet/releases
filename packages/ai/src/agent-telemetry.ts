/**
 * Re-export — single implementation lives in `@releases/adapters/agent-telemetry`
 * so extract + cheap-call lanes share one mapping (adapters cannot import
 * `@releases/ai-internal`).
 */
export {
  agentTelemetry,
  RELEASES_AGENT_ID,
  type AgentTelemetryOpts,
} from "@releases/adapters/agent-telemetry";
