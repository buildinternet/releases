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
