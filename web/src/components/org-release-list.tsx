"use client";

import { useState, useCallback } from "react";
import { ReleaseListItem } from "./release-item";
import type { OrgReleaseItem } from "@/lib/api";

interface OrgReleaseListProps {
  orgSlug: string;
  initialReleases: OrgReleaseItem[];
  initialCursor: string | null;
  multipleSourcesExist: boolean;
}

export function OrgReleaseList({
  orgSlug,
  initialReleases,
  initialCursor,
  multipleSourcesExist,
}: OrgReleaseListProps) {
  const [releases, setReleases] = useState(initialReleases);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ cursor });
      const res = await fetch(`/api/org-releases/${orgSlug}?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setReleases((prev) => [...prev, ...data.releases]);
      setCursor(data.pagination.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, orgSlug]);

  if (releases.length === 0) {
    return (
      <div className="text-center py-12 text-stone-400 dark:text-stone-500 text-sm">
        No releases yet.
      </div>
    );
  }

  return (
    <div>
      {releases.map((release, i) => (
        <ReleaseListItem
          key={release.id ?? i}
          release={release}
          hideDate={
            i > 0 &&
            release.publishedAt?.slice(0, 10) ===
              releases[i - 1].publishedAt?.slice(0, 10)
          }
          sourceByline={
            multipleSourcesExist
              ? { name: release.source.name, slug: release.source.slug, orgSlug, type: release.source.type }
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
    </div>
  );
}
