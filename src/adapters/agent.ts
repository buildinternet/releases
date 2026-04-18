import Anthropic from "@anthropic-ai/sdk";
import type { Source, ReleaseType } from "@buildinternet/releases-core/schema";
import type { Adapter, RawRelease, FetchOptions, FetchResult } from "@releases/adapters/types";
import { checkContentHash, findOrg, getPlaybookForOrg } from "../db/queries.js";
import { config } from "@releases/lib/config";
import { AdapterError } from "@releases/lib/errors";
import { sha256Hex } from "@releases/core/hash";
import { logger } from "@buildinternet/releases-lib/logger";
import { logUsage } from "../lib/usage.js";
import { getAnthropicClient } from "../ai/client.js";
import {
  sanitizeVersion,
  releaseItemProperties,
  releaseItemRequired,
  withGuidance,
  type ExtractionGuidance,
} from "../ai/shared.js";
import { fetchCloudflareMarkdown } from "@releases/adapters/cloudflare";
import { getSourceMeta } from "@releases/adapters/source-meta";
import { updateSourceMeta } from "./feed.js";
import { extractNotesFromLegacyPlaybook } from "../ai/playbook.js";

// ── Tool schema for structured extraction ────────────────────────────
// Claude calls this when it's done fetching/exploring and has extracted
// all the release entries it found.

const extractReleasesTool: Anthropic.Tool = {
  name: "extract_releases",
  description: "Call this tool with the structured release entries you extracted from the changelog page(s).",
  input_schema: {
    type: "object" as const,
    properties: {
      releases: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            ...releaseItemProperties,
            url: {
              type: "string" as const,
              description: "URL to the individual entry page. Extract from <a href> links on the page. If no individual page exists, omit.",
            },
          },
          required: [...releaseItemRequired],
        },
      },
    },
    required: ["releases"],
  },
};

// ── System prompts (cached across sources) ───────────────────────────

const EXTRACTION_RULES = `Rules:
- COMPLETENESS: Extract every single entry you can find. Do not skip or filter out entries.
- Extract the real URL to each individual entry from links in the page content.
- Keep content concise: key changes, features, and fixes. Don't reproduce entire pages.
- Dates should be ISO 8601. For month-only dates (e.g. "April 2026"), use the first of the month: 2026-04-01. For quarter or season headings (e.g. "Q3 2025", "Fall 2025"), use the first day of the period (Q3 → 2025-07-01, Fall → 2025-09-01). For year-only dates, use January 1. If no date is recoverable, omit publishedAt.
- Mark isBreaking only if the entry mentions breaking or backwards-incompatible changes.
- Set type to "rollup" for seasonal/quarterly/annual catch-all pages that span many features (e.g. "Fall Release 2025", "Q3 2025 Recap"). Otherwise omit or use "feature".
- If no version is explicitly stated, omit the version field.
- Return entries newest first.
- Always call the extract_releases tool with your results.`;

const WEBFETCH_SYSTEM_PROMPT = `You are a changelog extraction agent. Your job is to extract ALL structured release/changelog entries from web pages. Completeness is critical — missing entries is worse than including too many.

Workflow:
1. Use web_fetch to retrieve the changelog page. When filtering content, keep ALL changelog entries — do not discard any. It's better to include too much than to miss entries.
2. Examine the content. If it's a blog-index (a list of links to individual entry pages), note the per-entry URLs.
3. If the index page only shows summaries and entries have individual pages with more detail, fetch a few representative entry pages to get full content.
4. When you have ALL entries, call the extract_releases tool with your structured results.

${EXTRACTION_RULES}`;

const CLOUDFLARE_SYSTEM_PROMPT = `You are a changelog parser. Given the rendered markdown content of a changelog page, extract individual release entries using the extract_releases tool.

${EXTRACTION_RULES}`;

interface ExtractedEntry {
  version?: string;
  title: string;
  url?: string;
  content: string;
  publishedAt?: string;
  isBreaking: boolean;
  type?: ReleaseType;
}

// ── Primary path: server-side web_fetch with dynamic filtering ───────

async function runWebFetchLoop(
  sourceUrl: string,
  guidance: ExtractionGuidance,
): Promise<{ entries: ExtractedEntry[]; totalInput: number; totalOutput: number }> {
  const client = getAnthropicClient();
  const model = config.agentModel();
  const sourceDomain = new URL(sourceUrl).hostname;

  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      type: "web_fetch_20260209",
      name: "web_fetch",
      allowed_domains: [sourceDomain],
      max_uses: 15,
      cache_control: { type: "ephemeral" },
    },
    extractReleasesTool,
  ];

  // Static base prompt is cached; per-org/per-source guidance follows in a
  // second uncached block so changing it doesn't bust the prompt cache for
  // the whole org.
  const systemPrompt: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: WEBFETCH_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];
  const guidanceText = withGuidance("", guidance);
  if (guidanceText) {
    systemPrompt.push({ type: "text", text: guidanceText });
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Extract all changelog/release entries from: ${sourceUrl}`,
    },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let entries: ExtractedEntry[] | null = null;
  const maxContinuations = 5;
  let continuations = 0;
  // Dynamic filtering uses server-side code execution. When continuing
  // after pause_turn, we must pass the container_id back so the API
  // can resume in the same execution environment.
  let containerId: string | undefined;

  while (continuations <= maxContinuations) {
    // Stream to avoid HTTP timeouts on large server-side tool loops.
    // finalMessage() collects the complete response.
    const stream = client.messages.stream({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      tools,
      messages,
      ...(containerId ? { container: containerId } : {}),
    });
    const response = await stream.finalMessage();

    // TODO: remove cast once Anthropic SDK exposes `container` in response type.
    // Dynamic filtering uses server-side code execution containers that must
    // persist across pause_turn continuations.
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

    // Check for our extract_releases tool call in the response
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "extract_releases") {
        const input = block.input as Record<string, unknown>;
        if (input && Array.isArray(input.releases)) {
          entries = input.releases as ExtractedEntry[];
        }
      }
    }

    if (entries !== null) break;

    // Server-side tool loop hit its iteration limit — continue
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continuations++;
      logger.debug(`pause_turn — continuing (${continuations}/${maxContinuations})`);
      continue;
    }

    // Client-side tool_use (extract_releases) — acknowledge and continue
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

// ── Fallback: Cloudflare Browser Rendering + AI extraction ───────────
// Handles JS-rendered pages that web_fetch can't process.

async function fetchViaCloudflare(url: string): Promise<string | null> {
  const accountId = config.cloudflareAccountId();
  const apiToken = config.cloudflareApiToken();

  if (!accountId || !apiToken) {
    logger.debug("Cloudflare credentials not set — skipping fallback");
    return null;
  }

  logger.info(`Falling back to Cloudflare Browser Rendering...`);
  return fetchCloudflareMarkdown(url, accountId, apiToken);
}

interface ExtractFromBodyOpts {
  body: string;
  systemPrompt: string;
  /** Will be appended with `\n\n${truncated body}` — no need for a trailing newline. */
  userMessage: string;
  guidance?: ExtractionGuidance;
}

async function extractFromBody(
  opts: ExtractFromBodyOpts,
): Promise<{ entries: ExtractedEntry[]; totalInput: number; totalOutput: number }> {
  const client = getAnthropicClient();
  const model = config.agentModel();

  const maxChars = 400_000;
  const content = opts.body.length > maxChars
    ? opts.body.slice(0, maxChars) + "\n\n[Content truncated]"
    : opts.body;

  const response = await client.messages.create({
    model,
    max_tokens: 16384,
    system: [
      {
        type: "text",
        text: withGuidance(opts.systemPrompt, opts.guidance),
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [extractReleasesTool],
    tool_choice: { type: "tool", name: "extract_releases" },
    messages: [
      { role: "user", content: `${opts.userMessage}\n\n${content}` },
    ],
  });

  const totalInput = response.usage.input_tokens;
  const totalOutput = response.usage.output_tokens;

  if (response.stop_reason === "max_tokens") {
    logger.warn("AI extraction hit max_tokens — some entries may be lost");
  }

  const toolBlock = response.content.find((block) => block.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    return { entries: [], totalInput, totalOutput };
  }

  const input = toolBlock.input as Record<string, unknown>;
  if (!input || !Array.isArray(input.releases)) {
    return { entries: [], totalInput, totalOutput };
  }

  return { entries: input.releases as ExtractedEntry[], totalInput, totalOutput };
}

// ── Map extracted entries to RawRelease[] ─────────────────────────────

function mapEntries(entries: ExtractedEntry[], sourceUrl: string): RawRelease[] {
  return entries
    .filter((e) => e.title && e.content)
    .map((e) => {
      const version = sanitizeVersion(e.version);

      // Resolve relative URLs against the source
      let entryUrl: string;
      if (e.url && e.url !== sourceUrl) {
        try {
          entryUrl = new URL(e.url, sourceUrl).href;
        } catch {
          entryUrl = e.url;
        }
      } else {
        const frag = (version ?? e.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
        entryUrl = `${sourceUrl}#${frag}`;
      }

      return {
        title: e.title,
        content: e.content,
        url: entryUrl,
        version,
        publishedAt: e.publishedAt ? new Date(e.publishedAt) : undefined,
        isBreaking: e.isBreaking,
        type: e.type,
      };
    });
}

/**
 * Best-effort load of an org's playbook notes for use as extra agent context.
 * Returns null if the source has no org, no playbook, or the lookup fails.
 */
async function loadPlaybookContext(source: Source): Promise<string | null> {
  if (!source.orgId) return null;
  try {
    const org = await findOrg(source.orgId);
    if (!org) return null;
    const playbook = await getPlaybookForOrg(org.id, org.slug);
    if (!playbook) return null;
    const notes = playbook.notes ?? extractNotesFromLegacyPlaybook(playbook.content);
    return notes && notes.trim().length > 0 ? notes : null;
  } catch (err) {
    logger.debug(`Playbook load failed for ${source.slug}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const DIRECT_FETCH_SYSTEM_PROMPT = `You are a changelog parser. The user message contains the raw body of a URL — it may be JSON, HTML, markdown, or another structured format. Extract individual release entries using the extract_releases tool.

Identify the format from the content itself, then extract release entries. For JSON, navigate the structure to find the array of release/changelog items. For HTML, extract from the rendered content. For markdown, parse section headings.

${EXTRACTION_RULES}`;

async function fetchViaDirectFetch(
  source: Source,
  meta: ReturnType<typeof getSourceMeta>,
  options: FetchOptions | undefined,
  guidance: ExtractionGuidance,
): Promise<FetchResult> {
  const fetchUrl = meta.fetchUrl!;
  const headers: Record<string, string> = {
    "User-Agent": "releases/0.1 (+https://releases.sh)",
    "Accept": "*/*",
  };
  if (!options?.full) {
    if (meta.fetchEtag) headers["If-None-Match"] = meta.fetchEtag;
    if (meta.fetchLastModified) headers["If-Modified-Since"] = meta.fetchLastModified;
  }

  logger.info(`Direct-fetch: GET ${fetchUrl}`);
  const res = await fetch(fetchUrl, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 304) {
    logger.info("Direct-fetch: 304 Not Modified");
    return { releases: [] };
  }
  if (!res.ok) {
    throw new AdapterError("agent", `Direct-fetch returned ${res.status} ${res.statusText} for ${fetchUrl}`);
  }

  const body = await res.text();
  if (!body.trim()) {
    logger.warn("Direct-fetch returned empty body");
    return { releases: [] };
  }

  logger.info(`Direct-fetch returned ${body.length.toLocaleString()} chars`);

  // Persist new conditional-fetch headers BEFORE the content-hash short-circuit:
  // a 200 response means the upstream's etag/last-modified changed (otherwise
  // we'd have hit 304), so storing them lets the next request re-attempt 304
  // instead of pulling the body again.
  const newEtag = res.headers.get("etag") ?? undefined;
  const newLastModified = res.headers.get("last-modified") ?? undefined;
  const headerUpdates: { fetchEtag?: string; fetchLastModified?: string } = {};
  if (newEtag) headerUpdates.fetchEtag = newEtag;
  if (newLastModified) headerUpdates.fetchLastModified = newLastModified;
  if (Object.keys(headerUpdates).length > 0) {
    await updateSourceMeta(source, headerUpdates);
  }

  // Both checks are load-bearing: conditional headers don't catch upstream
  // re-renders that produce identical content (common with SSG rebuilds —
  // new etag, same payload).
  const contentHash = sha256Hex(body);
  if (await checkContentHash(source, contentHash, { dryRun: options?.dryRun })) {
    logger.info("No changes detected (content hash unchanged)");
    return { releases: [] };
  }

  const result = await extractFromBody({
    body,
    systemPrompt: DIRECT_FETCH_SYSTEM_PROMPT,
    userMessage: `Extract all changelog/release entries from this content (canonical source URL: ${source.url}, fetched from: ${fetchUrl}):`,
    guidance,
  });

  await logUsage({
    operation: "agent-ingest",
    model: config.agentModel(),
    inputTokens: result.totalInput,
    outputTokens: result.totalOutput,
    sourceSlug: source.slug,
    releaseCount: result.entries.length,
  });

  logger.info(`Total: ${result.totalInput.toLocaleString()} input + ${result.totalOutput.toLocaleString()} output tokens`);

  let releases = mapEntries(result.entries, source.url);
  if (options?.since) {
    releases = releases.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
  }
  if (options?.maxEntries) {
    releases = releases.slice(0, options.maxEntries);
  }

  logger.info(`Extracted ${releases.length} release(s) via direct-fetch`);
  return { releases };
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
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "");

    const textOnly = withoutScripts
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const textRatio = textOnly.length / html.length;

    if (textRatio < 0.05) {
      logger.info(`Page looks JS-rendered (text ratio: ${(textRatio * 100).toFixed(1)}%)`);
      return true;
    }
    return false;
  } catch {
    return false; // Can't tell — try web_fetch
  }
}

// ── Adapter ──────────────────────────────────────────────────────────
// Routes based on page type:
//   - Static/SSR pages → server-side web_fetch with dynamic filtering
//   - JS-rendered SPAs → Cloudflare Browser Rendering directly

/** Threshold below which we suspect web_fetch missed content */
const MIN_EXPECTED_ENTRIES = 3;

export const agent: Adapter = {
  async fetch(source: Source, options?: FetchOptions): Promise<FetchResult> {
    const apiKey = config.anthropicApiKey();
    if (!apiKey) {
      throw new AdapterError(
        "agent",
        "ANTHROPIC_API_KEY must be set to use the agent adapter.",
      );
    }

    logger.info(`Running agent extraction for ${source.url} (model: ${config.agentModel()})...`);

    const meta = getSourceMeta(source);
    const playbookContext = await loadPlaybookContext(source);
    if (playbookContext) {
      logger.info(`Loaded org playbook (${playbookContext.length.toLocaleString()} chars) for agent context`);
    }
    const guidance: ExtractionGuidance = {
      parseInstructions: meta.parseInstructions,
      playbookContext: playbookContext ?? undefined,
    };

    if (meta.fetchUrl) {
      return fetchViaDirectFetch(source, meta, options, guidance);
    }

    let result: { entries: ExtractedEntry[]; totalInput: number; totalOutput: number };
    const jsRendered = await isJsRenderedPage(source.url);

    if (jsRendered) {
      const markdown = await fetchViaCloudflare(source.url);
      if (markdown) {
        logger.info(`Cloudflare returned ${markdown.length.toLocaleString()} chars of markdown`);

        const contentHash = sha256Hex(markdown);
        if (await checkContentHash(source, contentHash, { dryRun: options?.dryRun })) {
          logger.info(`No changes detected for ${source.url} (content hash unchanged)`);
          return { releases: [] };
        }

        result = await extractFromBody({
          body: markdown,
          systemPrompt: CLOUDFLARE_SYSTEM_PROMPT,
          userMessage: `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
          guidance,
        });
      } else {
        throw new AdapterError(
          "agent",
          `Page is JS-rendered and Cloudflare credentials are not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.`,
        );
      }
    } else {
      try {
        result = await runWebFetchLoop(source.url, guidance);
      } catch (err) {
        throw new AdapterError(
          "agent",
          `Agent extraction failed for ${source.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      logger.info(`web_fetch found ${result.entries.length} entries (${result.totalInput.toLocaleString()} input + ${result.totalOutput.toLocaleString()} output tokens)`);

      if (result.entries.length < MIN_EXPECTED_ENTRIES) {
        logger.info(`Only ${result.entries.length} entries — trying Cloudflare fallback...`);
        const markdown = await fetchViaCloudflare(source.url);
        if (markdown) {
          logger.info(`Cloudflare returned ${markdown.length.toLocaleString()} chars of markdown`);

          const contentHash = sha256Hex(markdown);
          if (await checkContentHash(source, contentHash, { dryRun: options?.dryRun })) {
            logger.info(`No changes detected for ${source.url} (content hash unchanged)`);
            return { releases: [] };
          }

          try {
            const cfResult = await extractFromBody({
              body: markdown,
              systemPrompt: CLOUDFLARE_SYSTEM_PROMPT,
              userMessage: `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
              guidance,
            });
            if (cfResult.entries.length > result.entries.length) {
              logger.info(`Cloudflare found ${cfResult.entries.length} entries (vs ${result.entries.length}) — using Cloudflare results`);
              result = {
                entries: cfResult.entries,
                totalInput: result.totalInput + cfResult.totalInput,
                totalOutput: result.totalOutput + cfResult.totalOutput,
              };
            }
          } catch (err) {
            logger.warn(`Cloudflare extraction failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    await logUsage({
      operation: "agent-ingest",
      model: config.agentModel(),
      inputTokens: result.totalInput,
      outputTokens: result.totalOutput,
      sourceSlug: source.slug,
      releaseCount: result.entries.length,
    });

    logger.info(`Total: ${result.totalInput.toLocaleString()} input + ${result.totalOutput.toLocaleString()} output tokens`);

    let releases = mapEntries(result.entries, source.url);

    // Apply date and count limits
    if (options?.since) {
      releases = releases.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
    }
    if (options?.maxEntries) {
      releases = releases.slice(0, options.maxEntries);
    }

    logger.info(`Extracted ${releases.length} release(s) from ${source.url}`);

    return { releases };
  },
};
