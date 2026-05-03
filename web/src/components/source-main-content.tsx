import { Suspense } from "react";
import type { SourceDetail } from "@/lib/api";
import { ReleaseListItem } from "./release-item";
import { Pagination } from "./pagination";
import { ChangelogView, ChangelogSkeleton } from "./changelog-view";
import { HighlightsView } from "./highlights-view";

interface SourceMainContentProps {
  source: SourceDetail;
  orgSlug: string;
  tab: string | undefined;
  basePath: string;
  changelogPath?: string;
  /**
   * Byte offset into the active CHANGELOG file. When set (via
   * `?tab=changelog&offset=N` from search deep-links), the changelog view
   * starts its initial slice at `N` instead of 0 so the user lands on the
   * matched chunk. The range API's heading-aware slicer snaps forward to
   * the next `##` heading for any non-zero offset.
   */
  changelogOffset?: number;
}

/** Renders the main column for a source detail page — tab-aware. */
export function SourceMainContent({
  source,
  orgSlug,
  tab,
  basePath,
  changelogPath,
  changelogOffset,
}: SourceMainContentProps) {
  if (tab === "changelog" && source.hasChangelogFile) {
    // Keying by path ensures Suspense re-triggers when the user picks a
    // different file in the picker — ChangelogView's await needs to re-run.
    // The offset is also part of the key so navigating between two search
    // deep-links on the same file refetches.
    return (
      <Suspense
        key={`${source.slug}:${changelogPath ?? ""}:${changelogOffset ?? 0}`}
        fallback={<ChangelogSkeleton />}
      >
        <ChangelogView
          orgSlug={orgSlug}
          sourceSlug={source.slug}
          path={changelogPath}
          startOffset={changelogOffset}
        />
      </Suspense>
    );
  }

  // TODO: revisit default tab once Highlights has a regular publishing rhythm —
  // SourceTabs currently defaults to All Releases, so we mirror that here.
  if (tab === "highlights") {
    return (
      <HighlightsView
        rolling={source.summaries?.rolling ?? null}
        monthly={source.summaries?.monthly ?? []}
      />
    );
  }

  return (
    <>
      {source.releases.map((release, i) => (
        <ReleaseListItem
          key={i}
          release={release}
          hideDate={
            i > 0 &&
            release.publishedAt?.slice(0, 10) === source.releases[i - 1].publishedAt?.slice(0, 10)
          }
        />
      ))}
      <Pagination
        page={source.pagination.page}
        totalPages={source.pagination.totalPages}
        basePath={basePath}
      />
    </>
  );
}
