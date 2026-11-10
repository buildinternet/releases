/**
 * API worker base URL. Returns `undefined` when unset so callers keep their own
 * default (dev localhost vs. production host differ by call site).
 */
export function apiBaseUrl(): string | undefined {
  return process.env.RELEASES_API_URL || undefined;
}

/** Static root API token for server-to-API admin calls. Undefined when unset. */
export function serverApiKey(): string | undefined {
  return process.env.RELEASES_API_KEY || undefined;
}

/** Canonical-base-URL override for statically generated files. Undefined when unset. */
export function staticBaseUrlEnv(): string | undefined {
  return process.env.RELEASES_BASE_URL || undefined;
}

/**
 * Shared key for first-party backend callers of web's internal endpoints — the
 * API-worker → web direction, mirroring `RELEASES_PROXY_KEY` on the way in.
 *
 * Channel-scoped, NOT per-feature: `POST /api/revalidate` is simply its first
 * consumer, and the next internal endpoint reuses this rather than adding
 * another secret to provision and rotate. See `lib/service-auth.ts`.
 *
 * Undefined when unset, which fails those endpoints closed.
 */
export function serviceKey(): string | undefined {
  return process.env.RELEASES_SERVICE_KEY;
}
