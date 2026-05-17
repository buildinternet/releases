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

export const DB_ERROR_CODES = {
  /** D1 storage backend rejected requests for being queued too long. */
  DB_OVERLOADED: "DB_OVERLOADED",
  /** Connection to D1 dropped mid-request. Almost always clears next tick. */
  DB_NETWORK_LOST: "DB_NETWORK_LOST",
  /** "Internal error in D1 DB storage caused object to be reset." */
  DB_STORAGE_RESET: "DB_STORAGE_RESET",
  /** "D1 DB storage operation exceeded timeout which caused object to be reset." */
  DB_TIMEOUT: "DB_TIMEOUT",
  /** Generic D1 internal error with a CF reference id. */
  DB_INTERNAL: "DB_INTERNAL",
  /** Statement exceeded D1's 100-bind cap. Not transient — caller chunk size is wrong. */
  DB_TOO_MANY_VARIABLES: "DB_TOO_MANY_VARIABLES",
  /** D1_ERROR with a message we don't recognize. Treat as non-transient until classified. */
  DB_UNKNOWN: "DB_UNKNOWN",
} as const;

export type DbErrorCode = (typeof DB_ERROR_CODES)[keyof typeof DB_ERROR_CODES];

export interface ClassifiedDbError {
  code: DbErrorCode;
  message: string;
  transient: boolean;
}

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
  for (const e of chain) {
    const msg = e.message ?? "";
    for (const m of MATCHERS) {
      if (m.pattern.test(msg)) {
        return { code: m.code, message: msg, transient: m.transient };
      }
    }
  }
  // Unknown D1 error: chain contained "D1_ERROR" but no matcher hit. Fall
  // through with the most-specific message so it surfaces in logs and we
  // can add a matcher when it shows up.
  const d1Frame = chain.find((e) => /D1_ERROR/i.test(e.message ?? ""));
  if (d1Frame) {
    return { code: "DB_UNKNOWN", message: d1Frame.message, transient: false };
  }
  return null;
}
