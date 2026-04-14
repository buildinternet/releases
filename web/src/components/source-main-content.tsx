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
}

/** Renders the main column for a source detail page — tab-aware. */
export function SourceMainContent({ source, tab, basePath }: SourceMainContentProps) {
  const hasHighlights = !!(source.summaries?.rolling || source.summaries?.monthly?.length);

  if (tab === "changelog" && source.hasChangelogFile) {
    return (
      <Suspense key={source.slug} fallback={<ChangelogSkeleton />}>
        <ChangelogView sourceSlug={source.slug} />
      </Suspense>
    );
  }

  if (tab === "releases" || !hasHighlights) {
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

  return (
    <HighlightsView
      rolling={source.summaries?.rolling ?? null}
      monthly={source.summaries?.monthly ?? []}
    />
  );
}
