import { Suspense } from "react";
import type { SourceDetail } from "@/lib/api";
import { ReleaseListItem } from "./release-item";
import { Pagination } from "./pagination";
import { ChangelogView, ChangelogSkeleton } from "./changelog-view";
import { HighlightsView } from "./highlights-view";

interface SourceMainContentProps {
  source: SourceDetail;
  tab: string | undefined;
  basePath: string;
  changelogPath?: string;
}

/** Renders the main column for a source detail page — tab-aware. */
export function SourceMainContent({ source, tab, basePath, changelogPath }: SourceMainContentProps) {
  if (tab === "changelog" && source.hasChangelogFile) {
    // Keying by path ensures Suspense re-triggers when the user picks a
    // different file in the picker — ChangelogView's await needs to re-run.
    return (
      <Suspense key={`${source.slug}:${changelogPath ?? ""}`} fallback={<ChangelogSkeleton />}>
        <ChangelogView sourceSlug={source.slug} path={changelogPath} />
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
          hideDate={i > 0 && release.publishedAt?.slice(0, 10) === source.releases[i - 1].publishedAt?.slice(0, 10)}
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
