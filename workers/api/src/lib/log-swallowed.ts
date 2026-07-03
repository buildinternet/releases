import { logEvent } from "@releases/lib/log-event";

/**
 * `.catch()` handler for best-effort writes: keeps fail-open semantics
 * (resolves to undefined, never rethrows) but surfaces the failure in
 * Workers Logs instead of dropping it.
 */
export function logSwallowed(
  component: string,
  event: string,
  context: Record<string, unknown> = {},
): (err: unknown) => undefined {
  return (err) => {
    logEvent("warn", { component, event, ...context, error: err });
    return undefined;
  };
}
