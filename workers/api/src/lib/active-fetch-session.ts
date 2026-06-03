/**
 * Read-side overlay: the managed-agent session currently fetching a source
 * (#1360). `fetch_log` only records terminal states, so during a multi-minute
 * crawl there is no row at all — an operator/agent can't tell "still running"
 * from "stuck/dead." The StatusHub DO already tracks running, non-stale sessions
 * and which source slugs each is actively fetching, so we join through it to
 * surface live progress on the fetch-log / source-sessions views without a new
 * write path.
 *
 * `getActiveSessionRaw` returns the full session payload (used by
 * `/sources/:slug/sessions`, whose wire shape must stay byte-identical).
 * `getActiveFetchSession` narrows it to the four fields the fetch-log view needs.
 *
 * Both fail open to `null`: a StatusHub hiccup must degrade these read surfaces
 * to today's behavior, never 500 the operator's debugging view.
 */
import type { ActiveFetchSession } from "@buildinternet/releases-api-types";
import { logEvent } from "@releases/lib/log-event";

/** Minimal shape of a StatusHub Durable Object stub (see `getStatusHub`). */
interface StatusHubStub {
  fetch: (req: Request) => Promise<Response>;
}

interface ActiveSourcesResponse {
  slugs: string[];
  sessionMap: Record<string, string>;
}

/**
 * The full running session (raw StatusHub payload) currently fetching
 * `sourceSlug`, or `null` when none is active. Fails open to `null`.
 */
export async function getActiveSessionRaw(
  hub: StatusHubStub,
  sourceSlug: string,
): Promise<Record<string, unknown> | null> {
  try {
    const activeRes = await hub.fetch(new Request("https://do/active-sources"));
    if (!activeRes.ok) return null;
    const { sessionMap } = (await activeRes.json()) as ActiveSourcesResponse;
    const sessionId = sessionMap?.[sourceSlug];
    if (!sessionId) return null;

    const sessionRes = await hub.fetch(
      new Request(`https://do/sessions/${encodeURIComponent(sessionId)}`),
    );
    if (!sessionRes.ok) return null;
    return (await sessionRes.json()) as Record<string, unknown>;
  } catch (err) {
    logEvent("warn", {
      component: "active-fetch-session",
      event: "lookup-failed",
      sourceSlug,
      err: err instanceof Error ? err : String(err),
    });
    return null;
  }
}

/**
 * The active fetch session for `sourceSlug` narrowed to the fetch-log view's
 * fields (`sessionId`, `status`, `startedAt`, `lastUpdatedAt`), or `null`.
 */
export async function getActiveFetchSession(
  hub: StatusHubStub,
  sourceSlug: string,
): Promise<ActiveFetchSession | null> {
  const session = await getActiveSessionRaw(hub, sourceSlug);
  if (!session) return null;
  return {
    sessionId: String(session.sessionId),
    status: String(session.status),
    startedAt: Number(session.startedAt),
    lastUpdatedAt: Number(session.lastUpdatedAt),
  };
}
