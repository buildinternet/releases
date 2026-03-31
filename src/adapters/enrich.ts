import type { Release } from "../db/schema.js";
import { updateRelease, getEnrichableReleases, findSourceBySlug } from "../db/queries.js";
import { fetchCloudflareMarkdown } from "./cloudflare.js";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { logUsage } from "../lib/usage.js";
import { getAnthropicClient } from "../ai/client.js";

// ── Config ──────────────────────────────────────────────────────────

/** Max parallel page fetches. */
const CONCURRENCY = 5;

/** Max markdown length to send to AI for extraction. */
const MAX_MARKDOWN_CHARS = 100_000;

// ── Types ───────────────────────────────────────────────────────────

export interface EnrichResult {
  enriched: number;
  skipped: number;
  errors: number;
  triageTokens: number;
  extractTokens: number;
  releases: Array<{
    id: string;
    title: string;
    status: "enriched" | "skipped" | "error";
    reason?: string;
  }>;
}

export interface EnrichOptions {
  dryRun?: boolean;
  limit?: number;
  sourceSlug: string;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Enrich releases for a source by fetching individual page URLs.
 * Uses Haiku to triage which releases need enrichment, then fetches
 * and extracts content for those that do.
 */
export async function enrichReleases(options: EnrichOptions): Promise<EnrichResult> {
  const source = await findSourceBySlug(options.sourceSlug);
  if (!source) throw new Error(`Source not found: ${options.sourceSlug}`);

  const accountId = config.cloudflareAccountId();
  const apiToken = config.cloudflareApiToken();
  if (!accountId || !apiToken) {
    throw new Error("Cloudflare credentials required (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN)");
  }

  const apiKey = config.anthropicApiKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required for enrichment");

  let candidates = await getEnrichableReleases(source.id, source.slug);
  if (options.limit) candidates = candidates.slice(0, options.limit);

  if (candidates.length === 0) {
    return { enriched: 0, skipped: 0, errors: 0, triageTokens: 0, extractTokens: 0, releases: [] };
  }

  logger.info(`Triaging ${candidates.length} releases for enrichment...`);

  // Phase 1: Haiku triage — which releases need enrichment?
  const triageResults = await mapWithConcurrency(
    candidates,
    (r) => triageRelease(r, options.sourceSlug),
    CONCURRENCY,
  );

  const needsEnrichment = triageResults.filter((t) => t.needsEnrichment);
  const skippedTriage = triageResults.filter((t) => !t.needsEnrichment);

  logger.info(`Triage: ${needsEnrichment.length} need enrichment, ${skippedTriage.length} already rich`);

  // Phase 2: Fetch and extract content for releases that need it
  const extractResults = await mapWithConcurrency(
    needsEnrichment,
    (t) => extractAndUpdate(t.release, accountId, apiToken, options),
    CONCURRENCY,
  );

  // Tally results
  const result: EnrichResult = {
    enriched: extractResults.filter((r) => r.status === "enriched").length,
    skipped: skippedTriage.length + extractResults.filter((r) => r.status === "skipped").length,
    errors: extractResults.filter((r) => r.status === "error").length,
    triageTokens: triageResults.reduce((sum, t) => sum + t.tokens, 0),
    extractTokens: extractResults.reduce((sum, r) => sum + r.tokens, 0),
    releases: [
      ...skippedTriage.map((t) => ({
        id: t.release.id, title: t.release.title,
        status: "skipped" as const, reason: t.reason,
      })),
      ...extractResults,
    ],
  };

  return result;
}

// ── Haiku triage ────────────────────────────────────────────────────

const TRIAGE_SYSTEM = `You are evaluating whether a release note entry needs enrichment. The entry was parsed from an RSS/Atom feed and may only contain a summary. A URL to the full release page exists.

Answer with a JSON object: {"needsEnrichment": true/false, "reason": "brief explanation"}

Return true if the content looks like a short summary or teaser that likely has a fuller version on the dedicated page (e.g., one sentence, no detail, no images, no code examples).
Return false if the content already has meaningful detail (multiple paragraphs, code blocks, specific feature descriptions, images).`;

interface TriageResult {
  release: Release;
  needsEnrichment: boolean;
  reason: string;
  tokens: number;
}

async function triageRelease(release: Release, sourceSlug: string): Promise<TriageResult> {
  const client = getAnthropicClient();
  const model = config.ingestModel();

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 128,
      system: TRIAGE_SYSTEM,
      messages: [{
        role: "user",
        content: `Title: ${release.title}\nContent: ${release.content}\nURL: ${release.url}`,
      }],
    });

    const text = response.content.find(
      (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
    )?.text ?? "";

    const tokens = response.usage.input_tokens + response.usage.output_tokens;

    await logUsage({
      operation: "enrich-judge",
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      sourceSlug,
      releaseCount: 1,
    });

    try {
      const parsed = JSON.parse(text);
      return {
        release,
        needsEnrichment: parsed.needsEnrichment === true,
        reason: parsed.reason ?? "",
        tokens,
      };
    } catch {
      // If Haiku returns non-JSON, assume needs enrichment if content is short
      return { release, needsEnrichment: release.content.length < 200, reason: "triage parse error", tokens };
    }
  } catch (err) {
    logger.debug(`Triage failed for ${release.title}: ${err instanceof Error ? err.message : String(err)}`);
    return { release, needsEnrichment: false, reason: "triage error", tokens: 0 };
  }
}

// ── Content extraction ──────────────────────────────────────────────

const EXTRACT_SYSTEM = `You are a release notes extractor. Given the markdown content of a release/changelog page, extract ONLY the release notes content. Strip navigation, headers, footers, sidebars, and other page chrome. Return just the release notes text as clean markdown.

Be concise. Keep the essential information: what changed, new features, bug fixes, breaking changes. Remove boilerplate. Preserve image URLs as markdown image links (![alt](url)). Preserve video embed URLs.`;

interface ExtractResult {
  id: string;
  title: string;
  status: "enriched" | "skipped" | "error";
  reason?: string;
  tokens: number;
}

async function extractAndUpdate(
  release: Release,
  accountId: string,
  apiToken: string,
  options: EnrichOptions,
): Promise<ExtractResult> {
  const url = release.url!;

  try {
    const markdown = await fetchCloudflareMarkdown(url, accountId, apiToken);
    if (!markdown) {
      return { id: release.id, title: release.title, status: "skipped", reason: "page fetch failed", tokens: 0 };
    }

    const client = getAnthropicClient();
    const model = config.ingestModel();
    const truncated = markdown.length > MAX_MARKDOWN_CHARS
      ? markdown.slice(0, MAX_MARKDOWN_CHARS) + "\n\n[truncated]"
      : markdown;

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: EXTRACT_SYSTEM,
      messages: [{
        role: "user",
        content: `Extract the release notes content from this page (title: "${release.title}"):\n\n${truncated}`,
      }],
    });

    const text = response.content.find(
      (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
    )?.text?.trim() ?? "";

    const tokens = response.usage.input_tokens + response.usage.output_tokens;

    await logUsage({
      operation: "enrich-extract",
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      sourceSlug: options.sourceSlug,
      releaseCount: 1,
    });

    if (text.length <= release.content.length) {
      return { id: release.id, title: release.title, status: "skipped", reason: "extraction not richer", tokens };
    }

    if (!options.dryRun) {
      await updateRelease(release.id, { content: text });
    }

    return { id: release.id, title: release.title, status: "enriched", tokens };
  } catch (err) {
    logger.debug(`Extract failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return { id: release.id, title: release.title, status: "error", reason: String(err), tokens: 0 };
  }
}

// ── Concurrency helper ──────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}
