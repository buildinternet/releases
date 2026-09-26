/**
 * Tool names that require a signed-in USER identity (a `relu_…` user key or a
 * "Sign in with Releases" OAuth JWT) rather than anonymous, machine (`relk_…`),
 * or root credentials — the follows tools (`follows-tools.ts`, #1520) and the
 * webhook tools (`webhook-tools.ts`, #1678/#2326).
 *
 * Single source of truth, consumed by two independent call sites that must
 * never drift apart:
 *  - `auth.ts`'s `resolveMcpAuth` — a truly anonymous (no-credential)
 *    `tools/call` for one of these names gets an HTTP-layer sign-in challenge
 *    (401 + `WWW-Authenticate`) instead of silently falling through to
 *    anonymous read (#2408).
 *  - each tool's own `userRequired()` guard, which asserts its own name is
 *    listed here (see `lib/user-api-proxy.ts`) — so a new user-gated tool
 *    that forgets to add itself fails loudly (a thrown error, caught by a
 *    dedicated test) instead of silently missing the challenge.
 */
export const USER_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  // follows-tools.ts
  "follow",
  "unfollow",
  "list_follows",
  "get_personalized_feed",
  // webhook-tools.ts
  "list_webhooks",
  "manage_webhook",
]);
