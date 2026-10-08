/**
 * Env-aware model resolution. Worker-safe aside from `process.env` (present
 * under `nodejs_compat`): no filesystem, no logger. The deprecation warning
 * for `RELEASED_*` names stays on `config`'s accessors, which are Node-only.
 */
import { MODEL_ROLE_ENV, modelId, type ModelRole } from "./models";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function roleEnv(role: ModelRole): readonly [string, string] | undefined {
  switch (role) {
    case "summarize":
    case "extraction":
    case "extractionAgent":
      return MODEL_ROLE_ENV[role];
    default:
      return undefined;
  }
}

/** Role pin, unless that role's `RELEASES_*` / `RELEASED_*` env var is set. */
export function resolveModel(role: ModelRole): string {
  const names = roleEnv(role);
  if (names) {
    const canonical = readEnv(names[0]);
    if (canonical) return canonical;
    const legacy = readEnv(names[1]);
    if (legacy) return legacy;
  }
  return modelId(role);
}
