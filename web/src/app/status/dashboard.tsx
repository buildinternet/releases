"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface SessionState {
  sessionId: string;
  company: string;
  status: "running" | "complete" | "error";
  step?: string;
  sourcesFound?: number;
  sourcesValidated?: number;
  currentAction?: string;
  startedAt: number;
  error?: string;
}

interface FetchLogEntry {
  id: string;
  sourceId: string;
  sourceName?: string;
  sourceSlug?: string;
  releasesFound: number;
  releasesInserted: number;
  durationMs?: number;
  status: "success" | "error" | "no_change" | "dry_run";
  error?: string;
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

type Tab = "sessions" | "fetch-log";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatDuration(ms?: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StatusDashboard({ apiUrl }: { apiUrl: string }) {
  const [tab, setTab] = useState<Tab>("sessions");
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [fetchLogs, setFetchLogs] = useState<FetchLogEntry[]>([]);
  const [usage, setUsage] = useState<UsageEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionLogs, setSessionLogs] = useState<Record<string, string[]>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnectDelay = useRef(1000);

  // Hydrate initial state via HTTP
  useEffect(() => {
    const base = apiUrl;
    const safeFetch = (url: string) => fetch(url).then((r) => r.ok ? r.json() : null);
    Promise.all([
      safeFetch(`${base}/api/status/sessions`),
      safeFetch(`${base}/api/status/fetch-log?limit=50`),
      safeFetch(`${base}/api/status/usage`),
    ]).then(([s, f, u]) => {
      if (s) setSessions(s as SessionState[]);
      if (f) setFetchLogs(f as FetchLogEntry[]);
      if (u) setUsage(u as UsageEntry[]);
    }).catch(() => {
      // API unavailable — will retry on WS connect
    });
  }, [apiUrl]);

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
        status: "running",
        startedAt: Date.now(),
      }, ...prev]);
    } else if (msg.type === "session:progress") {
      const sid = msg.sessionId as string;
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === sid
            ? { ...s, step: msg.step as string, sourcesFound: msg.sourcesFound as number, sourcesValidated: msg.sourcesValidated as number, currentAction: msg.currentAction as string }
            : s
        )
      );
      if (msg.logLine || msg.currentAction) {
        const line = (msg.logLine ?? msg.currentAction) as string;
        const timestamp = new Date((msg.timestamp as number) || Date.now()).toLocaleTimeString("en-US", { hour12: false });
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
    } else if (msg.type === "fetch:complete") {
      setFetchLogs((prev) => [{
        id: msg.id as string,
        sourceId: msg.sourceId as string,
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

  // WebSocket connection with auto-reconnect
  useEffect(() => {
    function connect() {
      const wsUrl = apiUrl.replace(/^http/, "ws") + "/api/status/ws";
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectDelay.current = 1000;
      };

      ws.onmessage = handleMessage;

      ws.onclose = () => {
        setConnected(false);
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
          connect();
        }, reconnectDelay.current);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      wsRef.current?.close();
      clearTimeout(reconnectTimer.current);
    };
  }, [apiUrl, handleMessage]);

  // Update elapsed times every second while sessions are running
  const hasRunningSessions = sessions.some((s) => s.status === "running");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunningSessions) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [hasRunningSessions]);

  const runningCount = sessions.filter((s) => s.status === "running").length;
  const totalInput = usage.reduce((sum, u) => sum + u.totalInput, 0);
  const totalOutput = usage.reduce((sum, u) => sum + u.totalOutput, 0);

  return (
    <div>
      {/* Connection status */}
      <div className="flex items-center gap-2 mb-4">
        <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-400"}`} />
        <span className="text-xs text-stone-400">{connected ? "Connected" : "Reconnecting..."}</span>
      </div>

      {/* Usage stats bar */}
      {(totalInput > 0 || totalOutput > 0) && (
        <div className="text-xs text-stone-400 mb-4 px-3 py-2 bg-stone-100 rounded-md">
          Today: {formatTokens(totalInput)} input / {formatTokens(totalOutput)} output
          {usage.length > 0 && (
            <span className="ml-3 text-stone-400">
              {usage.map((u) => `${u.model.split("-").slice(-1)[0]}: ${formatTokens(u.totalInput + u.totalOutput)}`).join(" · ")}
            </span>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-stone-200 mb-4">
        <button
          onClick={() => setTab("sessions")}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "sessions"
              ? "border-stone-900 text-stone-900"
              : "border-transparent text-stone-400 hover:text-stone-600"
          }`}
        >
          Sessions{runningCount > 0 && ` (${runningCount})`}
        </button>
        <button
          onClick={() => setTab("fetch-log")}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "fetch-log"
              ? "border-stone-900 text-stone-900"
              : "border-transparent text-stone-400 hover:text-stone-600"
          }`}
        >
          Fetch Log
        </button>
      </div>

      {/* Tab content */}
      {tab === "sessions" && (
        <SessionsTable
          sessions={sessions}
          expandedSession={expandedSession}
          sessionLogs={sessionLogs}
          onToggle={(id) => setExpandedSession(expandedSession === id ? null : id)}
        />
      )}
      {tab === "fetch-log" && <FetchLogTable logs={fetchLogs} />}
    </div>
  );
}

function SessionsTable({
  sessions,
  expandedSession,
  sessionLogs,
  onToggle,
}: {
  sessions: SessionState[];
  expandedSession: string | null;
  sessionLogs: Record<string, string[]>;
  onToggle: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return <div className="text-sm text-stone-400 py-8 text-center">No discovery sessions yet.</div>;
  }

  return (
    <div className="border border-stone-200 rounded-lg overflow-hidden">
      <div className="grid grid-cols-[2fr_1fr_1.5fr_1fr] px-4 py-2 border-b border-stone-100 text-xs font-medium uppercase tracking-wider text-stone-400">
        <div>Company</div>
        <div>Step</div>
        <div>State</div>
        <div className="text-right">Elapsed</div>
      </div>
      {sessions.map((session) => (
        <div key={session.sessionId} className={session.status !== "running" ? "opacity-50" : ""}>
          <button
            onClick={() => onToggle(session.sessionId)}
            className="grid grid-cols-[2fr_1fr_1.5fr_1fr] px-4 py-3 w-full text-left border-b border-stone-100 hover:bg-stone-50 transition-colors"
          >
            <div className="text-sm font-medium text-stone-900">
              <span className="mr-1.5 text-stone-300">{expandedSession === session.sessionId ? "▾" : "▸"}</span>
              {session.company}
            </div>
            <div className="text-sm">
              <StepBadge step={session.step} status={session.status} />
            </div>
            <div className="text-sm text-stone-500">
              {session.status === "error" ? (
                <span className="text-red-500">{session.error?.slice(0, 40)}</span>
              ) : session.status === "complete" ? (
                <span className="text-green-600">{session.sourcesFound ?? 0} sources added</span>
              ) : (
                <span>
                  {session.sourcesFound ?? 0} found, {session.sourcesValidated ?? 0} validated
                </span>
              )}
            </div>
            <div className="text-sm text-stone-400 text-right">{formatElapsed(session.startedAt)}</div>
          </button>
          {expandedSession === session.sessionId && (
            <SessionLogPanel sessionId={session.sessionId} logs={sessionLogs[session.sessionId] ?? []} currentAction={session.currentAction} status={session.status} />
          )}
        </div>
      ))}
    </div>
  );
}

function StepBadge({ step, status }: { step?: string; status: string }) {
  if (status === "complete") return <span className="text-green-600 text-xs">Complete</span>;
  if (status === "error") return <span className="text-red-500 text-xs">Error</span>;
  if (!step) return <span className="text-stone-400 text-xs">Starting...</span>;

  const color = step === "discovering" ? "text-amber-500" : step === "adding" ? "text-blue-500" : step === "validating" ? "text-green-500" : "text-stone-500";
  return <span className={`text-xs capitalize ${color}`}>{step}</span>;
}

function SessionLogPanel({ sessionId, logs, currentAction, status }: { sessionId: string; logs: string[]; currentAction?: string; status: string }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div className="bg-stone-900 text-stone-300 px-4 py-3 max-h-64 overflow-y-auto font-mono text-xs leading-relaxed border-b border-stone-200">
      {logs.length === 0 && currentAction && (
        <div className="text-stone-500">{currentAction}</div>
      )}
      {logs.length === 0 && !currentAction && (
        <div className="text-stone-600">Waiting for log output...</div>
      )}
      {logs.map((line, i) => (
        <div key={`${sessionId}-${i}`}>{line}</div>
      ))}
      {status === "running" && <div className="text-green-400 mt-1">▊</div>}
      <div ref={bottomRef} />
    </div>
  );
}

function FetchLogTable({ logs }: { logs: FetchLogEntry[] }) {
  if (logs.length === 0) {
    return <div className="text-sm text-stone-400 py-8 text-center">No fetch log entries yet.</div>;
  }

  return (
    <div className="border border-stone-200 rounded-lg overflow-hidden">
      <div className="grid grid-cols-[2fr_1fr_1.5fr_1fr_1.5fr] px-4 py-2 border-b border-stone-100 text-xs font-medium uppercase tracking-wider text-stone-400">
        <div>Source</div>
        <div>Status</div>
        <div>Releases</div>
        <div>Duration</div>
        <div className="text-right">Time</div>
      </div>
      {logs.map((log) => (
        <div
          key={log.id}
          className="grid grid-cols-[2fr_1fr_1.5fr_1fr_1.5fr] px-4 py-2.5 border-b border-stone-100 text-sm"
        >
          <div>
            {log.sourceSlug ? (
              <a href={`/source/${log.sourceSlug}`} className="text-stone-900 hover:underline">
                {log.sourceName ?? log.sourceSlug}
              </a>
            ) : (
              <span className="text-stone-500">{log.sourceName ?? log.sourceId}</span>
            )}
          </div>
          <div>
            <FetchStatusBadge status={log.status} />
          </div>
          <div className="text-stone-500">
            {log.releasesFound} found, {log.releasesInserted} inserted
          </div>
          <div className="text-stone-400">{formatDuration(log.durationMs)}</div>
          <div className="text-stone-400 text-right">
            {new Date(log.createdAt).toLocaleTimeString("en-US", { hour12: false })}
          </div>
        </div>
      ))}
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
  return <span className={`text-xs ${styles[status] ?? "text-stone-400"}`}>{labels[status] ?? status}</span>;
}
