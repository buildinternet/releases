import type { Source } from "@buildinternet/releases-core/schema";
import {
  sliceChangelog,
  DEFAULT_CHANGELOG_SLICE_TOKENS,
} from "@buildinternet/releases-core/changelog-slice";
import type { RawRelease } from "@releases/adapters/types.js";
import {
  extractFromBody,
  mapEntries,
  CLOUDFLARE_SYSTEM_PROMPT,
  CRAWL_PAGE_SYSTEM_PROMPT,
  type ExtractDeps,
} from "@releases/adapters/extract";

/** Minimal usage payload passed to `logUsageFn`. */
export interface FirecrawlExtractUsageEntry {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface FirecrawlExtractDeps {
  anthropicClient: ExtractDeps["anthropicClient"];
  agentModel: string;
  logger: ExtractDeps["logger"];
  /**
   * Optional callback invoked after each extraction call with token-usage data.
   * Fail-open: errors thrown here are silently swallowed by the callers so a
   * DB write failure never aborts an extraction.
   */
  logUsageFn?: (entry: FirecrawlExtractUsageEntry) => Promise<void>;
}

/** Token-usage subset every extraction result exposes — the bits we log. */
interface ExtractUsageResult {
  totalInput: number;
  totalOutput: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Forward one extraction's token usage to `deps.logUsageFn` (if wired) as a
 * `firecrawl-extract` row. Fail-open: a logging error never aborts extraction.
 */
async function reportUsage(deps: FirecrawlExtractDeps, result: ExtractUsageResult): Promise<void> {
  if (!deps.logUsageFn) return;
  try {
    await deps.logUsageFn({
      operation: "firecrawl-extract",
      model: deps.agentModel,
      inputTokens: result.totalInput,
      outputTokens: result.totalOutput,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    });
  } catch {
    // fail-open
  }
}

export interface FirecrawlExtractResult {
  releases: RawRelease[];
  totalInput: number;
  totalOutput: number;
  mode: string;
  /** Chars trimmed from the tail when the body exceeded the recent-window budget; 0 if untouched. */
  droppedChars: number;
}

export interface ExtractFirecrawlOptions {
  /**
   * Per-page canonical URL for a CRAWL monitor. Firecrawl crawls the index
   * (`source.url`) and reports each discovered entry page on its own URL; this
   * is that page's URL. When set, every extracted release is attributed to this
   * BARE URL (no synthesized `#anchor`) — exactly the scheme the in-repo crawl
   * adapter stores (`scrape-fetch.ts` per-page attribution), so a crawl monitor's
   * re-ingest dedups on `UNIQUE(source_id, url)` against existing crawl rows.
   * Omitted for SCRAPE monitors, which keep `${source.url}#${slug}` attribution.
   */
  pageUrl?: string;
}

export async function extractFirecrawlMarkdown(
  markdown: string,
  source: Source,
  deps: FirecrawlExtractDeps,
  opts: ExtractFirecrawlOptions = {},
): Promise<FirecrawlExtractResult> {
  // Bound the extraction input to a recent window before the one-shot extract.
  // Firecrawl's `changed` events hand us a small diff delta (well under budget,
  // so this is a no-op for them); the case that matters is the one-time
  // `new`/baseline scrape of a full, years-deep changelog, whose extracted
  // output would otherwise overrun the model's output-token cap and yield zero
  // parseable entries. We send the most-recent window — the top of a
  // newest-first changelog, snapped to entry headings so no entry is cut
  // mid-way — and rely on forward diffs for the rest.
  const sliced = sliceChangelog(markdown, { tokens: DEFAULT_CHANGELOG_SLICE_TOKENS });
  const body = sliced.content;
  const droppedChars = sliced.totalChars - body.length;

  // extractFromBody only reads anthropicClient/agentModel/logger; the rest are
  // inert fillers so the deps object is type-complete. We never opt into the
  // tool-loop tier (no `useToolLoop`), so the windowed body always takes the
  // one-shot path — and windowing is what keeps that single response under the
  // output-token cap.
  const extractDeps: ExtractDeps = {
    anthropicClient: deps.anthropicClient,
    agentModel: deps.agentModel,
    logger: deps.logger,
    cloudflare: null,
    extractToolLoopEnabled: false,
    repo: {
      peekContentHash: async () => false,
      commitContentHash: async () => {},
      updateSourceMeta: async () => {},
      getOrgPlaybook: async () => null,
      logUsage: async () => {},
    },
  };

  // Prompt selection by monitor target — the crawl-vs-scrape signal is already
  // in hand as opts.pageUrl (set only for CRAWL monitors, where each webhook
  // page is exactly one per-post body). For those, use the body-preserving
  // CRAWL_PAGE_SYSTEM_PROMPT ("Do NOT summarize") so the canonical post body is
  // stored verbatim rather than condensed. SCRAPE monitors watch a single
  // multi-entry index page, where extracting + condensing many entries off one
  // page is correct — keep CLOUDFLARE_SYSTEM_PROMPT. See issue #1343.
  const isCrawlPage = !!opts.pageUrl;
  const result = await extractFromBody(
    {
      body,
      systemPrompt: isCrawlPage ? CRAWL_PAGE_SYSTEM_PROMPT : CLOUDFLARE_SYSTEM_PROMPT,
      userMessage: isCrawlPage
        ? `Extract the release/changelog post on this page, preserving its full body verbatim (page URL: ${opts.pageUrl}):`
        : `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
      sourceUrl: source.url,
      fetchUrl: source.url,
    },
    extractDeps,
  );

  await reportUsage(deps, result);

  const releases = mapEntries(result.entries, { sourceUrl: source.url }) as RawRelease[];

  // Crawl monitor: this body is a single discovered entry page, so attribute
  // every extracted release to that page's BARE canonical URL. This mirrors the
  // crawl adapter (one discovered page → one bare-URL release row) and is what
  // makes a crawl monitor's re-ingest dedup against existing crawl rows rather
  // than minting `${source.url}#${slug}` anchors that would never match.
  if (opts.pageUrl) {
    for (const release of releases) release.url = opts.pageUrl;
  }

  return {
    releases,
    totalInput: result.totalInput,
    totalOutput: result.totalOutput,
    mode: result.mode,
    droppedChars,
  };
}

export interface ExtractAllWindowsResult {
  /** mapEntries output across all processed windows, PRE-dedup. */
  releases: RawRelease[];
  /** Windows actually processed. */
  windows: number;
  /** True when `maxWindows` stopped the loop before reaching the end. */
  cappedAtWindow: boolean;
  /** Chars in the untouched tail when capped; 0 when the whole doc was covered. */
  droppedChars: number;
  totalInput: number;
  totalOutput: number;
}

/** Backstop so a pathological doc (or a heading-snap that fails to advance)
 *  can't loop unbounded. Overridable per call. */
const DEFAULT_MAX_WINDOWS = 50;

export interface WindowPlan {
  /** Starting char offset for each window, in document order. Always starts with 0. */
  offsets: number[];
  /** True when `maxWindows` stopped the walk before reaching the end of the document. */
  cappedAtWindow: boolean;
  /** Chars in the untouched tail when capped; 0 when the whole document was covered. */
  droppedChars: number;
}

/**
 * LLM-free window offset walk: precompute the per-window starting offsets that
 * `extractChangelogAllWindows` would use, without making any Anthropic calls.
 * A durable workflow can call this once to plan the window set, then dispatch
 * each `offsets[i]` as its own step.
 */
export function planWindowOffsets(
  markdown: string,
  opts: { maxWindows?: number } = {},
): WindowPlan {
  const maxWindows = Math.max(1, opts.maxWindows ?? DEFAULT_MAX_WINDOWS);
  const offsets: number[] = [];
  let offset: number | null = 0;
  let lastProcessedEnd = 0;
  while (offset !== null && offsets.length < maxWindows) {
    const sliced = sliceChangelog(markdown, { tokens: DEFAULT_CHANGELOG_SLICE_TOKENS, offset });
    offsets.push(sliced.offset);
    lastProcessedEnd = sliced.offset + sliced.content.length;
    offset = sliced.nextOffset;
  }
  const cappedAtWindow = offset !== null;
  const droppedChars = cappedAtWindow ? Math.max(0, markdown.length - lastProcessedEnd) : 0;
  return { offsets, cappedAtWindow, droppedChars };
}

/**
 * Full-history variant of {@link extractFirecrawlMarkdown}: instead of slicing
 * to the recent window and dropping the tail, walk the whole document one
 * `DEFAULT_CHANGELOG_SLICE_TOKENS` window at a time (chaining `sliceChangelog`'s
 * `nextOffset`) and accumulate the extracted entries. Each window is a one-shot
 * `extractFromBody` call (windowing keeps every call under the output cap), so
 * this is the dedup-safe primitive a backfill reuses. Caller dedups by URL.
 */
export async function extractChangelogAllWindows(
  markdown: string,
  source: Source,
  deps: FirecrawlExtractDeps,
  opts: { maxWindows?: number } = {},
): Promise<ExtractAllWindowsResult> {
  // Single source of truth for the window walk: `planWindowOffsets` (LLM-free)
  // owns offset chaining + cap/dropped-tail accounting. We re-slice each planned
  // offset and extract it, so this path stays in lockstep with the workflow's
  // per-step path, which dispatches the very same offsets.
  const plan = planWindowOffsets(markdown, opts);

  const extractDeps: ExtractDeps = {
    anthropicClient: deps.anthropicClient,
    agentModel: deps.agentModel,
    logger: deps.logger,
    cloudflare: null,
    extractToolLoopEnabled: false,
    repo: {
      peekContentHash: async () => false,
      commitContentHash: async () => {},
      updateSourceMeta: async () => {},
      getOrgPlaybook: async () => null,
      logUsage: async () => {},
    },
  };

  const releases: RawRelease[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  for (const offset of plan.offsets) {
    const sliced = sliceChangelog(markdown, {
      tokens: DEFAULT_CHANGELOG_SLICE_TOKENS,
      offset,
    });
    // oxlint-disable-next-line no-await-in-loop -- sequential by design; each window is bounded + cheap (Haiku t0)
    const result = await extractFromBody(
      {
        body: sliced.content,
        systemPrompt: CLOUDFLARE_SYSTEM_PROMPT,
        userMessage: `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
        sourceUrl: source.url,
        fetchUrl: source.url,
      },
      extractDeps,
    );
    releases.push(...(mapEntries(result.entries, { sourceUrl: source.url }) as RawRelease[]));
    totalInput += result.totalInput;
    totalOutput += result.totalOutput;
    // oxlint-disable-next-line no-await-in-loop -- one write per window; bounded by maxWindows
    await reportUsage(deps, result);
  }

  return {
    releases,
    windows: plan.offsets.length,
    cappedAtWindow: plan.cappedAtWindow,
    droppedChars: plan.droppedChars,
    totalInput,
    totalOutput,
  };
}
