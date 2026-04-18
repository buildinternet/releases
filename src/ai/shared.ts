/**
 * Back-compat shim: the shared extraction utilities now live in the
 * `@releases/adapters/extract/shared` and `/extract/types` paths so they can
 * be consumed from Workers-targeted code too.
 *
 * New callers should import from those paths directly.
 */

export {
  PLACEHOLDER_RE,
  sanitizeVersion,
  releaseItemProperties,
  releaseItemRequired,
  extractReleasesToolFull,
  extractReleasesToolIncremental,
  withGuidance,
  withParseInstructions,
  EXTRACTION_RULES,
  WEBFETCH_SYSTEM_PROMPT,
  CLOUDFLARE_SYSTEM_PROMPT,
  DIRECT_FETCH_SYSTEM_PROMPT,
  INCREMENTAL_SYSTEM,
  formatKnownReleases,
  findContentStart,
  LARGE_BODY_TOKEN_THRESHOLD,
  HUGE_BODY_TOKEN_THRESHOLD,
  DEFAULT_MAX_OUTPUT_TOKENS,
  HUGE_BODY_MAX_OUTPUT_TOKENS,
  buildBodyGuardrail,
  mapEntries,
  type ExtractionGuidance,
  type MappedEntry,
  type MapEntriesOptions,
} from "@releases/adapters/extract/shared";

export type { ExtractedEntry, KnownRelease } from "@releases/adapters/extract/types";
