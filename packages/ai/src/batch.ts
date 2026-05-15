/**
 * Helpers for the Anthropic Message Batches API.
 *
 * Worker-safe (no `fs`, no `node:*`). Used by:
 *   - `scripts/generate-release-content.ts` — release-content backfill
 *   - Future: a `BatchSummarizeWorkflow` in `workers/api/src/workflows/`,
 *     and an automated overview-refresh job when we move overviews off
 *     the agent loop for the refresh path.
 *
 * Why batch: a flat 50% discount on input + output (incl. cache) for any
 * single-message Anthropic call where the caller can tolerate up to 24h
 * before the result lands. Backfills and scheduled refreshes fit; user-
 * blocking and tool-use-loop call sites do not.
 *
 * Three pieces, independently usable:
 *   - submitBatch — fire the request, get a MessageBatch back
 *   - pollBatch — wait for processing_status === "ended" with exp backoff
 *   - collectResults — stream the JSONL, hand each line to a caller parser,
 *     return a Map<custom_id, BatchOutcome>
 *
 * The caller owns the parse step so domain shapes (e.g. release-content's
 * tagged-XML response) stay in the caller's module.
 */

import type Anthropic from "@anthropic-ai/sdk";

// Access types through the default-imported namespace rather than via the
// sub-path module. The sub-path resolves to a different physical install
// under Bun's content-hashed `.bun/` directory in some workspace setups,
// and TypeScript's nominal `#private` check on the `Anthropic` class fails
// when callers and helpers reference different installs. Going through the
// namespace keeps everyone pointed at the same resolution.
type BatchCreateParams = Anthropic.Messages.Batches.BatchCreateParams;
type MessageBatch = Anthropic.Messages.Batches.MessageBatch;
type MessageBatchIndividualResponse = Anthropic.Messages.Batches.MessageBatchIndividualResponse;

/** Anthropic's terminal sentinel for `processing_status`. */
export const BATCH_ENDED_STATUS = "ended" as const;

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_BACKOFF_FACTOR = 2;
// Match Anthropic's upstream 24h batch expiry. Cutting the local poll shorter
// would fail real overnight backfills where the batch hasn't finished but is
// still alive upstream; callers that want a tighter bound pass `timeoutMs`.
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface BatchPollOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  timeoutMs?: number;
  /** Fired after every successful .retrieve. Useful for progress logging. */
  onPoll?: (batch: MessageBatch) => void;
  /** Override the sleep impl. Tests pass an immediate-resolve. */
  sleep?: (ms: number) => Promise<void>;
}

export type BatchOutcome<T> =
  | { kind: "succeeded"; value: T }
  | { kind: "errored"; error: unknown }
  | { kind: "canceled" }
  | { kind: "expired" };

/** Submit a batch. Thin wrapper that drops the awkward `{ requests }` envelope. */
export function submitBatch(
  client: Anthropic,
  requests: BatchCreateParams["requests"],
): Promise<MessageBatch> {
  return client.messages.batches.create({ requests });
}

/**
 * Poll `messages.batches.retrieve` until `processing_status === "ended"`.
 * Throws on timeout. Caller should be prepared for `request_counts.errored`
 * / `.expired` / `.canceled` to be non-zero even on the success return.
 */
export async function pollBatch(
  client: Anthropic,
  batchId: string,
  options: BatchPollOptions = {},
): Promise<MessageBatch> {
  const {
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    backoffFactor = DEFAULT_BACKOFF_FACTOR,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onPoll,
    sleep = defaultSleep,
  } = options;

  const startedAt = Date.now();
  let delay = initialDelayMs;
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- poll loop; parallelism doesn't apply
    await sleep(delay);
    // eslint-disable-next-line no-await-in-loop -- poll loop
    const cur = await client.messages.batches.retrieve(batchId);
    onPoll?.(cur);
    if (cur.processing_status === BATCH_ENDED_STATUS) return cur;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `pollBatch: timed out after ${timeoutMs}ms waiting for ${batchId} (last status: ${cur.processing_status})`,
      );
    }
    delay = Math.min(delay * backoffFactor, maxDelayMs);
  }
}

/**
 * Stream the JSONL results and map each line via `parse`. Per-line errors —
 * both upstream (errored/expired/canceled) and from the parse callback itself —
 * are surfaced as outcomes in the result Map. A single failure does not
 * poison the rest.
 *
 * Results are NOT guaranteed to be in request order; always match by custom_id.
 */
export async function collectResults<T>(
  client: Anthropic,
  batchId: string,
  parse: (message: Anthropic.Message, customId: string) => T,
): Promise<Map<string, BatchOutcome<T>>> {
  const stream = await client.messages.batches.results(batchId);
  const out = new Map<string, BatchOutcome<T>>();
  for await (const line of stream) {
    out.set(line.custom_id, outcomeFor(line, parse));
  }
  return out;
}

function outcomeFor<T>(
  line: MessageBatchIndividualResponse,
  parse: (message: Anthropic.Message, customId: string) => T,
): BatchOutcome<T> {
  switch (line.result.type) {
    case "succeeded":
      try {
        return { kind: "succeeded", value: parse(line.result.message, line.custom_id) };
      } catch (err) {
        return { kind: "errored", error: err };
      }
    case "errored":
      return { kind: "errored", error: line.result.error };
    case "canceled":
      return { kind: "canceled" };
    case "expired":
      return { kind: "expired" };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
