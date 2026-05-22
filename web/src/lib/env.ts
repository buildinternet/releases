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
