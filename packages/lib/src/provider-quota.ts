/**
 * Detect "the provider has cut us off for billing reasons" across every AI
 * client we use.
 *
 * This is deliberately separate from `classifyAnthropicError`. That classifier
 * discriminates on `instanceof APIError` from `@anthropic-ai/sdk` and covers
 * `credit_balance_too_low` — a *prepaid balance* problem. The 2026-07-23 outage
 * was a different failure: a configured **spend cap** on the account, surfaced
 * through the AI SDK as a plain `AI_APICallError` whose only distinguishing
 * feature is its message:
 *
 *   "You have reached your specified API usage limits.
 *    You will regain access on 2026-08-01 at 00:00 UTC."
 *
 * `classifyAnthropicError` returns `{ kind: "other" }` for that, so it read as
 * an ordinary transient failure, retried, exhausted, and went quiet. Six days of
 * Firecrawl ingestion were lost before anyone noticed, because nothing in the
 * system distinguished "this call failed" from "this provider is closed for
 * business until a date certain".
 *
 * That distinction is the whole point of this module: a quota shutoff is not
 * retryable, not transient, and needs an operator, so it deserves its own signal.
 */

/** Which provider cut us off. `unknown` when the error carries no attribution. */
export type QuotaProvider = "anthropic" | "openrouter" | "unknown";

export interface ProviderQuotaExhaustion {
  provider: QuotaProvider;
  /** When access returns, when the provider states it. Null if unstated. */
  regainAccessAt: Date | null;
  /** The provider's own message, trimmed — worth surfacing verbatim to an operator. */
  message: string;
}

/**
 * Message shapes that mean "cut off for billing/quota reasons", as opposed to
 * ordinary per-minute rate limiting. Matching on prose is unpleasant but it is
 * the only signal these errors carry: the AI SDK flattens provider errors into
 * `AI_APICallError` with no structured quota field.
 *
 * Kept narrow on purpose. A false positive here would page an operator for a
 * transient blip; a false negative just degrades to today's behavior (a warn),
 * so the conservative direction is clear.
 */
const QUOTA_PATTERNS: readonly RegExp[] = [
  // Anthropic: an account/workspace spend cap was hit.
  /reached your specified API usage limits/i,
  // Anthropic: prepaid balance exhausted.
  /credit balance is too low/i,
  // OpenRouter: account credits exhausted.
  /insufficient credits/i,
  // Generic, used by several providers on hard billing stops.
  /quota exceeded/i,
  /billing hard limit/i,
];

/** "regain access on 2026-08-01 at 00:00 UTC" → Date. */
const REGAIN_AT = /regain access on (\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{2}:\d{2})\s*UTC)?/i;

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

function providerOf(err: unknown, message: string): QuotaProvider {
  // The AI SDK stamps the provider id on the error when it has one.
  if (err && typeof err === "object") {
    const raw =
      (err as { providerId?: unknown; provider?: unknown }).providerId ??
      (err as { provider?: unknown }).provider;
    if (typeof raw === "string") {
      const p = raw.toLowerCase();
      if (p.includes("anthropic")) return "anthropic";
      if (p.includes("openrouter")) return "openrouter";
    }
  }
  if (/anthropic|claude/i.test(message)) return "anthropic";
  if (/openrouter/i.test(message)) return "openrouter";
  return "unknown";
}

/**
 * @returns the exhaustion details when the error is a provider quota/billing
 * shutoff, or `null` for everything else (including ordinary 429 rate limits,
 * which ARE retryable and must not be confused with this).
 */
export function classifyProviderQuota(err: unknown): ProviderQuotaExhaustion | null {
  const message = messageOf(err).trim();
  if (!message) return null;
  if (!QUOTA_PATTERNS.some((re) => re.test(message))) return null;

  let regainAccessAt: Date | null = null;
  const m = REGAIN_AT.exec(message);
  if (m?.[1]) {
    const parsed = new Date(`${m[1]}T${m[2] ?? "00:00"}:00Z`);
    if (!Number.isNaN(parsed.getTime())) regainAccessAt = parsed;
  }

  return { provider: providerOf(err, message), regainAccessAt, message };
}
