"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
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

// Source types collapse into two filter groups for the user-facing tabs.
// GitHub is a distinct, well-known surface; everything else (feed / scrape /
// agent) is plumbing the user shouldn't have to reason about, so we present
// it as a single "Web" group.
const WEB_SOURCE_TYPES: readonly SourceType[] = ["feed", "scrape", "agent"];
const FILTER_GROUPS = {
  all: { label: "All", types: [] as SourceType[] },
  web: { label: "Web", types: [...WEB_SOURCE_TYPES] as SourceType[] },
  github: { label: "GitHub", types: ["github"] as SourceType[] },
} as const;
type FilterGroup = keyof typeof FILTER_GROUPS;

export function OrgReleaseList({
  orgSlug,
  initialReleases,
  initialCursor,
  multipleSourcesExist,
  availableSourceTypes,
}: OrgReleaseListProps) {
  const [filterGroup, setFilterGroup] = useState<FilterGroup>("all");
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [releases, setReleases] = useState(initialReleases);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Track whether the current state is the unmodified initial render. While
  // true, we render the SSR-provided rows directly so filter tabs paint
  // instantly; flipping any filter triggers a fetch and replaces them.
  const [pristine, setPristine] = useState(true);
  // Tracks the in-flight pagination fetch so we can abort it when the user
  // flips a filter mid-page-load. Without this, an old page's response can
  // race the filter switch and append stale rows to the new filtered list.
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const hasGithub = availableSourceTypes.includes("github");
  const hasWeb = availableSourceTypes.some((t) => WEB_SOURCE_TYPES.includes(t));

  const filterTabs = useMemo(() => {
    // The Web vs. GitHub split is only useful when the org actually has both
    // sides; a one-button row collapses to no filter.
    if (!hasGithub || !hasWeb) return [];
    return [
      { value: "all" as const, label: FILTER_GROUPS.all.label },
      { value: "web" as const, label: FILTER_GROUPS.web.label },
      { value: "github" as const, label: FILTER_GROUPS.github.label },
    ];
  }, [hasGithub, hasWeb]);

  // Defensive: if the available source types change such that the active
  // group disappears, fall back to "all" so buildQuery never sends a
  // source_type that's no longer represented in the org's catalog.
  useEffect(() => {
    if ((filterGroup === "github" && !hasGithub) || (filterGroup === "web" && !hasWeb)) {
      setFilterGroup("all");
    }
  }, [filterGroup, hasGithub, hasWeb]);

  const buildQuery = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams();
      const types = FILTER_GROUPS[filterGroup].types;
      if (types.length > 0) params.set("source_type", types.join(","));
      if (includePrereleases) params.set("include_prereleases", "true");
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
      return params.toString();
    },
    [filterGroup, includePrereleases],
  );

  // Refetch when filters change (skip the initial render — the SSR rows
  // already match the default filter state).
  useEffect(() => {
    if (pristine) return;
    // Cancel any in-flight pagination so its response can't append to the
    // newly-filtered list once it lands.
    loadMoreAbortRef.current?.abort();
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
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(`/api/org-releases/${orgSlug}?${buildQuery({ cursor })}`, {
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (controller.signal.aborted) return;
      setReleases((prev) => [...prev, ...data.releases]);
      setCursor(data.pagination.nextCursor);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      throw err;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mt-3 mb-3">
          <div className="flex items-center gap-1 shrink-0">
            {showSourceTypeTabs &&
              filterTabs.map((tab) => {
                const active = filterGroup === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setPristine(false);
                      setFilterGroup(tab.value);
                    }}
                    className={
                      "text-[12px] px-2 py-1 rounded-md transition-colors whitespace-nowrap " +
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
          <label className="flex items-center gap-2 text-[12px] text-stone-500 dark:text-stone-400 cursor-pointer select-none ml-auto shrink-0">
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
