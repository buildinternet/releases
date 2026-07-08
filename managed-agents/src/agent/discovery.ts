// ── Types ──────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

export interface AgentDiscoveredSource {
  url: string;
  type: "github" | "scrape" | "feed";
  slug: string;
  label: string;
  confidence: Confidence;
  validated: boolean;
  validationError?: string;
  releaseCount?: number;
  duplicateOf?: string;
  approved?: boolean;
  fetched?: boolean;
  releasesFetched?: number;
  contentDepth?: "full" | "summary-only";
  /**
   * Canonical product name this source belongs to (same naming rules as sources —
   * no org prefix). Only set when the org ships 2+ genuinely distinct products.
   * Leave unset to attach the source directly to the org (the default).
   */
  productName?: string;
  /**
   * Stable kebab-case product slug, per-org unique.
   * Only set alongside productName when the org ships 2+ genuinely distinct products.
   */
  productSlug?: string;
}

export interface DiscoveryState {
  product: string;
  domain?: string;
  githubOrg?: string;
  startedAt: string;
  updatedAt: string;
  status: "discovering" | "awaiting_review" | "approved" | "fetching" | "complete" | "error";
  sources: AgentDiscoveredSource[];
  agentSessionId?: string;
  costUsd?: number;
  turns?: number;
}

/** Status event emitted during discovery for StatusHub integration. */
export interface DiscoveryStatusEvent {
  type: "session:start" | "session:progress" | "session:complete" | "session:error";
  sessionId: string;
  company: string;
  [key: string]: unknown;
}

export interface DiscoveryOptions {
  company: string;
  domain?: string;
  githubOrg?: string;
  onProgress?: (text: string) => void;
  onToolUse?: (toolName: string, command?: string) => void;
  /** Emitted for StatusHub integration — maps agent events to session lifecycle. */
  onStatusEvent?: (event: DiscoveryStatusEvent) => void;
}

// ── Discovery prompt ───────────────────────────────────────────────

/** Build the user-facing discovery prompt with optional domain/org hints. */
export function buildDiscoveryPrompt(
  options: Pick<DiscoveryOptions, "company" | "domain" | "githubOrg">,
): string {
  const hints: string[] = [];
  if (options.domain) hints.push(`Their website is ${options.domain}.`);
  if (options.githubOrg) hints.push(`Their GitHub organization is ${options.githubOrg}.`);
  const hintStr = hints.length > 0 ? " " + hints.join(" ") : "";
  return `Find and evaluate changelog sources for "${options.company}".${hintStr} Check what we already have, discover new sources, validate them with dry-run fetches, then do a real fetch (--max 50) for each validated source to seed initial releases. For feed sources, note in the state file whether content appears sparse (short summaries) so crawl mode can be enabled after fetching.`;
}
