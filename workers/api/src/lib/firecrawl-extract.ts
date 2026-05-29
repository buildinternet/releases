import type { Source } from "@buildinternet/releases-core/schema";
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
  useToolLoop?: boolean;
}

export interface FirecrawlExtractResult {
  releases: RawRelease[];
  totalInput: number;
  totalOutput: number;
  mode: string;
}

export async function extractFirecrawlMarkdown(
  markdown: string,
  source: Source,
  deps: FirecrawlExtractDeps,
): Promise<FirecrawlExtractResult> {
  // extractFromBody only reads anthropicClient/agentModel/logger; the rest are
  // inert fillers so the deps object is type-complete. The tool-loop gate is
  // `opts.useToolLoop` (passed below), NOT `deps.extractToolLoopEnabled` —
  // extractFromBody ignores the latter (only run-direct-fetch reads it).
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
      body: markdown,
      systemPrompt: CLOUDFLARE_SYSTEM_PROMPT,
      userMessage: `Extract all changelog/release entries from this page (source URL: ${source.url}):`,
      sourceUrl: source.url,
      fetchUrl: source.url,
      useToolLoop: deps.useToolLoop ?? false,
    },
    extractDeps,
  );

  const releases = mapEntries(result.entries, { sourceUrl: source.url }) as RawRelease[];

  return {
    releases,
    totalInput: result.totalInput,
    totalOutput: result.totalOutput,
    mode: result.mode,
  };
}
