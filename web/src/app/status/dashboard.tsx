"use client";

import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type FetchLogEntry,
  type FetchLogStatusFilter,
  formatFetchDuration,
} from "@/components/fetch-log-shared";
import { FetchLogList } from "@/components/fetch-log-list";
import { useFetchLog } from "@/components/use-fetch-log";
import { SortHeader, type SortState } from "@/components/sort-header";
import { DAY_MS } from "@/lib/cadence";
import { describeCadence } from "./cadence-helpers";
import { CronRunsTab } from "./cron-runs-tab";
import { SearchQueriesTab } from "./search-queries-tab";
import { ForceDrainTile } from "./force-drain-tile";

interface SessionState {
  sessionId: string;
  company: string;
  type?: "onboard" | "update";
  agent?: "sonnet" | "haiku";
  /** Identifies the client that started this session (e.g. hostname, "sandbox-prod"). */
  runner?: string;
  /** Correlation ID for end-to-end tracing across CLI → API → managed agent. */
  correlationId?: string;
  /** Anthropic session ID for linking to the Anthropic console logs. */
  anthropicSessionId?: string;
  status: "running" | "complete" | "error";
  warnings?: string[];
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
  medianGapDays?: number | null;
  lastRetieredAt?: string | null;
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

type Tab = "sessions" | "fetch-log" | "sources" | "orgs" | "cron" | "searches";
type DateRange = "today" | "week" | "month" | "all";

type SourceSortField =
  | "name"
  | "org"
  | "type"
  | "latest_date"
  | "last_fetched_at"
  | "fetch_priority"
  | "median_gap_days";
type FetchLogSortField = "createdAt" | "durationMs";

const TABS: { value: Tab; label: string }[] = [
  { value: "sessions", label: "Sessions" },
  { value: "fetch-log", label: "Fetch Log" },
  { value: "sources", label: "Sources" },
  { value: "orgs", label: "Orgs" },
  { value: "cron", label: "Cron" },
  { value: "searches", label: "Searches" },
];
const DEFAULT_TAB: Tab = "sessions";

function parseTab(value: string | null): Tab {
  return TABS.some((t) => t.value === value) ? (value as Tab) : DEFAULT_TAB;
}

// Matches the "low" retier band ceiling: sources shipping less than once a
// quarter get flagged. Sources with no releases count as stale too.
const STALE_THRESHOLD_DAYS = 90;

function ageInDays(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / DAY_MS);
}

function isSourceStale(src: SourceEntry, now: number = Date.now()): boolean {
  const age = ageInDays(src.latestDate, now);
  if (age == null) return true;
  return age > STALE_THRESHOLD_DAYS;
}

function formatAge(days: number | null): string {
  if (days == null) return "never";
  if (days < 1) return "<1d";
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

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

export function StatusDashboard({ apiUrl }: { apiUrl: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));
  const setTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === DEFAULT_TAB) params.delete("tab");
      else params.set("tab", next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  const [dateRange, setDateRange] = useState<DateRange>("week");
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [usage, setUsage] = useState<UsageEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [sessionLogs, setSessionLogs] = useState<Record<string, string[]>>({});
  const [sessionStdout, setSessionStdout] = useState<Record<string, string[]>>({});
  const [allSources, setAllSources] = useState<SourceEntry[]>([]);
  const [sourceSort, setSourceSort] = useState<SortState<SourceSortField>>({
    field: "name",
    dir: "asc",
  });
  const [fetchLogSort, setFetchLogSort] = useState<SortState<FetchLogSortField>>({
    field: "createdAt",
    dir: "desc",
  });
  const [sessionPage, setSessionPage] = useState(0);
  const pageSize = 25;
  const fetchLogPrependRef = useRef<((entry: FetchLogEntry) => void) | null>(null);
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
    const safeFetch = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : null));
    return Promise.all([safeFetch(`/api/proxy/sessions`), safeFetch(`/api/proxy/status/usage`)])
      .then(([s, u]) => {
        if (s) setSessions(s as SessionState[]);
        if (u) setUsage(u as UsageEntry[]);
        return s as SessionState[] | null;
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Fetch sources when sort changes (server-side sort triggers a refetch).
  // TODO: `limit=500` is a stopgap. Once the source count crosses the cap,
  // the Sources tab needs real server-side pagination (envelope=true) and
  // server-side type/stale/q filters so we stop shipping the whole table to
  // the client, and OrgsTable needs its own rollup endpoint instead of
  // aggregating sources in the browser.
  useEffect(() => {
    const params = new URLSearchParams({
      limit: "500",
      sort: sourceSort.field,
      dir: sourceSort.dir,
    });
    fetch(`/api/proxy/sources?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((src) => {
        if (src) setAllSources(src as SourceEntry[]);
      })
      .catch(() => {});
  }, [sourceSort]);

  // Handle incoming WebSocket messages
  const handleMessage = useCallback((event: MessageEvent) => {
    const msg = JSON.parse(event.data) as StatusMessage;

    if (msg.type === "init") {
      setSessions(msg.sessions as SessionState[]);
      return;
    }

    if (msg.type === "session:start") {
      setSessions((prev) => [
        {
          sessionId: msg.sessionId as string,
          company: msg.company as string,
          agent: msg.agent as SessionState["agent"],
          runner: msg.runner as string | undefined,
          correlationId: msg.correlationId as string | undefined,
          anthropicSessionId: msg.anthropicSessionId as string | undefined,
          status: "running",
          startedAt: Date.now(),
        },
        ...prev,
      ]);
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
                ...(msg.anthropicSessionId
                  ? { anthropicSessionId: msg.anthropicSessionId as string }
                  : {}),
              }
            : s,
        ),
      );
      if (msg.logLine || msg.currentAction) {
        const line = (msg.logLine ?? msg.currentAction) as string;
        const timestamp = new Date((msg.timestamp as number) || Date.now())
          .toISOString()
          .slice(11, 19);
        setSessionLogs((prev) => {
          const existing = prev[sid] ?? [];
          const updated = [...existing, `${timestamp}  ${line}`];
          return { ...prev, [sid]: updated.length > 500 ? updated.slice(-500) : updated };
        });
      }
    } else if (msg.type === "session:complete") {
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === (msg.sessionId as string) ? { ...s, status: "complete" } : s,
        ),
      );
    } else if (msg.type === "session:error") {
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === (msg.sessionId as string)
            ? { ...s, status: "error", error: msg.error as string }
            : s,
        ),
      );
    } else if (msg.type === "session:stdout") {
      const sid = msg.sessionId as string;
      const stream = msg.stream === "stderr" ? "ERR" : "OUT";
      const timestamp = new Date((msg.timestamp as number) || Date.now())
        .toISOString()
        .slice(11, 19);
      const line = `${timestamp} [${stream}] ${msg.line}`;
      setSessionStdout((prev) => {
        const existing = prev[sid] ?? [];
        const updated = [...existing, line];
        return { ...prev, [sid]: updated.length > 1000 ? updated.slice(-1000) : updated };
      });
    } else if (msg.type === "session:dismissed") {
      setSessions((prev) => prev.filter((s) => s.sessionId !== (msg.sessionId as string)));
    } else if (msg.type === "fetch:complete") {
      fetchLogPrependRef.current?.({
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
      });
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

      ws.addEventListener("open", () => {
        setConnected(true);
        reconnectDelay.current = 1000;
      });

      ws.addEventListener("message", handleMessage);

      ws.addEventListener("close", () => {
        setConnected(false);
        if (intentionalClose.current) return;
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
          connect();
        }, reconnectDelay.current);
      });

      ws.addEventListener("error", () => ws.close());
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
    if (visible) {
      hydrate();
    }
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
    fetch(`/api/proxy/sessions/${sid}/logs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((logs: string[] | null) => {
        if (logs?.length) {
          setSessionLogs((prev) => ({ ...prev, [sid]: logs }));
        }
      })
      .catch(() => {});
    fetch(`/api/proxy/sessions/${sid}/stdout`)
      .then((r) => (r.ok ? r.json() : null))
      .then((lines: string[] | null) => {
        if (lines?.length) {
          setSessionStdout((prev) => ({ ...prev, [sid]: lines }));
        }
      })
      .catch(() => {});
  }, []);

  // Filter sessions client-side by date range (sessions come from DO, not SQL)
  const afterMs = after ? new Date(after).getTime() : 0;
  const filteredSessions = after ? sessions.filter((s) => s.startedAt >= afterMs) : sessions;

  const runningCount = sessions.filter((s) => s.status === "running").length;
  const totalInput = usage.reduce((sum, u) => sum + u.totalInput, 0);
  const totalOutput = usage.reduce((sum, u) => sum + u.totalOutput, 0);

  return (
    <div>
      {/* Connection status */}
      <div className="flex items-center gap-2 mb-4">
        <div
          className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : hasRunningSessions ? "bg-red-400" : "bg-stone-300 dark:bg-stone-600"}`}
        />
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
              {usage
                .map(
                  (u) =>
                    `${formatModelName(u.model)}: ${formatTokens(u.totalInput + u.totalOutput)}`,
                )
                .join(" · ")}
            </span>
          )}
        </div>
      )}

      {/* Force-drain sweep summary (#518) */}
      <ForceDrainTile />

      {/* Date range + Tabs */}
      <div className="flex items-center justify-between border-b border-stone-200 dark:border-stone-800 mb-4">
        <div className="flex gap-1">
          {TABS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === value
                  ? "border-stone-900 dark:border-stone-100 text-stone-900 dark:text-stone-100"
                  : "border-transparent text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
              }`}
            >
              {label}
              {value === "sessions" && runningCount > 0 && ` (${runningCount})`}
            </button>
          ))}
        </div>
        <div className="flex gap-1 mb-px">
          {(Object.keys(dateRangeLabels) as DateRange[]).map((range) => (
            <button
              key={range}
              onClick={() => {
                setDateRange(range);
                setSessionPage(0);
              }}
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
      {tab === "fetch-log" && (
        <FetchLogTable
          after={after}
          prependRef={fetchLogPrependRef}
          sort={fetchLogSort}
          onSortChange={setFetchLogSort}
        />
      )}
      {tab === "sources" && (
        <SourcesTable sources={allSources} sort={sourceSort} onSortChange={setSourceSort} />
      )}
      {tab === "orgs" && <OrgsTable sources={allSources} />}
      {tab === "cron" && <CronRunsTab />}
      {tab === "searches" && <SearchQueriesTab />}
    </div>
  );
}

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
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
  page: number;
  perPage: number;
  onPageChange: (page: number) => void;
  onToggle: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        No sessions yet.
      </div>
    );
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
          return (
            <div key={session.sessionId}>
              <button
                onClick={() => onToggle(session.sessionId)}
                className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2.5 w-full text-left text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
              >
                <div className="text-stone-900 dark:text-stone-100">
                  <span className="mr-1.5 text-stone-300 dark:text-stone-600">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                  {session.company}
                  <AgentBadge agent={session.agent} runner={session.runner} />
                </div>
                <div className="text-stone-500 dark:text-stone-400">
                  {formatTime(session.startedAt)}
                </div>
                <div>
                  <StepBadge
                    step={session.step}
                    status={session.status}
                    type={session.type}
                    warnings={session.warnings}
                  />
                </div>
                <div className="text-stone-500">
                  {session.status === "error" ? (
                    <span className="text-red-500">{session.error?.slice(0, 40)}</span>
                  ) : session.status === "complete" ? (
                    isUpdate ? (
                      <span className="text-green-600">
                        {(session.sourcesFetched ?? 0) > 0 && (
                          <span>{session.sourcesFetched} src</span>
                        )}
                        {(session.releasesInserted ?? 0) > 0 && (
                          <span className="ml-1.5 text-green-700">+{session.releasesInserted}</span>
                        )}
                        {(session.sourcesFetched ?? 0) === 0 &&
                          (session.releasesInserted ?? 0) === 0 && <span>no changes</span>}
                      </span>
                    ) : (
                      <span className="text-green-600">+{session.sourcesFound ?? 0} sources</span>
                    )
                  ) : isUpdate ? (
                    <span>
                      {session.sourcesFetched ?? 0}/{session.totalSources ?? "?"} src
                      {(session.releasesInserted ?? 0) > 0 && (
                        <span className="ml-1.5 text-green-600">+{session.releasesInserted}</span>
                      )}
                    </span>
                  ) : (
                    <span>
                      {session.sourcesFound ?? 0} found, {session.sourcesValidated ?? 0} validated
                    </span>
                  )}
                </div>
                <div className="text-stone-400 dark:text-stone-500 text-right flex items-center justify-end gap-2">
                  <span>
                    {formatElapsed(
                      session.startedAt,
                      session.status !== "running" ? session.lastUpdatedAt : undefined,
                    )}
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
                        fetch(`/api/proxy/sessions/${session.sessionId}`, { method: "DELETE" });
                        onDismiss(session.sessionId);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          fetch(`/api/proxy/sessions/${session.sessionId}`, { method: "DELETE" });
                          onDismiss(session.sessionId);
                        }
                      }}
                    >
                      &times;
                    </span>
                  )}
                </div>
              </button>
              {isExpanded && (
                <SessionLogPanel
                  sessionId={session.sessionId}
                  correlationId={session.correlationId}
                  anthropicSessionId={session.anthropicSessionId}
                  logs={sessionLogs[session.sessionId] ?? []}
                  stdout={sessionStdout[session.sessionId] ?? []}
                  currentAction={session.currentAction}
                  status={session.status}
                />
              )}
            </div>
          );
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
            <span>
              {page + 1} / {totalPages}
            </span>
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

function StepBadge({
  step,
  status,
  type,
  warnings,
}: {
  step?: string;
  status: string;
  type?: string;
  warnings?: string[];
}) {
  if (status === "complete" && warnings && warnings.length > 0) {
    return (
      <span className="text-amber-500" title={warnings.join("\n")}>
        Complete <span className="text-xs">⚠ {warnings.length}</span>
      </span>
    );
  }
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
  haiku: {
    bg: "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400",
    label: "Haiku",
  },
  sonnet: {
    bg: "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400",
    label: "Sonnet",
  },
};

function AgentBadge({ agent, runner }: { agent?: string; runner?: string }): ReactNode {
  if (agent) {
    const style = agentStyles[agent];
    if (!style) return null;
    return (
      <span
        className={`ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded-full ${style.bg}`}
      >
        {style.label}
      </span>
    );
  }
  const label = runner || "CLI";
  return (
    <span className="ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400">
      {label}
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

function SessionLogPanel({
  sessionId,
  correlationId,
  anthropicSessionId,
  logs,
  stdout,
  currentAction,
  status,
}: {
  sessionId: string;
  correlationId?: string;
  anthropicSessionId?: string;
  logs: string[];
  stdout: string[];
  currentAction?: string;
  status: string;
}) {
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
            mode === "raw" ? "bg-stone-600 text-stone-100" : "text-stone-400 hover:text-stone-300"
          }`}
        >
          Raw
        </button>
        {(anthropicSessionId || correlationId) && (
          <span className="ml-auto flex items-center gap-3 text-[10px] text-stone-500 font-mono">
            {anthropicSessionId && (
              <span title={anthropicSessionId}>anthropic:{anthropicSessionId.slice(0, 16)}</span>
            )}
            {correlationId && <span title={correlationId}>cid:{correlationId.slice(0, 12)}</span>}
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        className="bg-stone-900 text-stone-300 px-4 py-3 max-h-64 overflow-y-auto font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 && mode === "structured" && currentAction && (
          <div className="text-stone-500">{currentAction}</div>
        )}
        {lines.length === 0 && !(mode === "structured" && currentAction) && (
          <div className="text-stone-600">
            {status === "running"
              ? mode === "raw"
                ? "Waiting for stdout..."
                : "Waiting for log output..."
              : mode === "raw"
                ? "No stdout captured for this session."
                : "No logs recorded for this session."}
          </div>
        )}
        {lines.map((line, i) => (
          <div
            key={`${sessionId}-${mode}-${i}`}
            className={mode === "raw" && line.includes("[ERR]") ? "text-red-400" : undefined}
          >
            {line}
          </div>
        ))}
        {status === "running" && <div className="text-green-400 mt-1">▊</div>}
      </div>
    </div>
  );
}

function FetchLogTable({
  after,
  prependRef,
  sort,
  onSortChange,
}: {
  after: string | null;
  prependRef: React.RefObject<((entry: FetchLogEntry) => void) | null>;
  sort: SortState<FetchLogSortField>;
  onSortChange: (next: SortState<FetchLogSortField>) => void;
}) {
  const [filter, setFilter] = useState<FetchLogStatusFilter>("all");
  const { entries, totalCount, statusCounts, hasMore, loading, error, loadMore, prepend } =
    useFetchLog({
      after,
      status: filter,
      sort: sort.field,
      dir: sort.dir,
    });

  useEffect(() => {
    prependRef.current = prepend;
    return () => {
      prependRef.current = null;
    };
  }, [prepend, prependRef]);

  if (loading && entries.length === 0) {
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        Loading fetch log…
      </div>
    );
  }
  if (error && entries.length === 0) {
    return (
      <div className="text-sm text-red-500 py-8 text-center">Failed to load fetch log: {error}</div>
    );
  }
  if (!loading && totalCount === 0) {
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        No fetch log entries yet.
      </div>
    );
  }

  return (
    <FetchLogList
      entries={entries}
      totalCount={totalCount}
      statusCounts={statusCounts}
      hasMore={hasMore}
      loading={loading}
      filter={filter}
      onFilterChange={setFilter}
      onLoadMore={loadMore}
      sort={sort}
      onSortChange={onSortChange}
      formatTime={(iso) => formatTime(new Date(iso).getTime())}
      showOrg
    />
  );
}

type SourceTypeFilter = "all" | "feed" | "github" | "scrape" | "agent";

function SourcesTable({
  sources,
  sort,
  onSortChange,
}: {
  sources: SourceEntry[];
  sort: SortState<SourceSortField>;
  onSortChange: (next: SortState<SourceSortField>) => void;
}) {
  const [filter, setFilter] = useState<SourceTypeFilter>("all");
  const [query, setQuery] = useState("");
  const [staleOnly, setStaleOnly] = useState(false);
  const [fetching, setFetching] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, FetchTriggerResult>>({});
  const [page, setPage] = useState(0);
  const perPage = 25;

  const handleSortChange = useCallback(
    (next: SortState<SourceSortField>) => {
      setPage(0);
      onSortChange(next);
    },
    [onSortChange],
  );

  const { countByType, staleCount } = useMemo(() => {
    const counts: Record<string, number> = {};
    let stale = 0;
    for (const s of sources) {
      counts[s.type] = (counts[s.type] ?? 0) + 1;
      if (isSourceStale(s)) stale++;
    }
    return { countByType: counts, staleCount: stale };
  }, [sources]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return sources.filter((s) => {
      if (filter !== "all" && s.type !== filter) return false;
      if (staleOnly && !isSourceStale(s)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        (s.orgSlug ?? "").toLowerCase().includes(q)
      );
    });
  }, [sources, filter, staleOnly, query]);

  const totalPages = Math.ceil(filtered.length / perPage);
  const paginated = filtered.slice(page * perPage, (page + 1) * perPage);

  const triggerFetch = async (slug: string) => {
    setFetching((prev) => new Set(prev).add(slug));
    setResults((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    try {
      const res = await fetch(`/api/proxy/sources/${slug}/fetch`, { method: "POST" });
      const data: FetchTriggerResult = await res.json();
      setResults((prev) => ({ ...prev, [slug]: data }));
    } catch {
      setResults((prev) => ({ ...prev, [slug]: { error: "Request failed" } }));
    } finally {
      setFetching((prev) => {
        const next = new Set(prev);
        next.delete(slug);
        return next;
      });
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
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        No sources loaded.
      </div>
    );
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
                onClick={() => {
                  setFilter(f.value);
                  setPage(0);
                }}
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
        <button
          onClick={() => {
            setStaleOnly((v) => !v);
            setPage(0);
          }}
          title={`No release in ${STALE_THRESHOLD_DAYS}+ days, or never published`}
          className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
            staleOnly
              ? "bg-amber-500 text-white"
              : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
          }`}
        >
          Stale <span className="ml-0.5 opacity-60">{staleCount}</span>
        </button>
        <input
          type="text"
          placeholder="Filter sources..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          className="px-2.5 py-1 text-xs rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 placeholder:text-stone-400 w-48"
        />
      </div>

      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_1fr_1fr_1.4fr_0.9fr_1.2fr_auto] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium">
          <SortHeader field="name" current={sort} onChange={handleSortChange}>
            Name
          </SortHeader>
          <SortHeader field="org" current={sort} onChange={handleSortChange}>
            Org
          </SortHeader>
          <SortHeader field="type" current={sort} onChange={handleSortChange}>
            Type
          </SortHeader>
          <SortHeader
            field="latest_date"
            current={sort}
            onChange={handleSortChange}
            defaultDir="desc"
          >
            Last Release
          </SortHeader>
          <SortHeader field="fetch_priority" current={sort} onChange={handleSortChange}>
            Priority
          </SortHeader>
          <SortHeader
            field="median_gap_days"
            current={sort}
            onChange={handleSortChange}
            defaultDir="desc"
          >
            Cadence
          </SortHeader>
          <div></div>
        </div>
        {paginated.map((src) => {
          const result = results[src.slug];
          const isFetching = fetching.has(src.slug);
          const cadence = describeCadence(src.medianGapDays, src.fetchPriority, src.lastRetieredAt);
          const releaseAge = ageInDays(src.latestDate);
          const fetchedAge = ageInDays(src.lastFetchedAt);
          const stale = isSourceStale(src);
          return (
            <div
              key={src.id}
              className="grid grid-cols-[2fr_1fr_1fr_1.4fr_0.9fr_1.2fr_auto] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors items-center"
            >
              <div className="text-stone-900 dark:text-stone-100 truncate" title={src.slug}>
                {src.name}
              </div>
              <div className="text-stone-500 truncate">{src.orgSlug ?? "—"}</div>
              <div>
                <SourceTypeBadge type={src.type} />
              </div>
              <div>
                <div
                  className={stale ? "text-amber-600 dark:text-amber-400" : "text-stone-500"}
                  title={src.latestDate ?? "No releases recorded"}
                >
                  {formatAge(releaseAge)}
                  {releaseAge != null && <span className="text-stone-400"> ago</span>}
                </div>
                <div className="text-stone-400 text-[10px]" title={src.lastFetchedAt ?? undefined}>
                  fetched {formatAge(fetchedAge)}
                  {fetchedAge != null && " ago"}
                </div>
              </div>
              <div className="text-stone-500 capitalize">{src.fetchPriority ?? "normal"}</div>
              <div title={cadence.tooltip}>
                <div
                  className={
                    cadence.tone === "warn"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-stone-500"
                  }
                >
                  {cadence.primary}
                </div>
                <div className="text-stone-400 text-[10px]">{cadence.secondary}</div>
              </div>
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
                      <span className="text-green-600">
                        +{result.releasesInserted ?? 0} ({formatFetchDuration(result.durationMs)})
                      </span>
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
            <span>
              {page + 1} / {totalPages}
            </span>
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

interface OrgRow {
  orgSlug: string;
  sourceCount: number;
  staleCount: number;
  mostRecentRelease: string | null;
  mostRecentAgeDays: number | null;
  allStale: boolean;
}

type OrgStaleFilter = "all" | "stale" | "dormant";

function OrgsTable({ sources }: { sources: SourceEntry[] }) {
  const [filter, setFilter] = useState<OrgStaleFilter>("all");
  const [query, setQuery] = useState("");

  const { orgs, dormantCount, anyStaleCount } = useMemo(() => {
    const byOrg = new Map<string, SourceEntry[]>();
    for (const s of sources) {
      const key = s.orgSlug ?? "—";
      const list = byOrg.get(key) ?? [];
      list.push(s);
      byOrg.set(key, list);
    }
    const now = Date.now();
    const rows: OrgRow[] = [];
    let dormant = 0;
    let anyStale = 0;
    for (const [orgSlug, list] of byOrg) {
      let mostRecent: string | null = null;
      let staleCount = 0;
      for (const s of list) {
        if (isSourceStale(s, now)) staleCount++;
        // ISO-8601 strings sort lexicographically by time.
        if (s.latestDate && (!mostRecent || s.latestDate > mostRecent)) {
          mostRecent = s.latestDate;
        }
      }
      const allStale = staleCount === list.length;
      if (allStale) dormant++;
      if (staleCount > 0) anyStale++;
      rows.push({
        orgSlug,
        sourceCount: list.length,
        staleCount,
        mostRecentRelease: mostRecent,
        mostRecentAgeDays: ageInDays(mostRecent, now),
        allStale,
      });
    }
    rows.sort((a, b) => {
      if (a.allStale !== b.allStale) return a.allStale ? -1 : 1;
      const aAge = a.mostRecentAgeDays ?? Number.POSITIVE_INFINITY;
      const bAge = b.mostRecentAgeDays ?? Number.POSITIVE_INFINITY;
      if (aAge !== bAge) return bAge - aAge;
      return a.orgSlug.localeCompare(b.orgSlug);
    });
    return { orgs: rows, dormantCount: dormant, anyStaleCount: anyStale };
  }, [sources]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return orgs.filter((o) => {
      if (filter === "stale" && o.staleCount === 0) return false;
      if (filter === "dormant" && !o.allStale) return false;
      if (!q) return true;
      return o.orgSlug.toLowerCase().includes(q);
    });
  }, [orgs, filter, query]);

  if (sources.length === 0) {
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        No sources loaded.
      </div>
    );
  }

  const filterButtons: { value: OrgStaleFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: orgs.length },
    { value: "stale", label: "Has stale", count: anyStaleCount },
    { value: "dormant", label: "All stale", count: dormantCount },
  ];

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex gap-1">
          {filterButtons.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                filter === f.value
                  ? f.value === "dormant"
                    ? "bg-amber-500 text-white"
                    : "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                  : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
              }`}
            >
              {f.label} <span className="ml-0.5 opacity-60">{f.count}</span>
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter orgs..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="px-2.5 py-1 text-xs rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 placeholder:text-stone-400 w-48"
        />
      </div>

      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_0.8fr_0.8fr_1.4fr_0.8fr] gap-x-4 px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Org</div>
          <div className="text-right">Sources</div>
          <div className="text-right">Stale</div>
          <div>Newest Release</div>
          <div>Status</div>
        </div>
        {filtered.map((o) => (
          <div
            key={o.orgSlug}
            className="grid grid-cols-[2fr_0.8fr_0.8fr_1.4fr_0.8fr] gap-x-4 px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors items-center"
          >
            <div className="text-stone-900 dark:text-stone-100 truncate">{o.orgSlug}</div>
            <div className="text-stone-500 text-right">{o.sourceCount}</div>
            <div
              className={`text-right ${o.staleCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-stone-500"}`}
            >
              {o.staleCount}
            </div>
            <div
              className={o.allStale ? "text-amber-600 dark:text-amber-400" : "text-stone-500"}
              title={o.mostRecentRelease ?? undefined}
            >
              {formatAge(o.mostRecentAgeDays)}
              {o.mostRecentAgeDays != null && <span className="text-stone-400"> ago</span>}
            </div>
            <div>
              {o.allStale ? (
                <span className="text-amber-600 dark:text-amber-400">Dormant</span>
              ) : o.staleCount > 0 ? (
                <span className="text-stone-500">Partial</span>
              ) : (
                <span className="text-green-600">Active</span>
              )}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-xs text-stone-400 dark:text-stone-500 text-center">
            No orgs match.
          </div>
        )}
      </div>
    </div>
  );
}
