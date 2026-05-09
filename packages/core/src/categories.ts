export const CATEGORIES = [
  "ai",
  "cloud",
  "database",
  "design",
  "developer-tools",
  "devops",
  "framework",
  "infrastructure",
  "observability",
  "security",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isValidCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

const CATEGORY_DISPLAY_OVERRIDES: Record<string, string> = {
  ai: "AI",
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
