import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { Suspense } from "react";
import { ApiNotFoundError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { SourceReleaseList } from "@/components/source-release-list";
import { withReleaseBodyHtml } from "@/lib/render-release-body";
import { RelatedRail } from "@/components/related-rail";
import {
  buildReleaseItemListJsonLd,
  buildSourceEntityJsonLd,
  currentPeriod,
} from "@/lib/schema-org";
import { getSourceById } from "./_lib/source-by-id";
import { getAppInfo } from "@/lib/app-source";
import { getVideoInfo } from "@/lib/video-source";
import { enableOnDemandIsr } from "@/lib/static-params";

// On-demand ISR: render once per source on first request, then serve from cache
// (revalidated every 60s). See `enableOnDemandIsr`. (#1607)
export const revalidate = 60;
export const generateStaticParams = enableOnDemandIsr;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const source = await getSourceById(id);
    const orgSlug = source.org?.slug ?? id;
    const orgName = source.org?.name ?? orgSlug;
    const canonicalPath = source.productId
      ? `/sources/${id}`
      : source.org
        ? `/${source.org.slug}/${source.slug}`
        : `/sources/${id}`;
    return {
      title: `${source.name} — ${orgName}`,
      description: `Release notes, changelog, and version history for ${source.name} by ${orgName} — updated ${currentPeriod()}.`,
      openGraph: { type: "website", url: canonicalPath },
      alternates: {
        canonical: canonicalPath,
        // The `.atom` feed route lives only under the org-scoped path; skip the
        // alternate entirely for a (rare) member source with no resolved org so
        // we never emit a broken protocol-relative `//{slug}.atom` URL.
        ...(source.org
          ? {
              types: {
                "application/atom+xml": [
                  {
                    url: `/${source.org.slug}/${source.slug}.atom`,
                    title: `${source.name} release notes — ${orgName}`,
                  },
                ],
              },
            }
          : {}),
      },
    };
  } catch {
    return { title: id };
  }
}

/**
 * Two rails under the release list:
 *   1. "More from {org}" — same-org releases + sibling sources.
 *   2. "From other products" — global semantic neighbors, excluding this org.
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

export default async function SourceByIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Legacy `?tab=highlights|changelog` deep-links are redirected to the
  // path-based sub-tabs in the routing middleware (`src/proxy.ts`).

  let source;
  try {
    source = await getSourceById(id);
  } catch (e) {
    if (e instanceof ApiNotFoundError) notFound();
    throw e;
  }

  // Orphan source (has org, no productId) → redirect to canonical bare URL.
  if (source.org && !source.productId) {
    permanentRedirect(`/${source.org.slug}/${source.slug}`);
  }

  const orgSlug = source.org?.slug ?? "";
  const initialCursor = source.pagination.nextCursor;

  // Member sources are canonical at /sources/:id (bare /{org}/{slug} resolves to the
  // product post-flip); sourceless sources too; only a non-member with an org uses bare.
  const sourceUrl = source.productId
    ? `https://releases.sh/sources/${id}`
    : source.org
      ? `https://releases.sh/${source.org.slug}/${source.slug}`
      : `https://releases.sh/sources/${id}`;
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

  const appInfo = getAppInfo(source);
  const appStore = appInfo ? { ...appInfo, appName: source.name } : null;
  const videoInfo = getVideoInfo(source);

  return (
    <>
      <JsonLd data={jsonLd} />
      <SourceReleaseList
        orgSlug={orgSlug}
        sourceSlug={source.slug}
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
