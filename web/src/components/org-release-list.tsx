"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { ReleaseListItem } from "./release-item";
import type { OrgReleaseItem } from "@/lib/api";
import type { SourceType } from "@buildinternet/releases-core/source-enums";

interface OrgReleaseListProps {
  orgSlug: string;
  initialReleases: OrgReleaseItem[];
  initialCursor: string | null;
  multipleSourcesExist: boolean;
  /** Source types present on this org's sources, used to populate filter tabs. */
  availableSourceTypes: SourceType[];
}

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  github: "GitHub",
  feed: "Feed",
  scrape: "Scrape",
  agent: "Agent",
};

export function OrgReleaseList({
  orgSlug,
  initialReleases,
  initialCursor,
  multipleSourcesExist,
  availableSourceTypes,
}: OrgReleaseListProps) {
  const [sourceType, setSourceType] = useState<string>("all");
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [releases, setReleases] = useState(initialReleases);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Track whether the current state is the unmodified initial render. While
  // true, we render the SSR-provided rows directly so filter tabs paint
  // instantly; flipping any filter triggers a fetch and replaces them.
  const [pristine, setPristine] = useState(true);

  const filterTabs = useMemo(() => {
    // Hide the source-type tab strip when there's only one underlying type;
    // the filter would always be a single-button row.
    if (availableSourceTypes.length <= 1) return [];
    return [
      { value: "all", label: "All" },
      ...availableSourceTypes.map((t) => ({ value: t, label: SOURCE_TYPE_LABELS[t] })),
    ];
  }, [availableSourceTypes]);

  const buildQuery = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams();
      if (sourceType !== "all") params.set("source_type", sourceType);
      if (includePrereleases) params.set("include_prereleases", "true");
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
      return params.toString();
    },
    [sourceType, includePrereleases],
  );

  // Refetch when filters change (skip the initial render — the SSR rows
  // already match the default filter state).
  useEffect(() => {
    if (pristine) return;
    const controller = new AbortController();
    setLoading(true);
    setFetchError(null);
    fetch(`/api/org-releases/${orgSlug}?${buildQuery()}`, { signal: controller.signal })
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
  }, [orgSlug, buildQuery, pristine]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/org-releases/${orgSlug}?${buildQuery({ cursor })}`);
      if (!res.ok) return;
      const data = await res.json();
      setReleases((prev) => [...prev, ...data.releases]);
      setCursor(data.pagination.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, orgSlug, buildQuery]);

  // The prerelease checkbox is useful for any org that has at least one
  // tracked source — non-GitHub adapters fall back to the version-pattern
  // detector, so feed/scrape/agent orgs can also produce prerelease rows.
  // The source-type tab strip is independent: it's only useful when the org
  // mixes types, since a single-type strip would be a one-button row.
  const showSourceTypeTabs = filterTabs.length > 0;
  const showFilterRow = showSourceTypeTabs || availableSourceTypes.length > 0;

  return (
    <div>
      {showFilterRow && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2 -mt-2">
          <div className="flex flex-wrap items-center gap-1">
            {showSourceTypeTabs &&
              filterTabs.map((tab) => {
                const active = sourceType === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    onClick={() => {
                      setPristine(false);
                      setSourceType(tab.value);
                    }}
                    className={
                      "text-[12px] px-2 py-1 rounded-md transition-colors " +
                      (active
                        ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-medium"
                        : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200")
                    }
                  >
                    {tab.label}
                  </button>
                );
              })}
          </div>
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
      )}

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
              hideDate={
                i > 0 &&
                release.publishedAt?.slice(0, 10) === releases[i - 1].publishedAt?.slice(0, 10)
              }
              sourceByline={
                multipleSourcesExist
                  ? {
                      name: release.source.name,
                      slug: release.source.slug,
                      orgSlug,
                      type: release.source.type,
                    }
                  : undefined
              }
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
