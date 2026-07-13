import { logger } from "@buildinternet/releases-lib/logger";
import type { EvaluationResult } from "@buildinternet/releases-api-types";
import { detectProvider, type DetectedProvider } from "./providers/index.js";
import { discoverFeed, probeFeedPath } from "@releases/adapters/feed";
import type { SourceMetadata } from "@releases/adapters/source-meta";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";

// ── Types ──────────────────────────────────────────────────────────

export type { EvaluationResult };

// ── Build metadata shape from evaluation result ────────────────────

export function buildMetadataFromEvaluation(result: EvaluationResult): Partial<SourceMetadata> {
  const now = new Date().toISOString();
  const meta: Partial<SourceMetadata> = {
    evaluatedMethod: result.recommendedMethod,
    evaluatedAt: now,
  };

  if (result.feedUrl) {
    meta.feedUrl = result.feedUrl;
    meta.feedType = result.feedType;
    meta.feedDiscoveredAt = now;
    meta.noFeedFound = false;
  }

  if (result.provider) {
    meta.provider = result.provider;
    meta.providerDetectedAt = now;
  }

  // Store markdown URL from alternatives or direct recommendation
  if (result.recommendedMethod === "markdown") {
    meta.markdownUrl = result.recommendedUrl;
  } else {
    const mdAlt = result.alternatives.find((a) => a.method === "markdown");
    if (mdAlt) meta.markdownUrl = mdAlt.url;
  }

  return meta;
}

// ── Pre-checks (run in parallel, results feed into the agent) ──────

function isGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

async function tryMarkdownSuffix(url: string): Promise<string | null> {
  const mdUrl = url.replace(/\/$/, "") + ".md";
  try {
    const res = await fetch(mdUrl, {
      method: "HEAD",
      headers: { "User-Agent": RELEASES_BOT_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/") || ct.includes("markdown")) return mdUrl;
    return null;
  } catch {
    return null;
  }
}

async function tryProviderFeeds(
  url: string,
  feedPaths: string[],
): Promise<{ url: string; type: string } | null> {
  const base = new URL(url);
  const changePath = base.pathname.replace(/\/$/, "");

  // Build candidate paths (origin-relative + changelog-relative), then probe
  // each with the shared feed prober — it HEADs to classify by MIME and falls
  // back to GET-and-sniff for feeds served as generic XML (e.g. Blume's
  // /changelog/rss.xml). Origin-relative resolves feeds mounted at the site
  // root; changelog-relative resolves feeds mounted under the changelog page.
  const paths: string[] = [];
  for (const path of feedPaths) {
    paths.push(path);
    const relative = `${changePath}${path}`;
    if (relative !== path) paths.push(relative);
  }

  const results = await Promise.allSettled(paths.map((path) => probeFeedPath(base.origin, path)));

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}

interface PreCheckResults {
  provider: DetectedProvider | null;
  genericFeed: { url: string; type: string } | null;
  providerFeed: { url: string; type: string } | null;
  markdownUrl: string | null;
}

async function runPreChecks(url: string): Promise<PreCheckResults> {
  // Phase 1: Provider detection and generic feed discovery in parallel
  const [provider, genericFeed] = await Promise.all([detectProvider(url), discoverFeed(url)]);

  if (provider) logger.info(`Provider detected: ${provider.name}`);

  // Phase 2: Provider-specific probes (only if provider was found)
  const [providerFeed, markdownUrl] = await Promise.all([
    provider?.hints.feedPaths ? tryProviderFeeds(url, provider.hints.feedPaths) : null,
    provider?.hints.markdownSuffix ? tryMarkdownSuffix(url) : null,
  ]);

  if (providerFeed) logger.info(`Provider feed found: ${providerFeed.url} (${providerFeed.type})`);
  if (markdownUrl) logger.info(`Markdown suffix works: ${markdownUrl}`);

  return { provider, genericFeed, providerFeed, markdownUrl };
}

// ── Main evaluation ────────────────────────────────────────────────

export async function evaluateChangelog(url: string): Promise<EvaluationResult> {
  // GitHub URLs are unambiguous — skip everything
  const gh = isGitHubUrl(url);
  if (gh) {
    logger.info(`GitHub URL detected — ${gh.owner}/${gh.repo}`);
    return {
      recommendedMethod: "github",
      recommendedUrl: url,
      githubRepo: `${gh.owner}/${gh.repo}`,
      pageStructure: "unknown",
      alternatives: [],
      confidence: "high",
      notes: "GitHub URL — use Releases API directly",
    };
  }

  // Run pre-checks
  logger.info("Running pre-checks (provider detection, feed discovery)...");
  const checks = await runPreChecks(url);

  return buildResultFromPreChecks(url, checks);
}

/** Construct an evaluation result from pre-check data. */
function buildResultFromPreChecks(url: string, checks: PreCheckResults): EvaluationResult {
  const alternatives: EvaluationResult["alternatives"] = [];
  const feed = checks.providerFeed ?? checks.genericFeed;

  if (checks.markdownUrl) {
    alternatives.push({
      url: checks.markdownUrl,
      method: "markdown",
      note: `Raw markdown via ${checks.provider?.name ?? "provider"} .md suffix`,
    });
  }

  if (feed) {
    return {
      recommendedMethod: "feed",
      recommendedUrl: feed.url,
      feedUrl: feed.url,
      feedType: feed.type as EvaluationResult["feedType"],
      pageStructure: "unknown",
      alternatives,
      confidence: "high",
      provider: checks.provider?.id,
      notes: "Resolved from automated pre-checks",
    };
  }

  if (checks.markdownUrl) {
    return {
      recommendedMethod: "markdown",
      recommendedUrl: checks.markdownUrl,
      pageStructure: "single-page",
      alternatives: [],
      confidence: "medium",
      provider: checks.provider?.id,
      notes: "Resolved from automated pre-checks",
    };
  }

  return {
    recommendedMethod: "scrape",
    recommendedUrl: url,
    pageStructure: "unknown",
    alternatives,
    confidence: "low",
    provider: checks.provider?.id,
    notes: "No structured source found in pre-checks",
  };
}
