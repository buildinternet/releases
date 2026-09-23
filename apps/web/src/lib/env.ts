const warned = new Set<string>();

function legacyEnv(canonical: string, legacy: string): string | undefined {
  const next = process.env[canonical];
  if (next) return next;
  const old = process.env[legacy];
  if (old) {
    if (!warned.has(legacy)) {
      warned.add(legacy);
      console.warn(
        `[releases] ${legacy} is deprecated; rename it to ${canonical}. The legacy name still works for now but will be removed.`,
      );
    }
    return old;
  }
  return undefined;
}

/**
 * API worker base URL. Returns `undefined` when unset so callers keep their own
 * default (dev localhost vs. production host differ by call site).
 */
export function apiBaseUrl(): string | undefined {
  return legacyEnv("RELEASES_API_URL", "RELEASED_API_URL");
}

/** Static root API token for server-to-API admin calls. Undefined when unset. */
export function serverApiKey(): string | undefined {
  return legacyEnv("RELEASES_API_KEY", "RELEASED_API_KEY");
}

/** Canonical-base-URL override for statically generated files. Undefined when unset. */
export function staticBaseUrlEnv(): string | undefined {
  return legacyEnv("RELEASES_BASE_URL", "RELEASED_BASE_URL");
}

/**
 * Shared key for first-party backend callers of web's internal endpoints — the
 * API-worker → web direction, mirroring `RELEASES_PROXY_KEY` on the way in.
 *
 * Channel-scoped, NOT per-feature: `POST /api/revalidate` is simply its first
 * consumer, and the next internal endpoint reuses this rather than adding
 * another secret to provision and rotate. See `lib/service-auth.ts`.
 *
 * Undefined when unset, which fails those endpoints closed. No legacy
 * `RELEASED_` alias — this name is new.
 */
export function serviceKey(): string | undefined {
  return process.env.RELEASES_SERVICE_KEY;
}
