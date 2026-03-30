import type { RawRelease } from "./types.js";
import { fetchCloudflareMarkdown } from "./cloudflare.js";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { logUsage } from "../lib/usage.js";
import { getAnthropicClient } from "../ai/client.js";

// ── Config ──────────────────────────────────────────────────────────

/** Content shorter than this is considered "sparse" and worth enriching. */
const SPARSE_THRESHOLD = 50;

/** Max parallel page fetches. */
const CONCURRENCY = 5;

/** Max markdown length to send to AI for extraction. */
const MAX_MARKDOWN_CHARS = 100_000;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Enrich feed releases that have sparse content by fetching their
 * individual page URLs via Cloudflare Browser Rendering + Haiku extraction.
 */
export async function enrichSparseReleases(
  releases: RawRelease[],
  sourceSlug?: string,
): Promise<RawRelease[]> {
  const accountId = config.cloudflareAccountId();
  const apiToken = config.cloudflareApiToken();

  if (!accountId || !apiToken) return releases;

  const sparse = releases.filter(
    (r) => r.url && r.content.length < SPARSE_THRESHOLD,
  );

  if (sparse.length === 0) return releases;

  logger.info(
    `Enriching ${sparse.length}/${releases.length} sparse releases...`,
  );

  // Enrich with bounded concurrency
  const enriched = await mapWithConcurrency(
    sparse,
    (release) => enrichOne(release, accountId, apiToken, sourceSlug),
    CONCURRENCY,
  );

  // Build a url→content map from successful enrichments
  const contentByUrl = new Map<string, string>();
  for (const result of enriched) {
    if (result.url && result.content.length >= SPARSE_THRESHOLD) {
      contentByUrl.set(result.url, result.content);
    }
  }

  logger.info(
    `Enriched ${contentByUrl.size}/${sparse.length} releases successfully`,
  );

  // Merge enriched content back
  return releases.map((r) => {
    if (r.url && contentByUrl.has(r.url)) {
      return { ...r, content: contentByUrl.get(r.url)! };
    }
    return r;
  });
}

// ── Single release enrichment ───────────────────────────────────────

async function enrichOne(
  release: RawRelease,
  accountId: string,
  apiToken: string,
  sourceSlug?: string,
): Promise<RawRelease> {
  const url = release.url!;

  try {
    const markdown = await fetchCloudflareMarkdown(url, accountId, apiToken);
    if (!markdown) return release;

    return await enrichViaAI(release, markdown, sourceSlug);
  } catch (err) {
    logger.debug(
      `Failed to enrich ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return release;
  }
}

// ── AI content extraction ───────────────────────────────────────────

const ENRICH_SYSTEM_PROMPT = `You are a release notes extractor. Given the markdown content of a release/changelog page, extract ONLY the release notes content. Strip navigation, headers, footers, sidebars, and other page chrome. Return just the release notes text as clean markdown.

Be concise. Keep the essential information: what changed, new features, bug fixes, breaking changes. Remove boilerplate.`;

async function enrichViaAI(
  release: RawRelease,
  markdown: string,
  sourceSlug?: string,
): Promise<RawRelease> {
  const apiKey = config.anthropicApiKey();
  if (!apiKey) return release;

  const client = getAnthropicClient();
  const model = config.ingestModel(); // Haiku — cheapest

  const truncated =
    markdown.length > MAX_MARKDOWN_CHARS
      ? markdown.slice(0, MAX_MARKDOWN_CHARS) + "\n\n[truncated]"
      : markdown;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: ENRICH_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Extract the release notes content from this page (title: "${release.title}"):\n\n${truncated}`,
      },
    ],
  });

  const textBlock = response.content.find(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
  );
  const content = textBlock?.text.trim() ?? "";

  await logUsage({
    operation: "feed-enrich",
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    sourceSlug,
    releaseCount: 1,
  });

  if (content.length >= SPARSE_THRESHOLD) {
    logger.debug(
      `Enriched ${release.url} via AI (${content.length} chars, ${response.usage.input_tokens + response.usage.output_tokens} tokens)`,
    );
    return { ...release, content };
  }

  return release;
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
