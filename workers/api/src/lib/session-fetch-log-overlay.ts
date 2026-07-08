/**
 * Overlay fetch_log status onto session list/detail responses (issue #948).
 *
 * When a long-running fetch lands a successful fetch_log row but the
 * managed-agents SSE stream drops mid-run, the session DO's outer catch
 * rewrites the terminal state as `error` with a generic `errorSource: "us"`.
 * The CLI's `task list` view then shows `error` for a session that actually
 * succeeded — eroding trust in the task-list view as the operator's
 * "what's broken" summary.
 *
 * This overlay is a presentation-time correction: the underlying DO state
 * still holds the wrong terminal value, but the API surface joins against
 * `fetch_log` (keyed by `sessionId`) and overrides the status when the
 * persisted fetch outcome contradicts it.
 *
 * Scope is intentionally narrow:
 *
 * - Only `type: "update"` sessions are considered. Discovery onboards have
 *   other failure modes that don't map cleanly to "the fetch succeeded but
 *   the session report didn't".
 * - Only `errorSource: "us"` (or absent, treated as `"us"`) — provider
 *   errors are real and stay surfaced as-is.
 * - Every matching `fetch_log` row for the session must have
 *   `status: "success"`. A single failed row keeps the session as `error`.
 *
 * Rewrites:
 *
 * - `status` → `"complete"`
 * - `warnings` → appended with a one-liner preserving the original error
 *   message so root-cause analysis is still possible
 *
 * The companion server-side fixes — sanity-checking `fetch_log` inside
 * `fail()` (proposal 1) and making the session-completed event durable
 * (proposal 2) — land separately. After they ship, this overlay becomes
 * defense in depth.
 */
import type { Session } from "@buildinternet/releases-api-types";
import { fetchLog } from "@buildinternet/releases-core/schema";
import { inArray } from "drizzle-orm";
import { IN_ARRAY_CHUNK_SIZE } from "./d1-limits.js";

type FetchLogRow = { sessionId: string | null; status: string };

/**
 * Apply the fetch_log overlay to a session list in place and return it.
 * Performs at most ceil(N/IN_ARRAY_CHUNK_SIZE) batched `inArray` lookups
 * regardless of how many candidate sessions are passed.
 */
export async function applyFetchLogOverlay<T extends Session>(
  // D1 drizzle and bun:sqlite drizzle don't share a public type, and the test
  // harness uses the latter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  sessions: T[],
): Promise<T[]> {
  const candidates = sessions.filter(isOverlayCandidate);
  if (candidates.length === 0) return sessions;

  const sessionIds = candidates.map((s) => s.sessionId);
  const rows: FetchLogRow[] = [];
  for (let i = 0; i < sessionIds.length; i += IN_ARRAY_CHUNK_SIZE) {
    const chunk = sessionIds.slice(i, i + IN_ARRAY_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- sequential chunks: each statement stays under D1's 100-bind cap; parallel fan-out would race the same connection without benefit
    const chunkRows: FetchLogRow[] = await db
      .select({
        sessionId: fetchLog.sessionId,
        status: fetchLog.status,
      })
      .from(fetchLog)
      .where(inArray(fetchLog.sessionId, chunk));
    rows.push(...chunkRows);
  }

  const bySession = new Map<string, { total: number; successes: number }>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const acc = bySession.get(row.sessionId) ?? { total: 0, successes: 0 };
    acc.total += 1;
    if (row.status === "success") acc.successes += 1;
    bySession.set(row.sessionId, acc);
  }

  for (const session of candidates) {
    const counts = bySession.get(session.sessionId);
    if (!counts || counts.total === 0) continue;
    if (counts.successes !== counts.total) continue;

    // Preserve the original error in `warnings` so debuggers can still trace
    // what the underlying session DO recorded.
    const reported = session.error ? `"${session.error}"` : "error";
    const note = `Session reported ${reported} but fetch_log shows the fetch succeeded; treating as complete`;
    session.status = "complete";
    session.warnings = [...(session.warnings ?? []), note];
  }

  return sessions;
}

/**
 * Single-session convenience for the detail endpoint.
 */
export async function applyFetchLogOverlaySingle<T extends Session>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  session: T,
): Promise<T> {
  await applyFetchLogOverlay(db, [session]);
  return session;
}

function isOverlayCandidate(session: Session): boolean {
  if (session.type !== "update") return false;
  if (session.status !== "error") return false;
  // Absent `errorSource` is treated as "us" — that's the same default used by
  // the session DO's `fail()` callsite that we're trying to correct.
  if (session.errorSource && session.errorSource !== "us") return false;
  return true;
}
