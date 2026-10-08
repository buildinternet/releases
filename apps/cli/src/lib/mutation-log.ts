import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveRunDir } from "./run-dir.js";

/**
 * Admin-mutation log. When a run is active — `RELEASES_RUN_DIR` set, or a
 * sticky `.current-run` pointer written by `work start` (#227) — every operator
 * write the CLI makes appends one JSONL line to `<runDir>/mutations.jsonl`.
 * No active run → no-op. Fully fail-open: a logging failure must never break
 * the write it was recording.
 *
 * The chokepoint is the api-client's `apiFetch` (see `src/api/core.ts`), so
 * the gate keys on the HTTP verb rather than per-command wiring.
 *
 * See `docs/architecture/maintenance-workspace.md` in the monorepo.
 */

const MUTATIONS_FILE = "mutations.jsonl";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Endpoints that use a mutating verb but aren't operator state changes —
 * session heartbeats, usage/fetch telemetry, and read-via-POST checks. Kept
 * out so mutations.jsonl stays a clean ledger of what actually changed.
 */
const PLUMBING_PATTERNS = ["/status/event", "/logs/usage", "/logs/fetch", "/content-hash"];

export interface MutationOutcome {
  method: string;
  path: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface MutationRecord {
  timestamp: string;
  command: string;
  target: string;
  result: string;
}

function isPlumbing(path: string): boolean {
  return PLUMBING_PATTERNS.some((p) => path.includes(p));
}

/** Shared with `lib/idempotency.ts` so both the mutation ledger and the
 * idempotency-key gate agree on which POSTs are "just plumbing". */
export function isPlumbingPath(path: string): boolean {
  return isPlumbing(path);
}

/**
 * Cheap gate so `apiFetch` skips all work on the common path. Verb/plumbing
 * checks run first (pure, no I/O), so a GET short-circuits before we touch the
 * filesystem to resolve the run dir — only an actual mutating call pays the
 * pointer lookup.
 */
export function shouldRecordMutation(method: string | undefined, path: string): boolean {
  if (!method || !MUTATING_METHODS.has(method.toUpperCase())) return false;
  if (isPlumbing(path)) return false;
  if (!resolveRunDir()) return false;
  return true;
}

/** The CLI invocation, minus the runtime + script path. Pure for testing. */
export function currentCommand(argv: string[] = process.argv): string {
  return argv.slice(2).join(" ").trim() || "(root)";
}

export function buildMutationRecord(
  outcome: MutationOutcome,
  command: string,
  timestamp: string,
): MutationRecord {
  const status = outcome.status ? ` ${outcome.status}` : "";
  const result = outcome.ok
    ? `ok${status}`
    : `error${status}${outcome.error ? `: ${outcome.error}` : ""}`;
  return {
    timestamp,
    command,
    target: `${outcome.method.toUpperCase()} ${outcome.path}`,
    result,
  };
}

export function recordMutation(outcome: MutationOutcome): void {
  try {
    const runDir = resolveRunDir();
    if (!runDir) return;
    const record = buildMutationRecord(outcome, currentCommand(), new Date().toISOString());
    const file = join(runDir, MUTATIONS_FILE);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n");
  } catch {
    // Fail-open: never break a write because logging failed.
  }
}
