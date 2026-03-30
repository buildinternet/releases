import Anthropic from "@anthropic-ai/sdk";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { logUsage } from "../lib/usage.js";
import { getAnthropicClient } from "./client.js";
import { detectProvider, type DetectedProvider } from "../lib/providers.js";
import { discoverFeed, updateSourceMeta } from "../adapters/feed.js";
import type { Source } from "../db/schema.js";

// ── Types ──────────────────────────────────────────────────────────

export interface EvaluationResult {
  recommendedMethod: "feed" | "github" | "markdown" | "scrape" | "crawl";
  recommendedUrl: string;
  feedUrl?: string;
  feedType?: "rss" | "atom" | "jsonfeed";
  githubRepo?: string;
  pageStructure: "single-page" | "index" | "unknown";
  alternatives: Array<{ url: string; method: string; note: string }>;
  confidence: "high" | "medium" | "low";
  provider?: string;
  notes?: string;
}

// ── Persist evaluation results to a source ─────────────────────────

/** Build a SourceMetadata-compatible object from an evaluation result. */
export function buildMetadataFromEvaluation(result: EvaluationResult): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    evaluatedMethod: result.recommendedMethod,
    evaluatedAt: new Date().toISOString(),
  };

  if (result.feedUrl) {
    meta.feedUrl = result.feedUrl;
    meta.feedType = result.feedType;
    meta.feedDiscoveredAt = new Date().toISOString();
    meta.noFeedFound = false;
  }

  if (result.provider) {
    meta.provider = result.provider;
    meta.providerDetectedAt = new Date().toISOString();
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

export async function applyEvaluation(source: Source, result: EvaluationResult): Promise<void> {
  const meta = buildMetadataFromEvaluation(result);
  await updateSourceMeta(source, meta);
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
      headers: { "User-Agent": "released/0.1" },
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

  // Build all candidate URLs (origin-relative + changelog-relative)
  const candidates: string[] = [];
  for (const path of feedPaths) {
    candidates.push(`${base.origin}${path}`);
    const relative = `${base.origin}${changePath}${path}`;
    if (relative !== `${base.origin}${path}`) candidates.push(relative);
  }

  // Probe all in parallel
  const results = await Promise.allSettled(
    candidates.map(async (feedUrl) => {
      const res = await fetch(feedUrl, {
        method: "HEAD",
        headers: { "User-Agent": "released/0.1" },
        redirect: "follow",
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("xml") || ct.includes("rss") || ct.includes("atom") || ct.includes("json")) {
        const type = ct.includes("json") ? "jsonfeed" : ct.includes("atom") ? "atom" : "rss";
        return { url: feedUrl, type };
      }
      return null;
    }),
  );

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
  const [provider, genericFeed] = await Promise.all([
    detectProvider(url),
    discoverFeed(url),
  ]);

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

function formatPreCheckContext(checks: PreCheckResults): string {
  const lines: string[] = [];

  // Provider
  if (checks.provider) {
    lines.push(`Provider: ${checks.provider.name} (${checks.provider.id})`);
    if (checks.provider.hints.crawlPattern) {
      lines.push(`  Crawl pattern hint: ${checks.provider.hints.crawlPattern}`);
    }
    if (checks.provider.hints.preferredType) {
      lines.push(`  Preferred type: ${checks.provider.hints.preferredType}`);
    }
  } else {
    lines.push("Provider: none detected (checked DNS CNAME, HTTP headers, HTML patterns)");
  }

  // Feeds
  const feed = checks.providerFeed ?? checks.genericFeed;
  if (feed) {
    lines.push(`Feed found: ${feed.url} (${feed.type})`);
  } else {
    const tried: string[] = [];
    if (checks.provider?.hints.feedPaths) {
      tried.push(`provider paths (${checks.provider.hints.feedPaths.join(", ")})`);
    }
    tried.push("15 well-known paths", "HTML <link> tags");
    lines.push(`Feed: none found (tried ${tried.join(", ")})`);
  }

  // Markdown
  if (checks.markdownUrl) {
    lines.push(`Markdown: available at ${checks.markdownUrl}`);
  } else if (checks.provider?.hints.markdownSuffix) {
    lines.push("Markdown suffix: tried but did not return valid markdown");
  }

  return lines.join("\n");
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

  // Run pre-checks, then let the agent make the call
  logger.info("Running pre-checks (provider detection, feed discovery)...");
  const checks = await runPreChecks(url);
  const context = formatPreCheckContext(checks);

  logger.info("Running evaluation agent...");
  let result: EvaluationResult;
  try {
    result = await runEvaluationAgent(url, context);
  } catch (err) {
    // If the agent fails (context overflow, API error, etc.), build a result from pre-checks
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Agent failed: ${message.slice(0, 200)} — using pre-check results`);
    result = buildResultFromPreChecks(url, checks);
  }

  // Merge pre-check data the agent might not have seen
  if (checks.provider && !result.provider) {
    result.provider = checks.provider.id;
  }
  const feed = checks.providerFeed ?? checks.genericFeed;
  if (feed && !result.feedUrl) {
    result.feedUrl = feed.url;
    result.feedType = feed.type as EvaluationResult["feedType"];
  }

  return result;
}

/** Construct an evaluation result from pre-check data when the agent can't run */
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
      notes: "Resolved from pre-checks (agent could not run)",
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
      notes: "Resolved from pre-checks (agent could not run)",
    };
  }

  return {
    recommendedMethod: "scrape",
    recommendedUrl: url,
    pageStructure: "unknown",
    alternatives,
    confidence: "low",
    provider: checks.provider?.id,
    notes: "Agent could not run; no structured source found in pre-checks",
  };
}

// ── Agent ──────────────────────────────────────────────────────────

const reportEvaluationTool: Anthropic.Tool = {
  name: "report_evaluation",
  description:
    "Report your evaluation of the changelog source. Call this when you've determined the best way to get release data.",
  input_schema: {
    type: "object" as const,
    properties: {
      recommended_method: {
        type: "string" as const,
        enum: ["feed", "github", "markdown", "scrape", "crawl"],
        description:
          "Best ingestion method. feed = RSS/Atom/JSON feed. github = GitHub Releases API. markdown = raw markdown file. scrape = parse the page directly. crawl = follow links to individual release pages.",
      },
      recommended_url: {
        type: "string" as const,
        description:
          "The URL to use for ingestion. May differ from the input URL (e.g., a feed URL or GitHub API URL).",
      },
      feed_url: {
        type: "string" as const,
        description: "Direct URL to the RSS/Atom/JSON feed, if found.",
      },
      feed_type: {
        type: "string" as const,
        enum: ["rss", "atom", "jsonfeed"],
        description: "Type of feed, if found.",
      },
      github_repo: {
        type: "string" as const,
        description: "GitHub repository in owner/repo format, if found.",
      },
      page_structure: {
        type: "string" as const,
        enum: ["single-page", "index", "unknown"],
        description:
          "How the page is structured. single-page = all releases on one page. index = links to individual release pages. unknown = couldn't determine.",
      },
      alternatives: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            url: { type: "string" as const },
            method: { type: "string" as const },
            note: { type: "string" as const },
          },
          required: ["url", "method", "note"],
        },
        description: "Other viable sources found during evaluation.",
      },
      confidence: {
        type: "string" as const,
        enum: ["high", "medium", "low"],
        description:
          "high = found a structured source (feed/API). medium = found a raw file or clear page structure. low = only the original page with unclear structure.",
      },
      notes: {
        type: "string" as const,
        description:
          "Anything notable — unusual structure, JS-rendered content, very long navigation, etc.",
      },
    },
    required: [
      "recommended_method",
      "recommended_url",
      "page_structure",
      "alternatives",
      "confidence",
    ],
  },
};

const SYSTEM_PROMPT = `You evaluate changelog pages to find the best way to get structured release data from them.

You'll receive pre-check results (provider detection, feed discovery) as context. Use these to avoid repeating work that's already been done. If the pre-checks found a feed or markdown source, verify it looks right and confirm the recommendation. If they didn't find anything, dig deeper.

Your job:
1. Fetch the page with web_fetch and look at it.
2. Decide the best ingestion method based on what you see and what the pre-checks found.
3. If the pre-checks missed something (a feed URL in JavaScript, a GitHub repo link, a raw markdown file), note it.
4. Call report_evaluation with your recommendation.

Priority: feeds > GitHub API > raw markdown > scraping.
If a feed was already found by pre-checks and it looks valid, just confirm it — no need to search further.`;

function parseEvaluationResult(input: Record<string, unknown>): EvaluationResult {
  return {
    recommendedMethod: input.recommended_method as EvaluationResult["recommendedMethod"],
    recommendedUrl: input.recommended_url as string,
    feedUrl: input.feed_url as string | undefined,
    feedType: input.feed_type as EvaluationResult["feedType"],
    githubRepo: input.github_repo as string | undefined,
    pageStructure: (input.page_structure as EvaluationResult["pageStructure"]) ?? "unknown",
    alternatives: (input.alternatives as EvaluationResult["alternatives"]) ?? [],
    confidence: (input.confidence as EvaluationResult["confidence"]) ?? "low",
    notes: input.notes as string | undefined,
  };
}

async function runEvaluationAgent(
  url: string,
  preCheckContext: string,
): Promise<EvaluationResult> {
  const client = getAnthropicClient();
  const model = config.ingestModel();
  const domain = new URL(url).hostname;

  const allowedDomains = [domain];
  if (!domain.includes("github.com")) {
    allowedDomains.push("github.com", "raw.githubusercontent.com");
  }

  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      type: "web_fetch_20260209",
      name: "web_fetch",
      allowed_domains: allowedDomains,
      allowed_callers: ["direct"],
      max_uses: 8,
    },
    reportEvaluationTool,
  ];

  const systemPrompt: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Evaluate this changelog page and recommend the best ingestion method: ${url}\n\nPre-check results:\n${preCheckContext}`,
    },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let result: EvaluationResult | null = null;
  const maxContinuations = 5;
  let continuations = 0;
  let containerId: string | undefined;

  while (continuations <= maxContinuations) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
      ...(containerId ? { container: containerId } : {}),
    });

    const responseAny = response as unknown as Record<string, unknown>;
    if (responseAny.container) {
      containerId = (responseAny.container as { id: string }).id;
    }

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "report_evaluation") {
        result = parseEvaluationResult(block.input as Record<string, unknown>);
      }
    }

    if (result) break;

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continuations++;
      continue;
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: toolUseBlocks.map((block) => ({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: "Received.",
        })),
      });
      continuations++;
      continue;
    }

    if (response.stop_reason === "end_turn") {
      // Model finished without calling report_evaluation — force it
      logger.debug("Agent ended without report — forcing structured output");
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: "Now call report_evaluation with your findings." });

      const followUp = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: [reportEvaluationTool],
        tool_choice: { type: "tool", name: "report_evaluation" },
        messages,
      });

      totalInput += followUp.usage.input_tokens;
      totalOutput += followUp.usage.output_tokens;

      for (const block of followUp.content) {
        if (block.type === "tool_use" && block.name === "report_evaluation") {
          result = parseEvaluationResult(block.input as Record<string, unknown>);
        }
      }
      break;
    }

    logger.warn(`Evaluation agent stopped with reason: ${response.stop_reason}`);
    break;
  }

  await logUsage({
    operation: "evaluate-changelog",
    model,
    inputTokens: totalInput,
    outputTokens: totalOutput,
  });

  if (!result) {
    logger.warn("Agent did not produce a result — defaulting to scrape");
    result = {
      recommendedMethod: "scrape",
      recommendedUrl: url,
      pageStructure: "unknown",
      alternatives: [],
      confidence: "low",
      notes: "Agent did not complete evaluation",
    };
  }

  logger.info(
    `Evaluation: ${result.recommendedMethod} (${result.confidence}) — ${totalInput.toLocaleString()} in + ${totalOutput.toLocaleString()} out tokens`,
  );

  return result;
}
