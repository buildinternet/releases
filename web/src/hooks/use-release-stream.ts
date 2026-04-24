"use client";

import { useEffect, useReducer, useRef } from "react";
import type { LatestRelease, MediaItem } from "@releases/api-types";

/**
 * Normalized release shape rendered by /live. Bridges the WebSocket event
 * payload from /v1/releases/stream and the REST response from
 * /v1/releases/latest so the UI only sees one type.
 */
export type LiveRelease = {
  id: string;
  title: string | null;
  version: string | null;
  publishedAt: string | null;
  source: { slug: string; name: string };
  url?: string;
};

export type LiveMode = "websocket" | "polling";

export type LiveState = {
  releases: LiveRelease[];
  connected: boolean;
  mode: LiveMode;
  lastSeq: number | undefined;
};

export type LiveAction =
  | { type: "ws-ready"; seq: number }
  | { type: "ws-event"; seq: number; release: LiveRelease }
  | { type: "ws-close" }
  | { type: "rest-batch"; releases: LiveRelease[] }
  | { type: "polling-start" }
  | { type: "snapshot-gap" };

export const LIVE_MAX_ITEMS = 100;

export const INITIAL_LIVE_STATE: LiveState = {
  releases: [],
  connected: false,
  mode: "websocket",
  lastSeq: undefined,
};

function mergeReleases(existing: LiveRelease[], incoming: LiveRelease[]): LiveRelease[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((r) => r.id));
  const fresh = incoming.filter((r) => !seen.has(r.id));
  if (fresh.length === 0) return existing;
  // Incoming items (both WS events and REST `latest` responses) arrive
  // newest-first, so prepend to preserve the list's newest-first invariant
  // — trimming from the tail when the cap is hit.
  return [...fresh, ...existing].slice(0, LIVE_MAX_ITEMS);
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case "ws-ready":
      return { ...state, connected: true, mode: "websocket", lastSeq: action.seq };
    case "ws-event":
      return {
        ...state,
        connected: true,
        releases: mergeReleases(state.releases, [action.release]),
        lastSeq: action.seq,
      };
    case "ws-close":
      return { ...state, connected: false };
    case "rest-batch": {
      const next = mergeReleases(state.releases, action.releases);
      return next === state.releases ? state : { ...state, releases: next };
    }
    case "polling-start":
      return state.connected ? state : { ...state, mode: "polling" };
    case "snapshot-gap":
      return { ...state, lastSeq: undefined };
    default:
      return state;
  }
}

/** Shape of a release.created event over /v1/releases/stream. Inner `release` reuses the shared LatestRelease type. */
export type StreamEvent = {
  id: string;
  seq: number;
  ts: number;
  type: "release.created";
  release: LatestRelease;
};

/** Shape of an item from GET /v1/releases/latest. Mirrors workers/api/src/routes/releases.ts. */
export type LatestItem = {
  id: string;
  version: string | null;
  type: string;
  title: string | null;
  summary: string | null;
  publishedAt: string | null;
  url: string | null;
  media: MediaItem[];
  source: { slug: string; name: string; type: string };
};

export function fromStreamEvent(e: StreamEvent): LiveRelease {
  return {
    id: e.release.id,
    title: e.release.title,
    version: e.release.version,
    publishedAt: e.release.publishedAt,
    source: { slug: e.release.sourceSlug, name: e.release.sourceName },
  };
}

export function fromLatestItem(item: LatestItem): LiveRelease {
  return {
    id: item.id,
    title: item.title,
    version: item.version,
    publishedAt: item.publishedAt,
    source: { slug: item.source.slug, name: item.source.name },
    url: item.url ?? undefined,
  };
}

const POLL_INTERVAL_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Hold off on REST polling after a WS close — if reconnect succeeds within
// this window, `?since=<lastSeq>` covers the gap and we avoid prepending
// items from /releases/latest that the client has never seen over WS.
const POLL_FALLBACK_DELAY_MS = 2_500;
// Keep the WS alive for a grace window after the tab hides so that the
// favicon "unseen" badge on /live can reflect activity while the user is on
// another tab. After this, we tear down to avoid holding a live connection
// for forgotten tabs — Cloudflare's hibernation API makes idle WS cheap on
// the server, but client connections still count against account-level
// concurrency and per-event fan-out. Revisit if release volume or live-tab
// adoption grows meaningfully.
const HIDDEN_TEARDOWN_MS = 5 * 60_000;

/**
 * Subscribe to /v1/releases/stream and surface a normalized, deduped list of
 * recent releases. Falls back to polling /v1/releases/latest while the
 * WebSocket is closed.
 *
 * `apiUrl` is the base URL of the API worker (no trailing /v1).
 */
export function useReleaseStream(apiUrl: string): LiveState {
  const [state, dispatch] = useReducer(liveReducer, INITIAL_LIVE_STATE);
  const lastSeqRef = useRef<number | undefined>(undefined);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const pollTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const intentionalClose = useRef(false);
  const visibleRef = useRef(true);

  // Keep a ref copy of lastSeq so the connect closure always reads the latest.
  useEffect(() => {
    lastSeqRef.current = state.lastSeq;
  }, [state.lastSeq]);

  useEffect(() => {
    let cancelled = false;
    let pollStartTimer: ReturnType<typeof setTimeout> | undefined;
    let hiddenTeardownTimer: ReturnType<typeof setTimeout> | undefined;

    function clearPollStartTimer() {
      if (pollStartTimer) {
        clearTimeout(pollStartTimer);
        pollStartTimer = undefined;
      }
    }

    function stopPolling() {
      clearPollStartTimer();
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = undefined;
      }
    }

    async function pollOnce() {
      try {
        const res = await fetch(`${apiUrl}/v1/releases/latest?count=10`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const payload = (await res.json()) as { releases: LatestItem[] };
        if (cancelled) return;
        const items = payload.releases ?? [];
        dispatch({ type: "rest-batch", releases: items.map(fromLatestItem) });
      } catch {
        // Swallow — next interval tick retries.
      }
    }

    function startPolling() {
      if (pollTimer.current) return;
      dispatch({ type: "polling-start" });
      void pollOnce();
      pollTimer.current = setInterval(pollOnce, POLL_INTERVAL_MS);
    }

    function connect() {
      if (cancelled) return;
      intentionalClose.current = false;
      const wsBase = apiUrl.replace(/^http/, "ws");
      const since = lastSeqRef.current;
      const qs = since !== undefined ? `?since=${encodeURIComponent(since)}` : "";
      const ws = new WebSocket(`${wsBase}/v1/releases/stream${qs}`);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        reconnectDelay.current = RECONNECT_BASE_MS;
        // If a short blip triggered a pending poll-start but the reconnect
        // succeeded first, cancel the deferred poll before it fires.
        stopPolling();
      });

      ws.addEventListener("message", (event) => {
        if (cancelled) return;
        let msg: unknown;
        try {
          msg = JSON.parse((event as MessageEvent).data as string);
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        const m = msg as { type?: unknown; seq?: unknown };
        if (m.type === "ready" && typeof m.seq === "number") {
          dispatch({ type: "ws-ready", seq: m.seq });
          return;
        }
        if (m.type === "snapshot_gap") {
          dispatch({ type: "snapshot-gap" });
          void pollOnce();
          return;
        }
        if (m.type === "release.created" && typeof m.seq === "number") {
          const evt = msg as StreamEvent;
          dispatch({ type: "ws-event", seq: evt.seq, release: fromStreamEvent(evt) });
        }
      });

      // `handleFailure` runs on close OR error. Synchronous connection failures
      // (DNS / TLS / HTTP/2 upgrade rejection) fire `error` without a `close`,
      // so we can't rely on `close` alone to kick off polling + reconnect.
      let failureHandled = false;
      function handleFailure() {
        if (failureHandled || cancelled) return;
        failureHandled = true;
        dispatch({ type: "ws-close" });
        if (intentionalClose.current) return;
        // Defer REST polling — reconnect may win within the fallback window,
        // in which case WS `?since=<lastSeq>` replay covers any missed events
        // without dumping the latest-10 into the list.
        clearPollStartTimer();
        pollStartTimer = setTimeout(() => {
          pollStartTimer = undefined;
          if (cancelled) return;
          startPolling();
        }, POLL_FALLBACK_DELAY_MS);
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, RECONNECT_MAX_MS);
          connect();
        }, reconnectDelay.current);
      }

      ws.addEventListener("close", handleFailure);
      ws.addEventListener("error", handleFailure);
    }

    function tearDown() {
      intentionalClose.current = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
        dispatch({ type: "ws-close" });
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = undefined;
      }
      stopPolling();
    }

    function onVisibility() {
      const visible = !document.hidden;
      visibleRef.current = visible;
      if (!visible) {
        // Schedule a teardown after a grace window so short tab-flips keep
        // the WS (and the favicon "unseen" badge) live, but a long-abandoned
        // tab doesn't hold a connection forever.
        if (hiddenTeardownTimer) clearTimeout(hiddenTeardownTimer);
        hiddenTeardownTimer = setTimeout(() => {
          hiddenTeardownTimer = undefined;
          if (cancelled || visibleRef.current) return;
          tearDown();
        }, HIDDEN_TEARDOWN_MS);
        return;
      }
      // Returning to the tab: cancel any pending hidden-teardown, reset
      // backoff, and reconnect if the connection dropped while hidden.
      if (hiddenTeardownTimer) {
        clearTimeout(hiddenTeardownTimer);
        hiddenTeardownTimer = undefined;
      }
      reconnectDelay.current = RECONNECT_BASE_MS;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        // tearDown() set intentionalClose — reset so handleFailure would retry
        // if this reconnect attempt itself fails.
        intentionalClose.current = false;
        connect();
      }
    }

    visibleRef.current = !document.hidden;
    document.addEventListener("visibilitychange", onVisibility);
    if (visibleRef.current) {
      // Seed with the most recent releases so the page is useful before the
      // first WS event arrives. Dispatches `rest-batch` (not `polling-start`),
      // so this doesn't flip the mode indicator.
      void pollOnce();
      connect();
    }

    return () => {
      cancelled = true;
      clearPollStartTimer();
      if (hiddenTeardownTimer) {
        clearTimeout(hiddenTeardownTimer);
        hiddenTeardownTimer = undefined;
      }
      document.removeEventListener("visibilitychange", onVisibility);
      tearDown();
    };
  }, [apiUrl]);

  return state;
}
