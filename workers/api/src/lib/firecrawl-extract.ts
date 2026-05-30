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
  type ExtractDeps,
} from "@releases/adapters/extract";

export interface FirecrawlExtractDeps {
  anthropicClient: ExtractDeps["anthropicClient"];
  agentModel: string;
  logger: ExtractDeps["logger"];
}

export interface FirecrawlExtractResult {
  releases: RawRelease[];
  totalInput: number;
  totalOutput: number;
  mode: string;
  /** Chars trimmed from the tail when the body exceeded the recent-window budget; 0 if untouched. */
  droppedChars: number;
}

export async function extractFirecrawlMarkdown(
  markdown: string,
  source: Source,
  deps: FirecrawlExtractDeps,
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

  const result = await extractFromBody(
    {
      body,
      systemPrompt: CLOUDFLARE_SYSTEM_PROMPT,
      userMessage: `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
      sourceUrl: source.url,
      fetchUrl: source.url,
    },
    extractDeps,
  );

  const releases = mapEntries(result.entries, { sourceUrl: source.url }) as RawRelease[];

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
  const maxWindows = Math.max(1, opts.maxWindows ?? DEFAULT_MAX_WINDOWS);

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
  let offset: number | null = 0;
  let windows = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let lastProcessedEnd = 0;

  while (offset !== null && windows < maxWindows) {
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
    windows++;
    lastProcessedEnd = sliced.offset + sliced.content.length;
    offset = sliced.nextOffset;
  }

  const cappedAtWindow = offset !== null;
  const droppedChars = cappedAtWindow ? Math.max(0, markdown.length - lastProcessedEnd) : 0;

  return { releases, windows, cappedAtWindow, droppedChars, totalInput, totalOutput };
}
