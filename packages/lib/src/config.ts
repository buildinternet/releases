import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { legacyEnv } from "./legacy-env";
import { MODEL_ROLE_ENV, modelId } from "./models";

let _dataDir: string | null = null;

export function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = legacyEnv("RELEASES_DATA_DIR", "RELEASED_DATA_DIR") || join(homedir(), ".releases");
    mkdirSync(_dataDir, { recursive: true });
  }
  return _dataDir;
}

export function getDbPath(): string {
  return join(getDataDir(), "releases.db");
}

export function getLogsDir(): string {
  const dir = join(getDataDir(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Home for local eval artifacts (`~/.releases/evals` by default). Mirrors
 * getLogsDir: eval results and review workspaces live under the global data dir
 * — out of the repo tree, alongside logs — rather than inside tests/evals. The
 * eval harness writes `evals/results/` (saveRun JSON) and `evals/runs/` (viewer
 * workspaces) under here.
 */
export function getEvalsDir(): string {
  const dir = join(getDataDir(), "evals");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function envOrPin(role: keyof typeof MODEL_ROLE_ENV): string {
  const [canonical, legacy] = MODEL_ROLE_ENV[role];
  return legacyEnv(canonical, legacy) || modelId(role);
}

/**
 * CLI accessors. Defaults are the model-registry pins (`@releases/lib/models`);
 * `RELEASES_*` / `RELEASED_*` override them, with a one-time warning on the
 * legacy name. Workers do not import this module (it touches the filesystem).
 * Live calls use `resolveModel`, which reads the same three role env vars
 * without the warning.
 *
 * `queryModel`, `groupingModel`, and `workerAgentModel` have no remaining
 * call site — grouping is deterministic, and the query / worker-agent loops
 * are gone. Their defaults still come from the registry so this object is
 * not a second list of model ids.
 */
export const config = {
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY || "",
  cloudflareAccountId: () => process.env.CLOUDFLARE_ACCOUNT_ID || "",
  cloudflareApiToken: () => process.env.CLOUDFLARE_API_TOKEN || "",
  githubToken: () => process.env.GITHUB_TOKEN || "",
  ingestModel: () => envOrPin("extraction"),
  agentModel: () => envOrPin("extractionAgent"),
  queryModel: () =>
    legacyEnv("RELEASES_QUERY_MODEL", "RELEASED_QUERY_MODEL") || modelId("extractionAgent"),
  summaryModel: () => envOrPin("summarize"),
  groupingModel: () =>
    legacyEnv("RELEASES_GROUPING_MODEL", "RELEASED_GROUPING_MODEL") || modelId("summarize"),
  workerAgentModel: () =>
    legacyEnv("RELEASES_WORKER_AGENT_MODEL", "RELEASED_WORKER_AGENT_MODEL") ||
    modelId("extraction"),
  apiUrl: () => legacyEnv("RELEASES_API_URL", "RELEASED_API_URL") || "",
  stagingApiUrl: () => legacyEnv("RELEASES_STAGING_API_URL", "RELEASED_STAGING_API_URL") || "",
  apiKey: () => legacyEnv("RELEASES_API_KEY", "RELEASED_API_KEY") || "",
} as const;
