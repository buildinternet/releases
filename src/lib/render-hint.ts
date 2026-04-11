import { getProviderHints } from "./providers.js";

/** Determine whether a source can use the fast (no-render) fetch path. Exported for testing. */
export function shouldUseFastFetch(meta: { renderRequired?: boolean; provider?: string }): boolean {
  // Explicit override takes precedence
  if (meta.renderRequired === true) return false;
  if (meta.renderRequired === false) return true;

  // Fall back to provider hint
  if (meta.provider) {
    const hints = getProviderHints(meta.provider);
    return hints?.staticContent === true;
  }

  return false;
}
