/**
 * Full-agent extraction strategy: when a source doesn't have `metadata.fetchUrl`,
 * we use Anthropic's server-side `web_fetch` tool to retrieve and parse the
 * page(s). Falls back to Cloudflare Browser Rendering for JS-heavy SPAs.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { sha256Hex } from "@releases/core-internal/hash";
import { AdapterError } from "@releases/lib/errors";
import { fetchCloudflareMarkdown } from "../cloudflare.js";
import type { Source } from "@releases/core-internal/schema";
import { extractFromBody } from "./extract-from-body.js";
import {
  extractReleasesToolFull,
  WEBFETCH_SYSTEM_PROMPT,
  CLOUDFLARE_SYSTEM_PROMPT,
  mapEntries,
  withGuidance,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type ExtractionGuidance,
  type MappedEntry,
} from "./shared.js";
import type { ExtractDeps, ExtractedEntry } from "./types.js";

export interface AgentExtractionOptions {
  guidance?: ExtractionGuidance;
  since?: Date;
  maxEntries?: number;
  dryRun?: boolean;
}

export interface AgentExtractionResult {
  releases: MappedEntry[];
  unchanged: boolean;
}

/** Threshold below which we suspect web_fetch missed content */
const MIN_EXPECTED_ENTRIES = 3;

export async function runAgentExtraction(
  source: Source,
  opts: AgentExtractionOptions,
  deps: ExtractDeps,
): Promise<AgentExtractionResult> {
  const { logger, repo, agentModel } = deps;

  logger.info(`Running agent extraction for ${source.url} (model: ${agentModel})...`);

  let result: {
    entries: ExtractedEntry[];
    totalInput: number;
    totalOutput: number;
    hitMaxTokens: boolean;
  };
  // Tracks the content hash from any Cloudflare-rendered body, recorded
  // after extraction so a failed run doesn't lock out retries.
  let pendingContentHash: string | null = null;
  const jsRendered = await isJsRenderedPage(source.url);

  if (jsRendered) {
    const markdown = await fetchViaCloudflare(source.url, deps);
    if (!markdown) {
      throw new AdapterError(
        "agent",
        "Page is JS-rendered and Cloudflare credentials are not configured.",
      );
    }
    logger.info(`Cloudflare returned ${markdown.length.toLocaleString()} chars of markdown`);

    const contentHash = sha256Hex(markdown);
    if (await repo.peekContentHash(source, contentHash)) {
      logger.info(`No changes detected for ${source.url} (content hash unchanged)`);
      return { releases: [], unchanged: true };
    }

    result = await extractFromBody(
      {
        body: markdown,
        systemPrompt: CLOUDFLARE_SYSTEM_PROMPT,
        userMessage: `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
        guidance: opts.guidance,
      },
      deps,
    );
    pendingContentHash = contentHash;
  } else {
    try {
      const webResult = await runWebFetchLoop(source.url, opts.guidance, deps);
      result = { ...webResult, hitMaxTokens: false };
    } catch (err) {
      throw new AdapterError(
        "agent",
        `Agent extraction failed for ${source.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    logger.info(
      `web_fetch found ${result.entries.length} entries (${result.totalInput.toLocaleString()} input + ${result.totalOutput.toLocaleString()} output tokens)`,
    );

    if (result.entries.length < MIN_EXPECTED_ENTRIES) {
      logger.info(`Only ${result.entries.length} entries — trying Cloudflare fallback...`);
      const markdown = await fetchViaCloudflare(source.url, deps);
      if (markdown) {
        logger.info(`Cloudflare returned ${markdown.length.toLocaleString()} chars of markdown`);

        const contentHash = sha256Hex(markdown);
        if (await repo.peekContentHash(source, contentHash)) {
          logger.info(`No changes detected for ${source.url} (content hash unchanged)`);
          return { releases: [], unchanged: true };
        }

        try {
          const cfResult = await extractFromBody(
            {
              body: markdown,
              systemPrompt: CLOUDFLARE_SYSTEM_PROMPT,
              userMessage: `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
              guidance: opts.guidance,
            },
            deps,
          );
          if (cfResult.entries.length > result.entries.length) {
            logger.info(
              `Cloudflare found ${cfResult.entries.length} entries (vs ${result.entries.length}) — using Cloudflare results`,
            );
            result = {
              entries: cfResult.entries,
              totalInput: result.totalInput + cfResult.totalInput,
              totalOutput: result.totalOutput + cfResult.totalOutput,
              hitMaxTokens: cfResult.hitMaxTokens,
            };
            pendingContentHash = contentHash;
          }
          // If web_fetch beat Cloudflare we deliberately leave pendingContentHash
          // unset — recording would tie the hash to a body whose result we're
          // discarding, which would block re-extraction once web_fetch improves.
        } catch (err) {
          logger.warn(
            `Cloudflare extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  if (pendingContentHash !== null && !result.hitMaxTokens && !opts.dryRun) {
    await repo.commitContentHash(source, pendingContentHash);
  }

  await repo.logUsage({
    operation: "agent-ingest",
    model: agentModel,
    inputTokens: result.totalInput,
    outputTokens: result.totalOutput,
    sourceSlug: source.slug,
    releaseCount: result.entries.length,
  });

  logger.info(
    `Total: ${result.totalInput.toLocaleString()} input + ${result.totalOutput.toLocaleString()} output tokens`,
  );

  let releases = mapEntries(result.entries, { sourceUrl: source.url });
  if (opts.since) {
    releases = releases.filter((r) => !r.publishedAt || r.publishedAt >= opts.since!);
  }
  if (opts.maxEntries) {
    releases = releases.slice(0, opts.maxEntries);
  }

  logger.info(`Extracted ${releases.length} release(s) from ${source.url}`);
  return { releases, unchanged: false };
}

// ── Pre-flight: detect JS-rendered SPAs ──────────────────────────────
// Quick HTTP fetch to check if the page has meaningful content in the
// raw HTML. JS SPAs return a shell with no links — web_fetch can't
// render JS, so we skip straight to Cloudflare for those.

async function isJsRenderedPage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "releases/0.1 (+https://releases.sh)" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const html = await res.text();

    // Strip scripts and styles first, then measure text content.
    // JS SPAs have huge HTML (scripts/styles) but very little visible text.
    const withoutScripts = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "");
    const textOnly = withoutScripts
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const textRatio = textOnly.length / html.length;

    return textRatio < 0.05;
  } catch {
    return false;
  }
}

async function fetchViaCloudflare(url: string, deps: ExtractDeps): Promise<string | null> {
  if (!deps.cloudflare) {
    deps.logger.debug("Cloudflare credentials not set — skipping fallback");
    return null;
  }
  deps.logger.info("Falling back to Cloudflare Browser Rendering...");
  return fetchCloudflareMarkdown(url, deps.cloudflare.accountId, deps.cloudflare.apiToken);
}

// ── web_fetch loop ───────────────────────────────────────────────────

async function runWebFetchLoop(
  sourceUrl: string,
  guidance: ExtractionGuidance | undefined,
  deps: ExtractDeps,
): Promise<{ entries: ExtractedEntry[]; totalInput: number; totalOutput: number }> {
  const { anthropicClient, agentModel, logger } = deps;
  const sourceDomain = new URL(sourceUrl).hostname;

  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      type: "web_fetch_20260209",
      name: "web_fetch",
      allowed_domains: [sourceDomain],
      max_uses: 15,
      cache_control: { type: "ephemeral" },
    },
    extractReleasesToolFull,
  ];

  const systemPrompt: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: WEBFETCH_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (guidance?.parseInstructions || guidance?.playbookContext) {
    systemPrompt.push({ type: "text", text: withGuidance("", guidance) });
  }

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Extract all changelog/release entries from: ${sourceUrl}` },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let entries: ExtractedEntry[] | null = null;
  const maxContinuations = 5;
  let continuations = 0;
  // Dynamic filtering uses server-side code execution. When continuing after
  // pause_turn, we must pass the container_id back so the API resumes in the
  // same execution environment.
  let containerId: string | undefined;

  while (continuations <= maxContinuations) {
    const stream = anthropicClient.messages.stream({
      model: agentModel,
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      tools,
      messages,
      ...(containerId ? { container: containerId } : {}),
    });
    const response = await stream.finalMessage();

    // TODO: remove cast once Anthropic SDK exposes `container` in response type.
    const responseAny = response as unknown as Record<string, unknown>;
    if (responseAny.container) {
      containerId = (responseAny.container as { id: string }).id;
    }

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    const usage = response.usage as unknown as Record<string, number>;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    if (cacheRead > 0) {
      logger.debug(`Cache hit: ${cacheRead} tokens read from cache`);
    }

    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "extract_releases") {
        const input = block.input as Record<string, unknown>;
        if (input && Array.isArray(input.releases)) {
          entries = input.releases as ExtractedEntry[];
        }
      }
    }

    if (entries !== null) break;

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continuations++;
      logger.debug(`pause_turn — continuing (${continuations}/${maxContinuations})`);
      continue;
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        if (block.name === "extract_releases") {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Received. Thank you.",
          });
        }
      }
      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }
      continuations++;
      continue;
    }

    if (response.stop_reason === "end_turn") {
      logger.warn("Agent ended without calling extract_releases");
      break;
    }

    logger.warn(`Agent stopped with reason: ${response.stop_reason}`);
    break;
  }

  return { entries: entries ?? [], totalInput, totalOutput };
}
