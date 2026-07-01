import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { legacyEnv } from "./legacy-env";

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

export const config = {
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY || "",
  cloudflareAccountId: () => process.env.CLOUDFLARE_ACCOUNT_ID || "",
  cloudflareApiToken: () => process.env.CLOUDFLARE_API_TOKEN || "",
  githubToken: () => process.env.GITHUB_TOKEN || "",
  ingestModel: () =>
    legacyEnv("RELEASES_INGEST_MODEL", "RELEASED_INGEST_MODEL") || "claude-haiku-4-5-20251001",
  agentModel: () => legacyEnv("RELEASES_AGENT_MODEL", "RELEASED_AGENT_MODEL") || "claude-sonnet-5",
  queryModel: () => legacyEnv("RELEASES_QUERY_MODEL", "RELEASED_QUERY_MODEL") || "claude-sonnet-5",
  summaryModel: () =>
    legacyEnv("RELEASES_SUMMARY_MODEL", "RELEASED_SUMMARY_MODEL") || "claude-haiku-4-5-20251001",
  groupingModel: () =>
    legacyEnv("RELEASES_GROUPING_MODEL", "RELEASED_GROUPING_MODEL") || "claude-haiku-4-5-20251001",
  workerAgentModel: () =>
    legacyEnv("RELEASES_WORKER_AGENT_MODEL", "RELEASED_WORKER_AGENT_MODEL") || "claude-haiku-4-5",
  apiUrl: () => legacyEnv("RELEASES_API_URL", "RELEASED_API_URL") || "",
  stagingApiUrl: () => legacyEnv("RELEASES_STAGING_API_URL", "RELEASED_STAGING_API_URL") || "",
  apiKey: () => legacyEnv("RELEASES_API_KEY", "RELEASED_API_KEY") || "",
} as const;
