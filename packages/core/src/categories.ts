export const CATEGORIES = [
  "ai",
  "cloud",
  "commerce",
  "crm",
  "database",
  "design",
  "developer-tools",
  "devops",
  "finance",
  "framework",
  "infrastructure",
  "observability",
  "productivity",
  "security",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isValidCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/**
 * Resolve a possibly-aliased category input to its canonical slug. Pass the
 * runtime alias map (keys are alias slugs, values are canonical slugs from
 * `CATEGORIES`) — typically loaded once per request from the `categories`
 * table. Returns the canonical slug when `input` is either canonical or a
 * known alias, otherwise null. Caller is responsible for validating the
 * resolved slug via `isValidCategory` (the alias map should never point to a
 * non-canonical slug, but this defends against drift).
 */
export function resolveCategorySlug(
  input: string,
  aliasMap: ReadonlyMap<string, string>,
): Category | null {
  if (isValidCategory(input)) return input;
  const canonical = aliasMap.get(input);
  if (canonical && isValidCategory(canonical)) return canonical;
  return null;
}

/**
 * Slug shape for an alias entry — same regex as elsewhere in the codebase
 * (lowercased alphanumeric + hyphens, must start with a letter/digit). Used
 * by the PATCH /v1/categories/:slug handler to validate user-supplied
 * aliases before persisting.
 */
export const CATEGORY_ALIAS_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse the JSON-encoded `categories.aliases` text column into a string array.
 * Bad / missing JSON degrades to an empty array rather than throwing so read
 * paths can't 500 on a malformed row.
 */
export function parseCategoryAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is string => typeof a === "string");
  } catch {
    return [];
  }
}

const CATEGORY_DISPLAY_OVERRIDES: Record<string, string> = {
  ai: "AI",
  crm: "CRM",
  devops: "DevOps",
};

/**
 * Render a category slug as a display label (e.g. "ai" → "AI",
 * "developer-tools" → "Developer Tools"). Applies explicit overrides for the
 * slugs in `CATEGORIES` whose default title-casing reads wrong.
 */
export function categoryDisplayName(slug: string): string {
  const override = CATEGORY_DISPLAY_OVERRIDES[slug];
  if (override) return override;
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
