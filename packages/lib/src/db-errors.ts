// App-level error codes for D1 failures. Worker code wraps raw D1 / Drizzle
// errors with `classifyDbError()` so downstream callers can branch on a stable
// `code` instead of substring-matching the upstream message. Logs surface
// `causeCode` + `causeMessage` as top-level fields for filterability.
//
// Adding a code:
//  1. Add to `DB_ERROR_CODES`.
//  2. Add a matcher in `classifyDbError()` that maps the upstream message to
//     the new code and decides `transient`.
//  3. Bump the test file.
//
// `transient: true` means the caller should treat the failure as an infra
// blip (don't increment per-source error counters, let the next retry tick
// pick it up). `transient: false` means the call would fail the same way on
// immediate retry — surfaces / counters should react.

// - DB_OVERLOADED:         D1 storage rejected requests for being queued too long.
// - DB_NETWORK_LOST:       Connection to D1 dropped mid-request. Almost always clears next tick.
// - DB_STORAGE_RESET:      "Internal error in D1 DB storage caused object to be reset."
// - DB_TIMEOUT:            "D1 DB storage operation exceeded timeout which caused object to be reset."
// - DB_INTERNAL:           Generic D1 internal error with a CF reference id.
// - DB_TOO_MANY_VARIABLES: Statement exceeded D1's 100-bind cap. Caller chunk size is wrong.
// - DB_UNKNOWN:            D1_ERROR with an unrecognized message. Treat as non-transient until classified.
export const DB_ERROR_CODES = [
  "DB_OVERLOADED",
  "DB_NETWORK_LOST",
  "DB_STORAGE_RESET",
  "DB_TIMEOUT",
  "DB_INTERNAL",
  "DB_TOO_MANY_VARIABLES",
  "DB_UNKNOWN",
] as const;

export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

export interface ClassifiedDbError {
  code: DbErrorCode;
  message: string;
  transient: boolean;
}

// Gate: the chain must carry one of these tokens before MATCHERS fires.
// Without the gate, a non-D1 error (e.g. a Voyage `fetch()` failing with
// "Network connection lost") would be misclassified as transient D1 and
// silently skip the per-source consecutiveErrors bump.
const D1_FOOTPRINT = /D1_ERROR|D1 DB|SQLITE_ERROR/i;

interface Matcher {
  pattern: RegExp;
  code: DbErrorCode;
  transient: boolean;
}

const MATCHERS: Matcher[] = [
  { pattern: /D1 DB is overloaded/i, code: "DB_OVERLOADED", transient: true },
  { pattern: /Network connection lost/i, code: "DB_NETWORK_LOST", transient: true },
  {
    pattern: /Internal error in D1 DB storage caused object to be reset/i,
    code: "DB_STORAGE_RESET",
    transient: true,
  },
  {
    pattern: /D1 DB storage operation exceeded timeout/i,
    code: "DB_TIMEOUT",
    transient: true,
  },
  { pattern: /internal error; reference =/i, code: "DB_INTERNAL", transient: true },
  { pattern: /too many SQL variables/i, code: "DB_TOO_MANY_VARIABLES", transient: false },
];

/**
 * Walk an Error's `.cause` chain, returning the chain in head-to-tail order.
 * Caps depth at 8 to defend against circular causes.
 */
function walkCauseChain(err: unknown): Error[] {
  const chain: Error[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  for (let i = 0; i < 8 && cur instanceof Error && !seen.has(cur); i++) {
    chain.push(cur);
    seen.add(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * Inspect a thrown value and return a stable classification when it
 * originated from D1, otherwise `null`. Walks the cause chain so a Drizzle
 * `DrizzleQueryError` wrapping a D1 `Error` still resolves to the inner D1
 * code.
 */
export function classifyDbError(err: unknown): ClassifiedDbError | null {
  const chain = walkCauseChain(err);
  const d1Frame = chain.find((e) => D1_FOOTPRINT.test(e.message ?? ""));
  if (!d1Frame) return null;
  for (const e of chain) {
    const msg = e.message ?? "";
    const match = MATCHERS.find((m) => m.pattern.test(msg));
    if (match) {
      return { code: match.code, message: msg, transient: match.transient };
    }
  }
  // Chain carries a D1 footprint but no matcher hit — surface as DB_UNKNOWN
  // so the unmapped message shows up in logs and a matcher can be added.
  return { code: "DB_UNKNOWN", message: d1Frame.message, transient: false };
}
