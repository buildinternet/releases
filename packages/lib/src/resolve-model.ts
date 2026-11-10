/**
 * Env-aware model resolution. Worker-safe aside from `process.env` (present
 * under `nodejs_compat`): no filesystem, no logger.
 */
import { MODEL_ROLE_ENV, modelId, type ModelRole } from "./models";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function roleEnv(role: ModelRole): string | undefined {
  switch (role) {
    case "summarize":
    case "extraction":
    case "extractionAgent":
      return MODEL_ROLE_ENV[role];
    default:
      return undefined;
  }
}

/** Role pin, unless that role's `RELEASES_*` env var is set. */
export function resolveModel(role: ModelRole): string {
  const name = roleEnv(role);
  return (name && readEnv(name)) || modelId(role);
}
