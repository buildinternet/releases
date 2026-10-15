import * as cloudflareWorkers from "cloudflare:workers";

/**
 * Request context for Cloudflare Workers Issues.
 *
 * Issues shows attributes on the active trace span with an occurrence
 * (`user.id`, `account.id`, `session.id`). Tracing is already enabled on each
 * worker; `getActiveSpan()` is a no-op outside a request (cron, tests, module
 * scope), so callers can set this as soon as auth resolves.
 *
 * Never put emails, tokens, session tokens, or other secrets here.
 */

type ActiveSpan = { setAttribute(key: string, value: string): void };

const ISSUE_CONTEXT_KEYS = ["user.id", "account.id", "session.id"] as const;

export type IssueContextKey = (typeof ISSUE_CONTEXT_KEYS)[number];

/** Bound so a mistaken secret or blob cannot land on the span. */
const MAX_ID_LENGTH = 128;

const CREDENTIAL_PREFIX = /^(?:rel[a-z]_|bearer\s|eyJ)/i;

function activeSpan(): ActiveSpan | undefined {
  const tracing = (
    cloudflareWorkers as {
      tracing?: { getActiveSpan?: () => ActiveSpan | undefined };
    }
  ).tracing;
  try {
    return tracing?.getActiveSpan?.();
  } catch {
    return undefined;
  }
}

function isSafeId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ID_LENGTH) return false;
  if (value.includes("@") || /\s/.test(value)) return false;
  if (CREDENTIAL_PREFIX.test(value)) return false;
  return true;
}

export function setIssueContext(
  attrs: Partial<Record<IssueContextKey, string | null | undefined>>,
): void {
  const span = activeSpan();
  if (!span) return;
  for (const key of ISSUE_CONTEXT_KEYS) {
    const raw = attrs[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!isSafeId(value)) continue;
    span.setAttribute(key, value);
  }
}
