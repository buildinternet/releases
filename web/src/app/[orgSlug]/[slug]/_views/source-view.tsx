import { Suspense } from "react";
import { type SourceDetail } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { SourceReleaseList } from "@/components/source-release-list";
import { withReleaseBodyHtml } from "@/lib/render-release-body";
import { RelatedRail } from "@/components/related-rail";
import { buildReleaseItemListJsonLd, buildSourceEntityJsonLd } from "@/lib/schema-org";
import { getAppInfo } from "@/lib/app-source";
import { getVideoInfo } from "@/lib/video-source";

/**
 * Two rails under the release list:
 *   1. "More from {org}" — same-org releases + sibling sources.
 *   2. "From other products" — global semantic neighbors, excluding this org.
 *
 * Server-rendered inside Suspense so a slow Vectorize roundtrip doesn't
 * hold the rest of the page hostage. Empty/degraded rails collapse to null.
 */
function RelatedRails({
  anchorReleaseId,
  orgSlug,
  orgName,
}: {
  anchorReleaseId: string | null;
  orgSlug: string | null;
  orgName: string | null;
}) {
  return (
    <>
      {orgSlug && (
        <Suspense fallback={null}>
          <RelatedRail
            anchorReleaseId={anchorReleaseId}
            scope="org"
            heading={orgName ? `More from ${orgName}` : "More from this team"}
          />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <RelatedRail
          anchorReleaseId={anchorReleaseId}
          scope="global"
          heading="From other products"
          excludeOrgSlug={orgSlug}
        />
      </Suspense>
    </>
  );
}

export function SourceView({ orgSlug, source }: { orgSlug: string; source: SourceDetail }) {
  const sourceSlug = source.slug;
  const initialCursor = source.pagination.nextCursor;

  // App Store sources render the compact app-update row (icon + "{App} v{ver}"
  // + "Available for iOS/macOS") instead of the standard version/notes layout.
  // Every release on a source page is the same app, so one AppRowInfo applies
  // to the whole list. getAppInfo returns null for non-app sources. #1206
  const appInfo = getAppInfo(source);
  const appStore = appInfo
    ? { label: appInfo.label, iconUrl: appInfo.iconUrl, appName: source.name }
    : null;

  // Video sources render a thumbnail-forward row with a "Watch on {provider}"
  // subline. Every release on a source page is the same provider, so one
  // VideoRowInfo applies to the whole list. getVideoInfo returns null for
  // non-video sources.
  const videoInfo = getVideoInfo(source);

  const sourceUrl = `https://releases.sh/${orgSlug}/${sourceSlug}`;
  const releaseListId = `${sourceUrl}#releases`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      buildSourceEntityJsonLd(source, sourceUrl),
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
          ...(source.org
            ? [
                {
                  "@type": "ListItem",
                  position: 2,
                  name: source.org.name,
                  item: `https://releases.sh/${source.org.slug}`,
                },
                { "@type": "ListItem", position: 3, name: source.name, item: sourceUrl },
              ]
            : [{ "@type": "ListItem", position: 2, name: source.name, item: sourceUrl }]),
        ],
      },
      buildReleaseItemListJsonLd(source.releases, {
        listId: releaseListId,
        name: `${source.name} releases`,
        isPartOfId: sourceUrl,
      }),
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <SourceReleaseList
        orgSlug={orgSlug}
        sourceSlug={sourceSlug}
        initialReleases={withReleaseBodyHtml(
          source.releases,
          appStore || videoInfo ? "full" : "collapsed",
        )}
        initialCursor={initialCursor}
        appStore={appStore}
        video={videoInfo}
        sourceName={source.name}
      />
      <RelatedRails
        anchorReleaseId={source.releases[0]?.id ?? null}
        orgSlug={source.org?.slug ?? null}
        orgName={source.org?.name ?? null}
      />
    </>
  );
}
