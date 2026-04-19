/**
 * Incremental extraction strategy: given a markdown body and a list of known
 * releases, ask a Haiku-class model for ONLY the new entries. Cheap single-
 * pass call; used by the scrape path where sources are already substantially
 * indexed and only the top of the page needs fresh attention.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Source } from "@releases/core-internal/schema";
import {
  extractReleasesToolIncremental,
  INCREMENTAL_SYSTEM,
  findContentStart,
  formatKnownReleases,
  mapEntries,
  sanitizeVersion,
  withGuidance,
  type ExtractionGuidance,
  type MappedEntry,
} from "./shared.js";
import type { ExtractDeps, ExtractedEntry, KnownRelease } from "./types.js";

export interface IncrementalOptions {
  markdown: string;
  knownReleases: KnownRelease[];
  guidance?: ExtractionGuidance;
  /** Model override — defaults to `deps.incrementalModel` if set, else Haiku. */
  model?: string;
  /** Max output tokens. Defaults to 8192 (Haiku's comfortable range). */
  maxOutputTokens?: number;
}

const DEFAULT_INCREMENTAL_MODEL = "claude-haiku-4-5-20251001";

export interface IncrementalResult {
  releases: MappedEntry[];
  totalInput: number;
  totalOutput: number;
  /** True when the model flagged the slice as lacking changelog content. */
  needsMoreContext: boolean;
}

export async function runIncrementalExtraction(
  source: Source,
  opts: IncrementalOptions,
  deps: ExtractDeps,
): Promise<IncrementalResult> {
  const { anthropicClient, logger } = deps;
  const model = opts.model ?? deps.incrementalModel ?? DEFAULT_INCREMENTAL_MODEL;

  // Incremental is designed for "we already know most of this source" —
  // running it against an empty known-list would bias toward few results.
  if (opts.knownReleases.length === 0) {
    logger.debug("runIncrementalExtraction: knownReleases is empty; returning []");
    return { releases: [], totalInput: 0, totalOutput: 0, needsMoreContext: false };
  }

  const lines = opts.markdown.split("\n");
  const contentStart = findContentStart(lines);
  const previewCount = Math.min(200, lines.length - contentStart);
  const previewSlice = lines.slice(contentStart, contentStart + previewCount);
  const preview = previewSlice.map((l, i) => `${contentStart + i + 1}: ${l}`).join("\n");

  const response = await anthropicClient.messages.create({
    model,
    max_tokens: opts.maxOutputTokens ?? 8192,
    system: [
      {
        type: "text",
        text: withGuidance(INCREMENTAL_SYSTEM, opts.guidance),
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [extractReleasesToolIncremental],
    tool_choice: { type: "tool", name: "extract_releases" },
    messages: [
      {
        role: "user",
        content: `<known_releases>\n${formatKnownReleases(opts.knownReleases)}\n</known_releases>\n\n## Changelog (lines ${contentStart + 1}–${contentStart + previewCount} of ${lines.length} total)\n\n<changelog>\n${preview}\n</changelog>`,
      },
    ],
  });

  const totalInput = response.usage.input_tokens;
  const totalOutput = response.usage.output_tokens;

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "extract_releases",
  );

  const input = toolBlock?.input as
    | { releases?: ExtractedEntry[]; needsMoreContext?: boolean }
    | undefined;
  const rawReleases = Array.isArray(input?.releases) ? input.releases : [];
  const needsMoreContext = input?.needsMoreContext ?? false;

  const sanitized = rawReleases.map((r) => ({ ...r, version: sanitizeVersion(r.version) }));
  const releases = mapEntries(sanitized, { sourceUrl: source.url });

  return { releases, totalInput, totalOutput, needsMoreContext };
}
