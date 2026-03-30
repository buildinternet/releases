/** Shared utilities for release extraction across AI parsers and adapters. */

/** Matches placeholder version strings the model sometimes returns instead of omitting the field. */
export const PLACEHOLDER_RE = /^<?(unknown|none|n\/a|null|undefined)>?$/i;

/** Normalize placeholder version strings to undefined. */
export function sanitizeVersion(version: string | undefined): string | undefined {
  if (!version || PLACEHOLDER_RE.test(version.trim())) return undefined;
  return version;
}

/** Shared properties for release extraction tool schemas. */
export const releaseItemProperties = {
  version: {
    type: "string" as const,
    description: "Version number or tag (e.g. v1.2.3). Omit if not present.",
  },
  title: {
    type: "string" as const,
    description: "Title of the release entry.",
  },
  content: {
    type: "string" as const,
    description:
      "Full content of the release in markdown. Keep it concise — summarize long entries to their key changes. Preserve image URLs as markdown image links.",
  },
  publishedAt: {
    type: "string" as const,
    description: "Publication date in ISO 8601 format. Omit if not present.",
  },
  isBreaking: {
    type: "boolean" as const,
    description: "Whether this release contains breaking changes.",
  },
};

export const releaseItemRequired = ["title", "content", "isBreaking"] as const;
