import { randomUUID } from "node:crypto";
import { isPlumbingPath } from "./mutation-log.js";

/**
 * Generate a fresh `Idempotency-Key` for one logical write invocation. The
 * API accepts opt-in idempotency on effectful POST routes: 16–255 printable
 * ASCII characters, a replayed request returns the stored response
 * (`Idempotency-Replayed: true`), and reusing a key with a different payload
 * is a 409 `idempotency_conflict`.
 *
 * Callers generate ONE key per logical invocation and reuse it across any
 * automatic retry of that same request — never mint a new key per attempt,
 * or a retry after a transport failure loses its double-submit protection.
 * The `cli-` prefix namespaces CLI-issued keys; a prefixed UUID comfortably
 * fits the length window.
 */
export function newIdempotencyKey(): string {
  return `cli-${randomUUID()}`;
}

/**
 * Only effectful POSTs opt into idempotency. Plumbing POSTs (session
 * heartbeats, usage/fetch telemetry, read-via-POST checks — see
 * `PLUMBING_PATTERNS` in `mutation-log.ts`) aren't state changes worth
 * replay-protecting, so skip them; GET/PUT/PATCH/DELETE aren't in scope for
 * this header per the API's opt-in POST-only contract.
 */
export function shouldSendIdempotencyKey(method: string | undefined, path: string): boolean {
  return method === "POST" && !isPlumbingPath(path);
}
