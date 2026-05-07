"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { ReleaseListItem } from "./release-item";
import type { CollectionReleaseItem } from "@/lib/api";

interface CollectionReleaseListProps {
  collectionSlug: string;
  initialReleases: CollectionReleaseItem[];
  initialCursor: string | null;
}

// Lighter cousin of OrgReleaseList: no source-type tabs and no inline search
// (cross-org FTS isn't wired up — the org-feed `q=` narrows by org_id, which
// doesn't extend to multi-org cleanly). State is just prerelease + load more.
export function CollectionReleaseList({
  collectionSlug,
  initialReleases,
  initialCursor,
}: CollectionReleaseListProps) {
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [releases, setReleases] = useState(initialReleases);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pristine, setPristine] = useState(true);
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const buildQuery = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams();
      if (includePrereleases) params.set("include_prereleases", "true");
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
      return params.toString();
    },
    [includePrereleases],
  );

  // Refetch from the top when filters change.
  useEffect(() => {
    if (pristine) return;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoading(true);
    setFetchError(null);
    fetch(`/api/collection-releases/${collectionSlug}?${buildQuery()}`, {
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
  }, [collectionSlug, buildQuery, pristine]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(
        `/api/collection-releases/${collectionSlug}?${buildQuery({ cursor })}`,
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
  }, [cursor, collectionSlug, buildQuery]);

  return (
    <div>
      <div className="mt-3 mb-3 flex justify-end">
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
          {loading ? "Loading…" : (fetchError ?? "No releases yet.")}
        </div>
      ) : (
        <>
          {releases.map((release, i) => (
            <ReleaseListItem
              key={release.id ?? i}
              release={release}
              hideDate={
                i > 0 &&
                release.publishedAt?.slice(0, 10) === releases[i - 1].publishedAt?.slice(0, 10)
              }
              sourceByline={{
                // Cross-org feed: surface the org name (not the source name)
                // as the byline so each row is identifiable at a glance. The
                // link still drops users at the canonical source detail page.
                name: release.org.name,
                slug: release.source.slug,
                orgSlug: release.org.slug,
                type: release.source.type,
              }}
            />
          ))}
          {cursor && (
            <div className="text-center py-6">
              <button
                onClick={loadMore}
                disabled={loading}
                className="px-5 py-2 text-[13px] font-medium text-stone-500 dark:text-stone-400 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-md hover:border-stone-300 dark:hover:border-stone-600 transition-colors disabled:opacity-50"
              >
                {loading ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
