/**
 * Types for the extract package — AI-powered changelog extraction strategies
 * shared between the CLI (local DB deps) and the discovery worker (API deps).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  ReleaseType,
  Source,
  UsageExtractionMode,
  UsageFallbackReason,
} from "@buildinternet/releases-core/schema";

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
  /**
   * The source's stable typed id (`src_…`), when known. Preferred over
   * `sourceSlug` for attribution: slugs are only unique per-org (#690), so a
   * shared slug across orgs (e.g. "release-notes") makes slug→id resolution
   * ambiguous and silently drops attribution (source_id NULL). Callers that
   * have the `Source` in hand should always set this.
   */
  sourceId?: string | null;
  sourceSlug: string;
  releaseCount: number;
  extractionMode?: UsageExtractionMode;
  toolRounds?: number | null;
  toolChars?: number | null;
  fallbackReason?: UsageFallbackReason | null;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Injectable dependencies — the CLI wires these to local DB queries, the
 * discovery worker wires them to API-backed shims. Everything that touches
 * persistent state or non-portable runtime facilities goes here.
 */
export interface ExtractDeps {
  anthropicClient: Anthropic;
  /**
   * Model ID for the AGENTIC extraction paths (Sonnet-class): the web_fetch
   * loop (run-agent) and the large-body tool-use loop (extract-with-tools).
   * These are multi-turn tool loops where a Haiku-class model degrades, so
   * they stay on a stronger model regardless of `oneShotModel`.
   */
  agentModel: string;
  /**
   * Model ID for the SINGLE-CALL body extraction (`extract-from-body` runOneShot:
   * crawl one-shot, direct-fetch, seed/Cloudflare-render fallback). A single
   * forced-tool-call SDK request — Haiku-class parses these reliably at ~⅓ the
   * cost, so this defaults to Haiku in the worker. Falls back to `agentModel`
   * when unset (preserves the historical Sonnet behavior for callers that don't
   * set it, e.g. unit tests).
   */
  oneShotModel?: string;
  /** Model ID for the incremental parse (Haiku-class). Optional — callers may
   *  opt into the incremental strategy and supply this separately. */
  incrementalModel?: string;
  logger: ExtractLogger;
  cloudflare: { accountId: string; apiToken: string } | null;
  repo: ExtractRepo;
  /**
   * When true AND the body exceeds LARGE_BODY_TOKEN_THRESHOLD, extract-from-body
   * routes through the tool-use loop instead of inlining the body. Gated off by
   * default; flip EXTRACT_TOOLLOOP_ENABLED=true in the worker env to enable globally.
   * Per-source override: set source.metadata.extractStrategy = "toolloop".
   */
  extractToolLoopEnabled: boolean;
  /**
   * When set (worker resolved an OpenRouter extract model), the tool-loop routes
   * through extract-with-tools-aisdk instead of the Anthropic SDK loop. Typed
   * `unknown` to keep the `ai` types out of this shared package's surface.
   */
  aiSdkModel?: unknown;
  /**
   * Label for the model behind `aiSdkModel` (e.g. the OpenRouter `EXTRACT_MODEL`
   * id), reported as `modelUsed` on the AI-SDK tool-loop path so cost
   * attribution reflects the real model. Ignored when `aiSdkModel` is unset.
   */
  aiSdkModelLabel?: string;
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
