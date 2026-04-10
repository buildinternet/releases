"use client";

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";

interface SessionState {
  sessionId: string;
  company: string;
  type?: "onboard" | "update";
  agent?: "sonnet" | "haiku";
  status: "running" | "complete" | "error";
  step?: string;
  sourcesFound?: number;
  sourcesValidated?: number;
  totalSources?: number;
  sourcesFetched?: number;
  releasesFound?: number;
  releasesInserted?: number;
  currentAction?: string;
  startedAt: number;
  lastUpdatedAt?: number;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

interface FetchLogEntry {
  id: string;
  sourceId: string;
  sessionId?: string | null;
  sourceName?: string;
  sourceSlug?: string;
  orgName?: string;
  orgSlug?: string;
  releasesFound: number;
  releasesInserted: number;
  durationMs?: number;
  status: "success" | "error" | "no_change" | "dry_run";
  error?: string;
  rawContent?: string;
  createdAt: string;
}

interface UsageEntry {
  model: string;
  totalInput: number;
  totalOutput: number;
}

interface StatusMessage {
  type: string;
  [key: string]: unknown;
}

interface SourceEntry {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  orgSlug?: string | null;
  isPrimary?: boolean;
  isHidden?: boolean;
  metadata?: string | null;
  releaseCount?: number;
  latestVersion?: string | null;
  latestDate?: string | null;
  lastFetchedAt?: string | null;
  fetchPriority?: string | null;
  changeDetectedAt?: string | null;
}

interface FetchTriggerResult {
  fetched?: boolean;
  queued?: boolean;
  releasesFound?: number;
  releasesInserted?: number;
  durationMs?: number;
  status?: string;
  error?: string;
  type?: string;
}

type Tab = "sessions" | "fetch-log" | "sources";
type DateRange = "today" | "week" | "month" | "all";

function getDateRangeAfter(range: DateRange): string | null {
  if (range === "all") return null;
  const now = new Date();
  if (range === "today") {
    now.setHours(0, 0, 0, 0);
  } else if (range === "week") {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday as start of week
    now.setDate(now.getDate() - diff);
    now.setHours(0, 0, 0, 0);
  } else if (range === "month") {
    now.setDate(1);
    now.setHours(0, 0, 0, 0);
  }
  return now.toISOString();
}

const dateRangeLabels: Record<DateRange, string> = {
  today: "Today",
  week: "This Week",
  month: "This Month",
  all: "All Time",
};

function formatModelName(model: string): string {
  // e.g. "claude-haiku-4-5-20251001" → "Haiku 4.5", "claude-sonnet-4-5-20250514" → "Sonnet 4.5"
  const match = model.match(/claude-(\w+)-(\d+)-(\d+)/);
  if (match) {
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    return `${name} ${match[2]}.${match[3]}`;
  }
  return model;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatElapsed(startedAt: number, endedAt?: number): string {
  const end = endedAt ?? Date.now();
  const seconds = Math.floor((end - startedAt) / 1000);
  if (seconds <= 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatDuration(ms?: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

export function StatusDashboard({ apiUrl, apiKey }: { apiUrl: string; apiKey?: string }) {
  const [tab, setTab] = useState<Tab>("sessions");
  const [dateRange, setDateRange] = useState<DateRange>("week");
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [fetchLogs, setFetchLogs] = useState<FetchLogEntry[]>([]);
  const [usage, setUsage] = useState<UsageEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [sessionLogs, setSessionLogs] = useState<Record<string, string[]>>({});
  const [sessionStdout, setSessionStdout] = useState<Record<string, string[]>>({});
  const [allSources, setAllSources] = useState<SourceEntry[]>([]);
  const [sessionPage, setSessionPage] = useState(0);
  const [fetchLogPage, setFetchLogPage] = useState(0);
  const pageSize = 25;
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnectDelay = useRef(1000);
  const intentionalClose = useRef(false);

  // Track tab visibility
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // Hydrate state via HTTP — on mount, tab regain, and date range change
  const after = getDateRangeAfter(dateRange);

  const hydrate = useCallback(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const safeFetch = (url: string) => fetch(url, { headers }).then((r) => r.ok ? r.json() : null);
    const fetchLogUrl = after
      ? `${apiUrl}/v1/status/fetch-log?after=${encodeURIComponent(after)}`
      : `${apiUrl}/v1/status/fetch-log`;
    return Promise.all([
      safeFetch(`${apiUrl}/v1/sessions`),
      safeFetch(fetchLogUrl),
      safeFetch(`${apiUrl}/v1/status/usage`),
    ]).then(([s, f, u]) => {
      if (s) setSessions(s as SessionState[]);
      if (f) setFetchLogs(f as FetchLogEntry[]);
      if (u) setUsage(u as UsageEntry[]);
      return s as SessionState[] | null;
    }).catch(() => null);
  }, [apiUrl, after, apiKey]);

  useEffect(() => { hydrate(); }, [hydrate]);

  // Fetch sources once on mount (not tied to date range — requires auth)
  useEffect(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    fetch(`${apiUrl}/v1/sources`, { headers }).then((r) => r.ok ? r.json() : null)
      .then((src) => { if (src) setAllSources(src as SourceEntry[]); })
      .catch(() => {});
  }, [apiUrl, apiKey]);

  // Handle incoming WebSocket messages
  const handleMessage = useCallback((event: MessageEvent) => {
    const msg = JSON.parse(event.data) as StatusMessage;

    if (msg.type === "init") {
      setSessions(msg.sessions as SessionState[]);
      return;
    }

    if (msg.type === "session:start") {
      setSessions((prev) => [{
        sessionId: msg.sessionId as string,
        company: msg.company as string,
        agent: msg.agent as SessionState["agent"],
        status: "running",
        startedAt: Date.now(),
      }, ...prev]);
    } else if (msg.type === "session:progress") {
      const sid = msg.sessionId as string;
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === sid
            ? {
                ...s,
                step: msg.step as string,
                sourcesFound: msg.sourcesFound as number,
                sourcesValidated: msg.sourcesValidated as number,
                currentAction: msg.currentAction as string,
                totalSources: msg.totalSources as number | undefined,
                sourcesFetched: msg.sourcesFetched as number | undefined,
                releasesFound: msg.releasesFound as number | undefined,
                releasesInserted: msg.releasesInserted as number | undefined,
              }
            : s
        )
      );
      if (msg.logLine || msg.currentAction) {
        const line = (msg.logLine ?? msg.currentAction) as string;
        const timestamp = new Date((msg.timestamp as number) || Date.now()).toISOString().slice(11, 19);
        setSessionLogs((prev) => {
          const existing = prev[sid] ?? [];
          const updated = [...existing, `${timestamp}  ${line}`];
          return { ...prev, [sid]: updated.length > 500 ? updated.slice(-500) : updated };
        });
      }
    } else if (msg.type === "session:complete") {
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === (msg.sessionId as string) ? { ...s, status: "complete" } : s
        )
      );
    } else if (msg.type === "session:error") {
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === (msg.sessionId as string) ? { ...s, status: "error", error: msg.error as string } : s
        )
      );
    } else if (msg.type === "session:stdout") {
      const sid = msg.sessionId as string;
      const stream = msg.stream === "stderr" ? "ERR" : "OUT";
      const timestamp = new Date((msg.timestamp as number) || Date.now()).toISOString().slice(11, 19);
      const line = `${timestamp} [${stream}] ${msg.line}`;
      setSessionStdout((prev) => {
        const existing = prev[sid] ?? [];
        const updated = [...existing, line];
        return { ...prev, [sid]: updated.length > 1000 ? updated.slice(-1000) : updated };
      });
    } else if (msg.type === "session:dismissed") {
      setSessions((prev) => prev.filter((s) => s.sessionId !== (msg.sessionId as string)));
    } else if (msg.type === "fetch:complete") {
      setFetchLogs((prev) => [{
        id: msg.id as string,
        sourceId: msg.sourceId as string,
        sessionId: msg.sessionId as string | undefined,
        sourceName: msg.sourceName as string | undefined,
        sourceSlug: msg.sourceSlug as string | undefined,
        releasesFound: msg.releasesFound as number,
        releasesInserted: msg.releasesInserted as number,
        durationMs: msg.durationMs as number | undefined,
        status: msg.status as FetchLogEntry["status"],
        error: msg.error as string | undefined,
        createdAt: msg.createdAt as string,
      }, ...prev]);
    }
  }, []);

  // Connect WebSocket only when tab is visible AND there are running sessions
  const hasRunningSessions = sessions.some((s) => s.status === "running");
  const needsWebSocket = visible && hasRunningSessions;

  useEffect(() => {
    if (!needsWebSocket) {
      // Tear down WebSocket when tab is hidden or nothing is running
      if (wsRef.current) {
        intentionalClose.current = true;
        wsRef.current.close();
        wsRef.current = null;
        setConnected(false);
      }
      clearTimeout(reconnectTimer.current);
      return;
    }

    function connect() {
      intentionalClose.current = false;
      const wsUrl = apiUrl.replace(/^http/, "ws") + "/v1/status/ws";
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectDelay.current = 1000;
      };

      ws.onmessage = handleMessage;

      ws.onclose = () => {
        setConnected(false);
        if (intentionalClose.current) return;
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
          connect();
        }, reconnectDelay.current);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      intentionalClose.current = true;
      wsRef.current?.close();
      wsRef.current = null;
      clearTimeout(reconnectTimer.current);
    };
  }, [needsWebSocket, apiUrl, handleMessage]);

  // Re-hydrate via HTTP when tab becomes visible again
  useEffect(() => {
    if (visible) { hydrate(); }
  }, [visible, hydrate]);

  // Update elapsed times every second — only when visible and sessions are running
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunningSessions || !visible) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [hasRunningSessions, visible]);

  // Fetch persisted logs and stdout once when expanding a session
  const fetchedLogsRef = useRef<Set<string>>(new Set());
  const fetchLogsForSession = useCallback((sid: string) => {
    if (fetchedLogsRef.current.has(sid)) return;
    fetchedLogsRef.current.add(sid);
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    fetch(`${apiUrl}/v1/sessions/${sid}/logs`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .then((logs: string[] | null) => {
        if (logs?.length) {
          setSessionLogs((prev) => ({ ...prev, [sid]: logs }));
        }
      })
      .catch(() => {});
    fetch(`${apiUrl}/v1/sessions/${sid}/stdout`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .then((lines: string[] | null) => {
        if (lines?.length) {
          setSessionStdout((prev) => ({ ...prev, [sid]: lines }));
        }
      })
      .catch(() => {});
  }, [apiUrl, apiKey]);

  // Filter sessions client-side by date range (sessions come from DO, not SQL)
  const afterMs = after ? new Date(after).getTime() : 0;
  const filteredSessions = after
    ? sessions.filter((s) => s.startedAt >= afterMs)
    : sessions;

  const runningCount = sessions.filter((s) => s.status === "running").length;
  const totalInput = usage.reduce((sum, u) => sum + u.totalInput, 0);
  const totalOutput = usage.reduce((sum, u) => sum + u.totalOutput, 0);

  return (
    <div>
      {/* Connection status */}
      <div className="flex items-center gap-2 mb-4">
        <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : hasRunningSessions ? "bg-red-400" : "bg-stone-300 dark:bg-stone-600"}`} />
        <span className="text-xs text-stone-400 dark:text-stone-500">
          {connected ? "Live" : hasRunningSessions ? "Reconnecting..." : "Idle"}
        </span>
      </div>

      {/* Usage stats bar */}
      {(totalInput > 0 || totalOutput > 0) && (
        <div className="text-xs text-stone-400 dark:text-stone-500 mb-4 px-3 py-2 bg-stone-100 dark:bg-stone-800 rounded-md">
          Today: {formatTokens(totalInput)} input / {formatTokens(totalOutput)} output
          {usage.length > 1 && (
            <span className="ml-3 text-stone-400">
              {usage.map((u) => `${formatModelName(u.model)}: ${formatTokens(u.totalInput + u.totalOutput)}`).join(" · ")}
            </span>
          )}
        </div>
      )}

      {/* Date range + Tabs */}
      <div className="flex items-center justify-between border-b border-stone-200 dark:border-stone-800 mb-4">
        <div className="flex gap-1">
          <button
            onClick={() => setTab("sessions")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === "sessions"
                ? "border-stone-900 dark:border-stone-100 text-stone-900 dark:text-stone-100"
                : "border-transparent text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
            }`}
          >
            Sessions{runningCount > 0 && ` (${runningCount})`}
          </button>
          <button
            onClick={() => setTab("fetch-log")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === "fetch-log"
                ? "border-stone-900 dark:border-stone-100 text-stone-900 dark:text-stone-100"
                : "border-transparent text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
            }`}
          >
            Fetch Log
          </button>
          <button
            onClick={() => setTab("sources")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === "sources"
                ? "border-stone-900 dark:border-stone-100 text-stone-900 dark:text-stone-100"
                : "border-transparent text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
            }`}
          >
            Sources
          </button>
        </div>
        <div className="flex gap-1 mb-px">
          {(Object.keys(dateRangeLabels) as DateRange[]).map((range) => (
            <button
              key={range}
              onClick={() => { setDateRange(range); setSessionPage(0); setFetchLogPage(0); }}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                dateRange === range
                  ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                  : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
              }`}
            >
              {dateRangeLabels[range]}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === "sessions" && (
        <SessionsTable
          sessions={filteredSessions}
          expandedSessions={expandedSessions}
          sessionLogs={sessionLogs}
          sessionStdout={sessionStdout}
          apiUrl={apiUrl}
          page={sessionPage}
          perPage={pageSize}
          onPageChange={setSessionPage}
          onToggle={(id) => {
            fetchLogsForSession(id);
            setExpandedSessions((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          onDismiss={(id) => setSessions((prev) => prev.filter((s) => s.sessionId !== id))}
        />
      )}
      {tab === "fetch-log" && <FetchLogTable logs={fetchLogs} page={fetchLogPage} perPage={pageSize} onPageChange={setFetchLogPage} />}
      {tab === "sources" && <SourcesTable sources={allSources} apiUrl={apiUrl} apiKey={apiKey} />}
    </div>
  );
}

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit",
  hour12: false, timeZoneName: "short",
});

function formatTime(ts: number): string {
  const parts = timeFormatter.formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

function SessionsTable({
  sessions,
  expandedSessions,
  sessionLogs,
  sessionStdout,
  apiUrl,
  page,
  perPage,
  onPageChange,
  onToggle,
  onDismiss,
}: {
  sessions: SessionState[];
  expandedSessions: Set<string>;
  sessionLogs: Record<string, string[]>;
  sessionStdout: Record<string, string[]>;
  apiUrl: string;
  page: number;
  perPage: number;
  onPageChange: (page: number) => void;
  onToggle: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">No sessions yet.</div>;
  }

  const totalPages = Math.ceil(sessions.length / perPage);
  const paginated = sessions.slice(page * perPage, (page + 1) * perPage);

  return (
    <div>
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Company</div>
          <div>Started</div>
          <div>Step</div>
          <div>Result</div>
          <div className="text-right">Elapsed</div>
        </div>
        {paginated.map((session) => {
          const isUpdate = session.type === "update";
          const isExpanded = expandedSessions.has(session.sessionId);
          return (<div key={session.sessionId}>
            <button
              onClick={() => onToggle(session.sessionId)}
              className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2.5 w-full text-left text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
            >
              <div className="text-stone-900 dark:text-stone-100">
                <span className="mr-1.5 text-stone-300 dark:text-stone-600">{isExpanded ? "▾" : "▸"}</span>
                {session.company}
                {session.agent && <AgentBadge agent={session.agent} />}
              </div>
              <div className="text-stone-500 dark:text-stone-400">
                {formatTime(session.startedAt)}
              </div>
              <div>
                <StepBadge step={session.step} status={session.status} type={session.type} />
              </div>
              <div className="text-stone-500">
                {session.status === "error" ? (
                  <span className="text-red-500">{session.error?.slice(0, 40)}</span>
                ) : session.status === "complete" ? (
                  isUpdate ? (
                    <span className="text-green-600">
                      {(session.sourcesFetched ?? 0) > 0 && <span>{session.sourcesFetched} src</span>}
                      {(session.releasesInserted ?? 0) > 0 && <span className="ml-1.5 text-green-700">+{session.releasesInserted}</span>}
                      {(session.sourcesFetched ?? 0) === 0 && (session.releasesInserted ?? 0) === 0 && <span>no changes</span>}
                    </span>
                  ) : (
                    <span className="text-green-600">+{session.sourcesFound ?? 0} sources</span>
                  )
                ) : (
                  isUpdate ? (
                    <span>
                      {session.sourcesFetched ?? 0}/{session.totalSources ?? "?"} src
                      {(session.releasesInserted ?? 0) > 0 && <span className="ml-1.5 text-green-600">+{session.releasesInserted}</span>}
                    </span>
                  ) : (
                    <span>
                      {session.sourcesFound ?? 0} found, {session.sourcesValidated ?? 0} validated
                    </span>
                  )
                )}
              </div>
              <div className="text-stone-400 dark:text-stone-500 text-right flex items-center justify-end gap-2">
                <span>
                  {formatElapsed(session.startedAt, session.status !== "running" ? session.lastUpdatedAt : undefined)}
                  <SessionTokens usage={session.usage} />
                </span>
                {session.status !== "running" && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="text-stone-300 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 transition-colors"
                    title="Dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      fetch(`${apiUrl}/v1/sessions/${session.sessionId}`, { method: "DELETE" });
                      onDismiss(session.sessionId);
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); fetch(`${apiUrl}/v1/sessions/${session.sessionId}`, { method: "DELETE" }); onDismiss(session.sessionId); } }}
                  >
                    &times;
                  </span>
                )}
              </div>
            </button>
            {isExpanded && (
              <SessionLogPanel sessionId={session.sessionId} logs={sessionLogs[session.sessionId] ?? []} stdout={sessionStdout[session.sessionId] ?? []} currentAction={session.currentAction} status={session.status} />
            )}
          </div>);
        })}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-stone-400 dark:text-stone-500">
          <span>{sessions.length} sessions</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page === 0}
              className="px-2 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default"
            >
              Prev
            </button>
            <span>{page + 1} / {totalPages}</span>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepBadge({ step, status, type }: { step?: string; status: string; type?: string }) {
  if (status === "complete") return <span className="text-green-600">Complete</span>;
  if (status === "error") return <span className="text-red-500">Error</span>;
  if (!step) return <span className="text-stone-400">Starting...</span>;

  if (type === "update") {
    const color = step === "fetching" ? "text-blue-500" : "text-stone-500";
    return <span className={`capitalize ${color}`}>{step}</span>;
  }

  const stepColors: Record<string, string> = {
    discovering: "text-amber-500",
    adding: "text-blue-500",
    validating: "text-green-500",
  };
  const color = stepColors[step] ?? "text-stone-500";
  return <span className={`capitalize ${color}`}>{step}</span>;
}

const agentStyles: Record<string, { bg: string; label: string }> = {
  haiku: { bg: "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400", label: "Haiku" },
  sonnet: { bg: "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400", label: "Sonnet" },
};

function AgentBadge({ agent }: { agent: string }): ReactNode {
  const style = agentStyles[agent];
  if (!style) return null;
  return (
    <span className={`ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded-full ${style.bg}`}>
      {style.label}
    </span>
  );
}

function SessionTokens({ usage }: { usage?: SessionState["usage"] }): ReactNode {
  if (!usage) return null;
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (total === 0) return null;
  return (
    <span className="block text-[10px] text-stone-300 dark:text-stone-600">
      {formatTokens(total)} tok
    </span>
  );
}

type LogMode = "structured" | "raw";

function SessionLogPanel({ sessionId, logs, stdout, currentAction, status }: { sessionId: string; logs: string[]; stdout: string[]; currentAction?: string; status: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<LogMode>("structured");

  const lines = mode === "structured" ? logs : stdout;

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [lines.length]);

  return (
    <div className="border-b border-stone-200 dark:border-stone-800">
      {/* Mode toggle */}
      <div className="bg-stone-800 px-4 py-1.5 flex items-center gap-2 border-b border-stone-700">
        <button
          onClick={() => setMode("structured")}
          className={`px-2 py-0.5 text-xs rounded transition-colors ${
            mode === "structured"
              ? "bg-stone-600 text-stone-100"
              : "text-stone-400 hover:text-stone-300"
          }`}
        >
          Structured
        </button>
        <button
          onClick={() => setMode("raw")}
          className={`px-2 py-0.5 text-xs rounded transition-colors ${
            mode === "raw"
              ? "bg-stone-600 text-stone-100"
              : "text-stone-400 hover:text-stone-300"
          }`}
        >
          Raw
        </button>
      </div>
      <div ref={containerRef} className="bg-stone-900 text-stone-300 px-4 py-3 max-h-64 overflow-y-auto font-mono text-xs leading-relaxed">
        {lines.length === 0 && mode === "structured" && currentAction && (
          <div className="text-stone-500">{currentAction}</div>
        )}
        {lines.length === 0 && !(mode === "structured" && currentAction) && (
          <div className="text-stone-600">
            {status === "running"
              ? mode === "raw" ? "Waiting for stdout..." : "Waiting for log output..."
              : mode === "raw" ? "No stdout captured for this session." : "No logs recorded for this session."}
          </div>
        )}
        {lines.map((line, i) => (
          <div key={`${sessionId}-${mode}-${i}`} className={mode === "raw" && line.includes("[ERR]") ? "text-red-400" : undefined}>
            {line}
          </div>
        ))}
        {status === "running" && <div className="text-green-400 mt-1">▊</div>}
      </div>
    </div>
  );
}

type FetchStatusFilter = FetchLogEntry["status"] | "all";

function FetchLogTable({ logs, page, perPage, onPageChange }: { logs: FetchLogEntry[]; page: number; perPage: number; onPageChange: (p: number) => void }) {
  const [filter, setFilter] = useState<FetchStatusFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const filtered = filter === "all" ? logs : logs.filter((l) => l.status === filter);

  if (logs.length === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">No fetch log entries yet.</div>;
  }

  const totalPages = Math.ceil(filtered.length / perPage);
  const paginated = filtered.slice(page * perPage, (page + 1) * perPage);

  const filterButtons: { value: FetchStatusFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "success", label: "Success" },
    { value: "error", label: "Errors" },
    { value: "no_change", label: "No change" },
    { value: "dry_run", label: "Dry runs" },
  ];

  return (
    <div>
      {/* Status filter */}
      <div className="flex gap-1 mb-3">
        {filterButtons.map((f) => {
          const count = f.value === "all" ? logs.length : logs.filter((l) => l.status === f.value).length;
          if (count === 0 && f.value !== "all") return null;
          return (
            <button
              key={f.value}
              onClick={() => { setFilter(f.value); onPageChange(0); }}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                filter === f.value
                  ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                  : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
              }`}
            >
              {f.label} <span className="ml-0.5 opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Source</div>
          <div>Time</div>
          <div>Status</div>
          <div>Result</div>
          <div className="text-right">Duration</div>
        </div>
        {paginated.map((log) => {
          const isExpanded = expandedIds.has(log.id);
          return (
            <div key={log.id}>
              <button
                onClick={() => setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(log.id)) next.delete(log.id);
                  else next.add(log.id);
                  return next;
                })}
                className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2.5 w-full text-left text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
              >
                <div className="flex items-start gap-1.5">
                  <span className="text-stone-300 dark:text-stone-600 shrink-0">{isExpanded ? "▾" : "▸"}</span>
                  <div>
                    <div className="text-stone-900 dark:text-stone-100">
                      {log.sourceSlug ? (
                        <a href={`/source/${log.sourceSlug}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {log.sourceName ?? log.sourceSlug}
                        </a>
                      ) : (
                        <span className="text-stone-500">{log.sourceName ?? log.sourceId}</span>
                      )}
                    </div>
                    {log.orgName && (
                      <div className="text-stone-400">{log.orgName}</div>
                    )}
                    {log.sessionId && (
                      <span className="text-[10px] font-sans text-indigo-400 dark:text-indigo-500">agent</span>
                    )}
                  </div>
                </div>
                <div className="text-stone-500">
                  {formatTime(new Date(log.createdAt).getTime())}
                </div>
                <div>
                  <FetchStatusBadge status={log.status} />
                </div>
                <div className="text-stone-500">
                  {log.status === "no_change" ? (
                    <span className="text-stone-400">no changes</span>
                  ) : log.status === "error" ? (
                    <span className="text-red-500">{log.error?.slice(0, 40) ?? "failed"}</span>
                  ) : (
                    <span>
                      {log.releasesFound > 0 && <span>{log.releasesFound} found</span>}
                      {log.releasesInserted > 0 && <span className="ml-1.5 text-green-600">+{log.releasesInserted}</span>}
                      {log.releasesFound === 0 && log.releasesInserted === 0 && <span className="text-stone-400">—</span>}
                    </span>
                  )}
                </div>
                <div className="text-stone-400 text-right">{formatDuration(log.durationMs)}</div>
              </button>
              {isExpanded && <FetchLogDetail log={log} />}
            </div>
          );
        })}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-stone-400 dark:text-stone-500">
          <span>{filtered.length} entries</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page === 0}
              className="px-2 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default"
            >
              Prev
            </button>
            <span>{page + 1} / {totalPages}</span>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FetchLogDetail({ log }: { log: FetchLogEntry }) {
  return (
    <div className="bg-stone-900 text-stone-300 px-4 py-3 max-h-64 overflow-y-auto font-mono text-xs leading-relaxed border-b border-stone-200 dark:border-stone-800">
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 mb-2">
        <div><span className="text-stone-500">Source ID:</span> {log.sourceId}</div>
        <div><span className="text-stone-500">Duration:</span> {formatDuration(log.durationMs)}</div>
        <div><span className="text-stone-500">Releases found:</span> {log.releasesFound}</div>
        <div><span className="text-stone-500">Releases inserted:</span> {log.releasesInserted}</div>
        {log.orgName && <div><span className="text-stone-500">Organization:</span> {log.orgName}</div>}
      </div>
      {log.error && (
        <div className="mt-2">
          <div className="text-stone-500 mb-1">Error:</div>
          <div className="text-red-400 whitespace-pre-wrap">{log.error}</div>
        </div>
      )}
      {log.rawContent && (
        <div className="mt-2">
          <div className="text-stone-500 mb-1">Raw content preview:</div>
          <div className="max-h-48 overflow-y-auto text-stone-400 whitespace-pre-wrap">{log.rawContent.slice(0, 2000)}{log.rawContent.length > 2000 ? "\n..." : ""}</div>
        </div>
      )}
      {!log.error && !log.rawContent && (
        <div className="text-stone-600">No additional details available.</div>
      )}
    </div>
  );
}

function FetchStatusBadge({ status }: { status: FetchLogEntry["status"] }) {
  const styles: Record<string, string> = {
    success: "text-green-600",
    error: "text-red-500",
    no_change: "text-stone-400",
    dry_run: "text-blue-500",
  };
  const labels: Record<string, string> = {
    success: "Success",
    error: "Error",
    no_change: "No change",
    dry_run: "Dry run",
  };
  return <span className={`${styles[status] ?? "text-stone-400"}`}>{labels[status] ?? status}</span>;
}

type SourceTypeFilter = "all" | "feed" | "github" | "scrape" | "agent";

function SourcesTable({ sources, apiUrl, apiKey }: { sources: SourceEntry[]; apiUrl: string; apiKey?: string }) {
  const [filter, setFilter] = useState<SourceTypeFilter>("all");
  const [query, setQuery] = useState("");
  const [fetching, setFetching] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, FetchTriggerResult>>({});
  const [page, setPage] = useState(0);
  const perPage = 25;

  // Pre-compute counts by type (single pass) for filter badges
  const countByType = sources.reduce<Record<string, number>>((acc, s) => {
    acc[s.type] = (acc[s.type] ?? 0) + 1;
    return acc;
  }, {});

  const filtered = sources.filter((s) => {
    if (filter !== "all" && s.type !== filter) return false;
    if (query) {
      const q = query.toLowerCase();
      return (s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q) || (s.orgSlug ?? "").toLowerCase().includes(q));
    }
    return true;
  });

  const totalPages = Math.ceil(filtered.length / perPage);
  const paginated = filtered.slice(page * perPage, (page + 1) * perPage);

  const triggerFetch = async (slug: string) => {
    setFetching((prev) => new Set(prev).add(slug));
    setResults((prev) => { const next = { ...prev }; delete next[slug]; return next; });
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${apiUrl}/v1/sources/${slug}/fetch`, { method: "POST", headers });
      const data: FetchTriggerResult = await res.json();
      setResults((prev) => ({ ...prev, [slug]: data }));
    } catch {
      setResults((prev) => ({ ...prev, [slug]: { error: "Request failed" } }));
    } finally {
      setFetching((prev) => { const next = new Set(prev); next.delete(slug); return next; });
    }
  };

  const filterButtons: { value: SourceTypeFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "feed", label: "Feed" },
    { value: "github", label: "GitHub" },
    { value: "scrape", label: "Scrape" },
    { value: "agent", label: "Agent" },
  ];

  if (sources.length === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">No sources loaded.</div>;
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex gap-1">
          {filterButtons.map((f) => {
            const count = f.value === "all" ? sources.length : (countByType[f.value] ?? 0);
            if (count === 0 && f.value !== "all") return null;
            return (
              <button
                key={f.value}
                onClick={() => { setFilter(f.value); setPage(0); }}
                className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                  filter === f.value
                    ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                    : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
                }`}
              >
                {f.label} <span className="ml-0.5 opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
        <input
          type="text"
          placeholder="Filter sources..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }}
          className="px-2.5 py-1 text-xs rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 placeholder:text-stone-400 w-48"
        />
      </div>

      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_auto] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Name</div>
          <div>Org</div>
          <div>Type</div>
          <div>Last Fetched</div>
          <div>Priority</div>
          <div></div>
        </div>
        {paginated.map((src) => {
          const result = results[src.slug];
          const isFetching = fetching.has(src.slug);
          return (
            <div key={src.id} className="grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_auto] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors items-center">
              <div className="text-stone-900 dark:text-stone-100 truncate" title={src.slug}>
                {src.name}
              </div>
              <div className="text-stone-500 truncate">{src.orgSlug ?? "—"}</div>
              <div>
                <SourceTypeBadge type={src.type} />
              </div>
              <div className="text-stone-500">
                {src.lastFetchedAt ? formatTime(new Date(src.lastFetchedAt).getTime()) : <span className="text-stone-400">never</span>}
              </div>
              <div className="text-stone-500 capitalize">{src.fetchPriority ?? "normal"}</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => triggerFetch(src.slug)}
                  disabled={isFetching}
                  className="px-2.5 py-1 text-xs rounded border border-stone-300 dark:border-stone-600 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 disabled:opacity-40 disabled:cursor-default transition-colors"
                >
                  {isFetching ? "Fetching..." : "Fetch"}
                </button>
                {result ? (
                  <span className="text-xs">
                    {result.error ? (
                      <span className="text-red-500">{result.error.slice(0, 30)}</span>
                    ) : result.fetched ? (
                      <span className="text-green-600">+{result.releasesInserted ?? 0} ({formatDuration(result.durationMs)})</span>
                    ) : result.queued ? (
                      <span className="text-amber-500">Queued</span>
                    ) : null}
                  </span>
                ) : src.changeDetectedAt && (src.type === "scrape" || src.type === "agent") ? (
                  <span className="text-xs text-amber-500">Pending fetch</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-stone-400 dark:text-stone-500">
          <span>{filtered.length} sources</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(page - 1)}
              disabled={page === 0}
              className="px-2 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default"
            >
              Prev
            </button>
            <span>{page + 1} / {totalPages}</span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceTypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    feed: "text-blue-500",
    github: "text-purple-500",
    scrape: "text-amber-500",
    agent: "text-green-500",
  };
  return <span className={`capitalize ${styles[type] ?? "text-stone-400"}`}>{type}</span>;
}
