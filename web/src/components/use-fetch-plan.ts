"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Wire shape mirrors packages/adapters/src/fetch-plan.ts. Kept local because
// /status/* is a dev-only endpoint, not part of the published api-types contract
// (same hand-synced pattern as fetch-log-shared.tsx). Update both together.
export type FetchStrategy =
  | "github"
  | "feed"
  | "appstore"
  | "video"
  | "crawl"
  | "scrape"
  | "agent"
  | "firecrawl";

export interface FetchPlan {
  strategy: FetchStrategy;
  strategyLabel: string;
  intervalHours: number | null;
  intervalLabel: string;
  cadence: "poll" | "firecrawl-webhook";
  paused: boolean;
  firecrawlSchedule?: string;
}

export interface FetchState {
  lastPolledAt: string | null;
  nextDueAt: string | null;
  backedOff: boolean;
  paused: boolean;
}

export interface SweepHealth {
  sweepDriven: boolean;
  flaggedAt: string | null;
  lastFetchedAt: string | null;
  staleHours: number | null;
  starved: boolean;
}

export interface FetchPlanRow {
  id: string;
  slug: string;
  name: string;
  type: string;
  /** Current tier the priority dropdown binds to (the value setFetchPriorityAction writes). */
  fetchPriority: "normal" | "low" | "paused";
  plan: FetchPlan;
  state: FetchState;
  sweep: SweepHealth;
}

interface State {
  rows: FetchPlanRow[];
  loading: boolean;
  error: string | null;
}

export function useFetchPlan(orgSlug: string) {
  const [state, setState] = useState<State>({ rows: [], loading: true, error: null });
  const reqId = useRef(0);

  const refetch = useCallback(async () => {
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`/api/proxy/status/fetch-plan?org=${encodeURIComponent(orgSlug)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { sources: FetchPlanRow[] };
      if (reqId.current !== id) return;
      setState({ rows: body.sources, loading: false, error: null });
    } catch (e) {
      if (reqId.current !== id) return;
      setState((s) => ({
        ...s,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [orgSlug]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { ...state, refetch };
}
