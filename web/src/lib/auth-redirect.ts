/**
 * Constrain a post-auth redirect target to a same-origin path. We never honor an
 * attacker-supplied absolute URL (`//evil.com`, `https://…`) as the destination
 * after sign-in — only a leading-slash path that isn't protocol-relative. Falls
 * back to the home page. Used on both the server (validating `?redirect=`) and the
 * client (the value passed to Better Auth's `callbackURL`).
 *
 * Accepts `unknown` because Next types a `searchParams` value as `string |
 * string[]` — a repeated `?redirect=a&redirect=b` arrives as an array at runtime.
 * Anything that isn't a plain string falls back rather than throwing on
 * `.startsWith`.
 */
export function safeRedirect(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  return value;
}
