import Link from "next/link";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import {
  api,
  type OrgReleasesFeedResponse,
  type OverviewPageItem,
  type OrgActivity,
  type OrgHeatmap,
  type CollectionListItem,
} from "@/lib/api";
import type { MappedProductDetail } from "@/lib/graphql/map-source";
import { tryFetch } from "@/lib/ssr-fetch";
import type { SourceType } from "@buildinternet/releases-core/source-enums";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";
import { CliCommand } from "@/components/cli-command";
import { JsonLd } from "@/components/json-ld";
import { OrgReleaseList } from "@/components/org-release-list";
import { withReleaseBodyHtml, orgRowVariant } from "@/lib/render-release-body";
import { OverviewView } from "@/components/overview-view";
import { ReleaseTimeline } from "@/components/release-timeline";
import { taxonomySidebarSections, collectionsSidebarSection } from "@/components/taxonomy-chips";
import { buildReleaseItemListJsonLd } from "@/lib/schema-org";
import { AppIcon } from "@/components/app-icon";
import { getAppInfo, type AppInfo } from "@/lib/app-source";
import { sourceIdPath } from "@/lib/links";
import { AdminOnly } from "@/components/admin-only";
import { EntityNotice } from "@/components/entity-notice";
import { FollowButton } from "@/components/follow-button";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { formatSourceDate, shortUrl } from "@/lib/source-display";

export async function ProductView({
  orgSlug,
  orgName,
  orgId,
  product,
  /** From ProductPage GraphQL (critical path). */
  initialReleases,
  /** From ProductPage GraphQL (critical path). */
  collections,
}: {
  orgSlug: string;
  orgName: string;
  orgId?: string;
  product: MappedProductDetail;
  initialReleases: OrgReleasesFeedResponse;
  collections: CollectionListItem[];
}) {
  const productSlug = product.slug;
  const devAdmin = isLocalAdminEnabled();
  const productRef = { orgSlug, productSlug };
  const activityFrom = daysAgoIso(365 * 2).slice(0, 10);

  // Fail-open REST aggregates only — identity/feed/collections already GraphQL (#2047).
  const [overviewResult, activityResult, heatmapResult] = await Promise.allSettled([
    api.productOverview(product.id),
    tryFetch(api.productActivity(productRef, activityFrom), {
      route: `/${orgSlug}/${productSlug}`,
      event: "product-activity-fetch-failed",
    }),
    tryFetch(api.productHeatmap(productRef), {
      route: `/${orgSlug}/${productSlug}`,
      event: "product-heatmap-fetch-failed",
    }),
  ]);
  const overview: OverviewPageItem | null =
    overviewResult.status === "fulfilled" ? overviewResult.value : null;

  // Adapt ProductActivityResponse → OrgActivity for ReleaseTimeline reuse.
  // The component only reads range, sources, and aggregateWeekly; the org/product
  // identity field is not accessed by the component itself.
  const rawActivity = activityResult.status === "fulfilled" ? activityResult.value.data : null;
  const activity: OrgActivity | null = rawActivity
    ? {
        org: { slug: rawActivity.product.slug, name: rawActivity.product.name },
        range: rawActivity.range,
        sources: rawActivity.sources,
        aggregateWeekly: rawActivity.aggregateWeekly,
      }
    : null;

  const rawHeatmap = heatmapResult.status === "fulfilled" ? heatmapResult.value.data : null;
  // OrgHeatmap and ProductHeatmapResponse share the same structural shape (range,
  // dailyCounts, total) — the org/product identity key is not read by ReleaseHeatmap.
  const heatmap: OrgHeatmap | null = rawHeatmap
    ? {
        org: { slug: rawHeatmap.product.slug, name: rawHeatmap.product.name },
        range: rawHeatmap.range,
        dailyCounts: rawHeatmap.dailyCounts,
        total: rawHeatmap.total,
      }
    : null;

  const appEntries = product.sources
    .map((s) => {
      const app = getAppInfo(s);
      return app ? { id: s.id, slug: s.slug, name: s.name, app } : null;
    })
    .filter((e): e is { id: string; slug: string; name: string; app: AppInfo } => e !== null);

  const availableSourceTypes = Array.from(
    new Set(product.sources.map((s) => s.type)),
  ) as SourceType[];

  const latestPublishedAt = initialReleases.releases[0]?.publishedAt ?? null;
  const primaryItems = [
    ...(latestPublishedAt ? [{ label: "Latest", value: formatSourceDate(latestPublishedAt) }] : []),
    ...(product.url
      ? [{ label: "Website", value: shortUrl(product.url), externalLink: product.url }]
      : []),
  ];
  const sidebarSections = [
    ...(primaryItems.length > 0 ? [{ items: primaryItems }] : []),
    ...taxonomySidebarSections({ category: product.category, tags: product.tags }),
    ...collectionsSidebarSection(collections),
  ];

  const productUrl = `https://releases.sh/${orgSlug}/${productSlug}`;
  const releaseListId = `${productUrl}#releases`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: product.name,
        url: productUrl,
        mainEntity: { "@id": releaseListId },
        ...(product.description ? { description: product.description } : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
          {
            "@type": "ListItem",
            position: 2,
            name: orgName,
            item: `https://releases.sh/${orgSlug}`,
          },
          { "@type": "ListItem", position: 3, name: product.name, item: productUrl },
        ],
      },
      buildReleaseItemListJsonLd(initialReleases.releases, {
        listId: releaseListId,
        name: `${product.name} Releases`,
      }),
    ],
  };

  // Rendered once and reused in both branches below (inside the timeline, or
  // standalone when there's no activity) so a change to OverviewView applies to
  // both. Only one branch renders, so sharing the element is safe.
  const overviewNode = overview ? <OverviewView page={overview} /> : null;

  return (
    <div className="min-h-screen">
      <JsonLd data={jsonLd} />
      <Header />
      <div className="max-w-5xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <Link href={`/${orgSlug}`} className="hover:text-stone-600 dark:hover:text-stone-300">
            {orgName}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{product.name}</span>
        </div>

        <div className="flex flex-col md:flex-row gap-10 mt-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
              <div className="min-w-0">
                <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
                  {product.name}
                </h1>
                {product.description && (
                  <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
                    {product.description}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <FollowButton
                  targetType="product"
                  targetId={product.id}
                  label={product.name}
                  parentOrgId={orgId}
                  parentOrgName={orgName}
                />
                <AdminOnly devAdmin={devAdmin}>
                  <Link
                    href={`/${orgSlug}/${productSlug}/admin`}
                    className="inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-[13px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-800/60 dark:hover:text-stone-200"
                  >
                    Admin
                  </Link>
                </AdminOnly>
              </div>
            </div>
            {appEntries.length > 0 && (
              <div className="flex items-center gap-2 mt-3">
                <span className="text-xs text-stone-400 dark:text-stone-500">Available on</span>
                {appEntries.map((e) => (
                  <Link
                    key={e.slug}
                    href={sourceIdPath(e.id)}
                    className="flex items-center gap-1.5 bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 rounded-md px-2 py-1 transition-colors"
                  >
                    <AppIcon iconUrl={e.app.iconUrl} name={e.name} size={16} />
                    <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
                      {e.app.label}
                    </span>
                  </Link>
                ))}
              </div>
            )}
            <CliCommand identifier={product.slug} />
            <EntityNotice notice={product.notice} />
            {activity && (
              <ReleaseTimeline
                activity={activity}
                heatmap={heatmap}
                orgSlug={orgSlug}
                sources={[]}
                products={[]}
                overviewSlot={overviewNode}
              />
            )}
            {!activity && overviewNode}
            <OrgReleaseList
              orgSlug={orgSlug}
              product={productSlug}
              initialReleases={withReleaseBodyHtml(initialReleases.releases, orgRowVariant)}
              initialCursor={initialReleases.pagination.nextCursor}
              multipleSourcesExist={product.sources.length > 1}
              availableSourceTypes={availableSourceTypes}
            />
          </div>
          <Sidebar
            sections={sidebarSections}
            formatPath={`/${orgSlug}/${productSlug}`}
            report={{
              kind: "product",
              name: product.name,
              id: product.id,
              slug: productSlug,
              path: `/${orgSlug}/${productSlug}`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
