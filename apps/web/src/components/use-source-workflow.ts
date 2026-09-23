"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchStrategy } from "./use-fetch-plan";

// Dev-only endpoint — types kept local (not in api-types), hand-synced with
// workers/api/src/routes/status.ts and @releases/adapters/workflow-stages.
export type StageKind = "sync" | "ai" | "async";
export interface WorkflowStage {
  key: string;
  label: string;
  kind: StageKind;
  detailHint?: string;
}
export type RunStatus = "success" | "error" | "no_change" | "dry_run";
export interface LastRun {
  status: RunStatus;
  releasesFound: number;
  releasesInserted: number;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}
export interface AiPass {
  operation: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
}
export interface SourceWorkflow {
  source: { id: string; slug: string; name: string; type: string; strategyLabel: string };
  plan: {
    strategy: FetchStrategy;
    strategyLabel: string;
    intervalLabel: string;
    cadence: "poll" | "firecrawl-webhook";
    paused: boolean;
  };
  state: {
    nextDueAt: string | null;
    backedOff: boolean;
    paused: boolean;
    lastPolledAt: string | null;
  };
  sweep: { sweepDriven: boolean; starved: boolean; staleHours: number | null };
  stages: WorkflowStage[];
  lastRun: LastRun | null;
  aiPasses: AiPass[];
  sparkline: RunStatus[];
}

export function useSourceWorkflow(sourceId: string | null) {
  const [data, setData] = useState<SourceWorkflow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const refresh = useCallback(async () => {
    if (!sourceId) {
      setData(null);
      setError(null);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/proxy/status/source-workflow?sourceId=${encodeURIComponent(sourceId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as SourceWorkflow;
      if (reqId.current === id) setData(body);
    } catch (e) {
      if (reqId.current === id) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reqId.current === id) setLoading(false);
    }
  }, [sourceId]);

  // Clear stale data immediately when the source changes so the loading
  // indicator fires. Keep this separate from the refresh effect so that
  // manual refresh() calls do NOT clear existing data mid-load.
  useEffect(() => {
    setData(null);
    setError(null);
  }, [sourceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, loading, error, refresh };
}
