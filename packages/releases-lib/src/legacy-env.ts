import { logger } from "./logger";

const warned = new Set<string>();

/** Reset warn-once state. Test-only. */
export function __resetLegacyEnvWarnings(): void {
  warned.clear();
}

/**
 * Resolve an env var migrating from a legacy name to a canonical one. Prefers
 * `canonical`; falls back to `legacy` with a one-time deprecation warning.
 * Empty string counts as unset. Returns `undefined` when neither is set.
 *
 * `warn` is injectable for tests; defaults to the shared logger.
 */
export function legacyEnv(
  canonical: string,
  legacy: string,
  warn: (msg: string) => void = (msg) => logger.warn(msg),
): string | undefined {
  const next = process.env[canonical];
  if (next) return next;
  const old = process.env[legacy];
  if (old) {
    if (!warned.has(legacy)) {
      warned.add(legacy);
      warn(
        `${legacy} is deprecated; rename it to ${canonical}. The legacy name still works for now but will be removed.`,
      );
    }
    return old;
  }
  return undefined;
}
