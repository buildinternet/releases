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
  // extractFromBody's one-shot path only reads anthropicClient/agentModel/logger;
  // supply the rest as inert no-ops so the deps object is type-complete.
  const extractDeps: ExtractDeps = {
    anthropicClient: deps.anthropicClient,
    agentModel: deps.agentModel,
    logger: deps.logger,
    cloudflare: null,
    extractToolLoopEnabled: deps.useToolLoop ?? false,
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
