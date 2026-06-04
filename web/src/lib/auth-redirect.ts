/**
 * Constrain a post-auth redirect target to a same-origin path. We never honor an
 * attacker-supplied absolute URL (`//evil.com`, `https://…`) as the destination
 * after sign-in — only a leading-slash path that isn't protocol-relative. Falls
 * back to the home page. Used on both the server (validating `?redirect=`) and the
 * client (the value passed to Better Auth's `callbackURL`).
 */
export function safeRedirect(value: string | undefined | null, fallback = "/"): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  return value;
}
