import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

let _dataDir: string | null = null;

export function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = process.env.RELEASED_DATA_DIR || join(homedir(), ".released");
    mkdirSync(_dataDir, { recursive: true });
  }
  return _dataDir;
}

export function getDbPath(): string {
  return join(getDataDir(), "released.db");
}

export function getLogsDir(): string {
  const dir = join(getDataDir(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const config = {
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY || "",
  cloudflareAccountId: () => process.env.CLOUDFLARE_ACCOUNT_ID || "",
  cloudflareApiToken: () => process.env.CLOUDFLARE_API_TOKEN || "",
  githubToken: () => process.env.GITHUB_TOKEN || "",
  ingestModel: () => process.env.RELEASED_INGEST_MODEL || "claude-haiku-4-5-20251001",
  agentModel: () => process.env.RELEASED_AGENT_MODEL || "claude-sonnet-4-6",
  queryModel: () => process.env.RELEASED_QUERY_MODEL || "claude-sonnet-4-6",
  summaryModel: () => process.env.RELEASED_SUMMARY_MODEL || "claude-haiku-4-5-20251001",
  apiUrl: () => process.env.RELEASED_API_URL || "",
  apiKey: () => process.env.RELEASED_API_KEY || "",
} as const;
