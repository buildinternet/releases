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
