"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { ReleaseListItem } from "./release-item";
import type { ReleaseItem } from "@/lib/api";
import type { AppRowInfo } from "@/lib/app-source";
import { useDebounced } from "@/hooks/use-debounced";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { InfiniteScrollTrigger } from "./infinite-scroll-trigger";

interface SourceReleaseListProps {
  orgSlug: string;
  sourceSlug: string;
  initialReleases: ReleaseItem[];
  initialCursor: string | null;
  /** App Store display info when this source is an appstore app; null otherwise. */
  appStore?: AppRowInfo | null;
}

/**
 * Client-side, cursor-paginated release list with an inline FTS filter input
 * and prerelease toggle. Mirrors {@link OrgReleaseList} — same debounce, same
 * abort plumbing, same pristine-vs-fetched render path — minus the source-type
 * tabs, which are pointless when scope is already a single source.
 */
export function SourceReleaseList({
  orgSlug,
  sourceSlug,
  initialReleases,
  initialCursor,
  appStore,
}: SourceReleaseListProps) {
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput, 250);
  const [releases, setReleases] = useState(initialReleases);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pristine, setPristine] = useState(true);
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const trimmedSearch = search.trim();
  const buildQuery = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams();
      if (includePrereleases) params.set("include_prereleases", "true");
      if (trimmedSearch) params.set("q", trimmedSearch);
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
      return params.toString();
    },
    [includePrereleases, trimmedSearch],
  );

  // Flip `pristine` once the debounced search lands so the fetch effect skips
  // the wasted empty-q request that would otherwise fire between `searchInput`
  // updating and `search` catching up. Prerelease toggle flips pristine inline
  // since its effect on the query is synchronous.
  useEffect(() => {
    if (pristine && trimmedSearch) setPristine(false);
  }, [pristine, trimmedSearch]);

  useEffect(() => {
    if (pristine) return;
    // Abort any in-flight loadMore so its rows don't append after a filter
    // change. Re-assign the ref so a subsequent loadMore aborts *this* fetch.
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoading(true);
    setFetchError(null);
    fetch(`/api/source-releases/${orgSlug}/${sourceSlug}?${buildQuery()}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        setReleases(data.releases);
        setCursor(data.pagination.nextCursor);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setFetchError("Failed to load releases.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [orgSlug, sourceSlug, buildQuery, pristine]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(
        `/api/source-releases/${orgSlug}/${sourceSlug}?${buildQuery({ cursor })}`,
        { signal: controller.signal },
      );
      if (!res.ok) {
        setFetchError("Failed to load more releases.");
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      setReleases((prev) => [...prev, ...data.releases]);
      setCursor(data.pagination.nextCursor);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setFetchError("Failed to load more releases.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [cursor, orgSlug, sourceSlug, buildQuery]);

  const triggerRef = useInfiniteScroll<HTMLButtonElement>({
    hasMore: cursor !== null && !fetchError,
    loading,
    onLoadMore: loadMore,
  });

  return (
    <div>
      <div className="mt-3 mb-3 space-y-2">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Filter releases…"
          aria-label="Filter releases"
          className="w-full text-[12px] px-2 py-1 rounded-md bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-stone-300 dark:focus:border-stone-600"
        />
        <label className="flex items-center gap-2 text-[12px] text-stone-500 dark:text-stone-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includePrereleases}
            onChange={(e) => {
              setPristine(false);
              setIncludePrereleases(e.target.checked);
            }}
            className="h-3.5 w-3.5 accent-stone-700 dark:accent-stone-300"
          />
          <span>Show prereleases</span>
        </label>
      </div>

      {fetchError && releases.length > 0 && (
        <div className="text-center py-2 mb-2 text-amber-700 dark:text-amber-400 text-[12px] bg-amber-50 dark:bg-amber-950/30 rounded">
          {fetchError}
        </div>
      )}

      {releases.length === 0 ? (
        <div className="text-center py-12 text-stone-400 dark:text-stone-500 text-sm">
          {loading
            ? "Loading…"
            : fetchError
              ? fetchError
              : pristine
                ? "No releases yet."
                : "No releases match these filters."}
        </div>
      ) : (
        <>
          {releases.map((release, i) => (
            <ReleaseListItem
              key={release.id ?? i}
              release={release}
              appStore={appStore ?? null}
              hideDate={
                i > 0 &&
                release.publishedAt?.slice(0, 10) === releases[i - 1].publishedAt?.slice(0, 10)
              }
            />
          ))}
          {cursor && (
            <InfiniteScrollTrigger
              triggerRef={triggerRef}
              loading={loading}
              error={!!fetchError}
              onClick={loadMore}
            />
          )}
        </>
      )}
    </div>
  );
}
