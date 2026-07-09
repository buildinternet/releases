"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FetchLogEntry,
  FetchLogResponse,
  FetchLogStatusCounts,
  FetchLogStatusFilter,
} from "./fetch-log-shared";

export type FetchLogSortField = "createdAt" | "durationMs";

interface Params {
  after?: string | null;
  before?: string | null;
  org?: string;
  status: FetchLogStatusFilter;
  /** Comma-separated statuses to drop (e.g. "no_change") — mirrors API excludeStatus. */
  excludeStatus?: string | null;
  pageSize?: number;
  sort?: FetchLogSortField;
  dir?: "asc" | "desc";
}

interface State {
  entries: FetchLogEntry[];
  nextCursor: string | null;
  totalCount: number;
  statusCounts: FetchLogStatusCounts;
  loading: boolean;
  error: string | null;
}

const EMPTY_COUNTS: FetchLogStatusCounts = { success: 0, error: 0, no_change: 0, dry_run: 0 };

function buildUrl(base: string, params: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  return `${base}${qs.toString() ? `?${qs}` : ""}`;
}

export function useFetchLog({
  after,
  before,
  org,
  status,
  excludeStatus,
  pageSize = 25,
  sort = "createdAt",
  dir = "desc",
}: Params) {
  const [state, setState] = useState<State>({
    entries: [],
    nextCursor: null,
    totalCount: 0,
    statusCounts: EMPTY_COUNTS,
    loading: true,
    error: null,
  });
  const reqId = useRef(0);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      const id = ++reqId.current;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const url = buildUrl(`/api/proxy/status/fetch-log`, {
          after: after ?? undefined,
          before: before ?? undefined,
          org,
          status: status === "all" ? undefined : status,
          excludeStatus: excludeStatus ?? undefined,
          limit: String(pageSize),
          cursor: cursor ?? undefined,
          sort: sort === "createdAt" ? undefined : sort,
          dir: sort === "createdAt" && dir === "desc" ? undefined : dir,
        });
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as FetchLogResponse;
        if (reqId.current !== id) return;
        setState((s) => ({
          entries: append ? [...s.entries, ...body.entries] : body.entries,
          nextCursor: body.nextCursor,
          totalCount: body.totalCount ?? s.totalCount,
          statusCounts: body.statusCounts ?? s.statusCounts,
          loading: false,
          error: null,
        }));
      } catch (e) {
        if (reqId.current !== id) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    },
    [after, before, org, status, excludeStatus, pageSize, sort, dir],
  );

  useEffect(() => {
    fetchPage(null, false);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (state.nextCursor && !state.loading) void fetchPage(state.nextCursor, true);
  }, [state.nextCursor, state.loading, fetchPage]);

  const reset = useCallback(() => {
    void fetchPage(null, false);
  }, [fetchPage]);

  const prepend = useCallback(
    (entry: FetchLogEntry) => {
      setState((s) => {
        // Mirror the API: excludeStatus drops the row from scope (counts + page),
        // while the status filter only affects which rows appear in the list.
        const inScope =
          isInScope(entry, { after, before, org }) &&
          !isExcludedStatus(entry.status, excludeStatus);
        const matchesFilter = status === "all" || entry.status === status;
        return {
          ...s,
          entries: inScope && matchesFilter ? [entry, ...s.entries] : s.entries,
          totalCount: inScope ? s.totalCount + 1 : s.totalCount,
          statusCounts: inScope
            ? { ...s.statusCounts, [entry.status]: (s.statusCounts[entry.status] ?? 0) + 1 }
            : s.statusCounts,
        };
      });
    },
    [after, before, org, status, excludeStatus],
  );

  return {
    entries: state.entries,
    totalCount: state.totalCount,
    statusCounts: state.statusCounts,
    hasMore: state.nextCursor !== null,
    loading: state.loading,
    error: state.error,
    loadMore,
    reset,
    prepend,
  };
}

function isInScope(
  entry: FetchLogEntry,
  { after, before, org }: { after?: string | null; before?: string | null; org?: string },
): boolean {
  if (after && entry.createdAt < after) return false;
  if (before && entry.createdAt > before) return false;
  if (org && entry.orgSlug && entry.orgSlug !== org) return false;
  return true;
}

/** True when entry.status is listed in a comma-separated excludeStatus param. */
function isExcludedStatus(entryStatus: string, excludeStatus?: string | null): boolean {
  if (!excludeStatus) return false;
  for (const part of excludeStatus.split(",")) {
    if (part.trim() === entryStatus) return true;
  }
  return false;
}
