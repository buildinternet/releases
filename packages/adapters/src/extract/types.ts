/**
 * Types for the extract package — AI-powered changelog extraction strategies
 * shared between the CLI (local DB deps) and the discovery worker (API deps).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ReleaseType, Source } from "@buildinternet/releases-core/schema";

export interface ExtractedEntry {
  version?: string;
  title: string;
  url?: string;
  content: string;
  publishedAt?: string;
  isBreaking: boolean;
  type?: ReleaseType;
  media?: Array<{ type: "image" | "video" | "gif"; url: string; alt?: string }>;
}

export interface KnownRelease {
  version: string | null;
  title: string;
  publishedAt: string | null;
}

export interface ExtractLogger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
  error?(msg: string): void;
}

export interface UsageEntry {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  sourceSlug: string;
  releaseCount: number;
}

/**
 * Injectable dependencies — the CLI wires these to local DB queries, the
 * discovery worker wires them to API-backed shims. Everything that touches
 * persistent state or non-portable runtime facilities goes here.
 */
export interface ExtractDeps {
  anthropicClient: Anthropic;
  /** Model ID for the full-extraction path (Sonnet-class). */
  agentModel: string;
  /** Model ID for the incremental parse (Haiku-class). Optional — callers may
   *  opt into the incremental strategy and supply this separately. */
  incrementalModel?: string;
  logger: ExtractLogger;
  cloudflare: { accountId: string; apiToken: string } | null;
  repo: ExtractRepo;
}

export interface ExtractRepo {
  /**
   * Check whether `hash` matches what's stored for this source.
   * Returns true when unchanged (caller should skip extraction).
   */
  peekContentHash(source: Source, hash: string): Promise<boolean>;
  /** Commit a new content hash. No-op if stored hash already matches. */
  commitContentHash(source: Source, hash: string): Promise<void>;
  /**
   * Atomic JSON-merge of the source metadata blob. Null values delete
   * their keys. Both implementations must be safe against concurrent writers
   * (cron poll, other fetches).
   */
  updateSourceMeta(source: Source, patch: Record<string, unknown>): Promise<void>;
  /** Load the org's playbook notes, or null if none. */
  getOrgPlaybook(orgId: string | null): Promise<string | null>;
  logUsage(entry: UsageEntry): Promise<void>;
}
