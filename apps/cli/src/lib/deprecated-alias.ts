import { logger } from "@buildinternet/releases-lib/logger";

/**
 * Wrap a Commander action with a deprecation warning emitted to stderr.
 *
 * Usage: pass the result as the `.action()` callback on an alias command so
 * that both the canonical name and the deprecated alias resolve to the same
 * handler, but the alias path always warns first.
 *
 *   canonical.command("create").action(handler);
 *   canonical.command("add").action(warnDeprecatedAlias("add", "create", handler));
 */
export function warnDeprecatedAlias<T extends unknown[]>(
  oldVerb: string,
  newVerb: string,
  action: (...args: T) => void | Promise<void>,
): (...args: T) => void | Promise<void> {
  return (...args: T) => {
    logger.warn(`"${oldVerb}" is deprecated, use "${newVerb}"`);
    return action(...args);
  };
}
