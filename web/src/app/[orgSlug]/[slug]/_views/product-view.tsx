import Link from "next/link";
import {
  api,
  type ProductDetail,
  type OrgReleasesResponse,
  type OverviewPageItem,
} from "@/lib/api";
import type { SourceType } from "@buildinternet/releases-core/source-enums";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";
import { CliCommand } from "@/components/cli-command";
import { JsonLd } from "@/components/json-ld";
import { OrgReleaseList } from "@/components/org-release-list";
import { OverviewView } from "@/components/overview-view";
import { taxonomySidebarSections } from "@/components/taxonomy-chips";
import { buildReleaseItemListJsonLd } from "@/lib/schema-org";
import { AppIcon } from "@/components/app-icon";
import { getAppInfo, type AppInfo } from "@/lib/app-source";
import { sourceIdPath } from "@/lib/links";
import { ProductAdminMenu } from "@/components/product-admin-menu";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

export async function ProductView({
  orgSlug,
  orgName,
  product,
}: {
  orgSlug: string;
  orgName: string;
  product: ProductDetail;
}) {
  const productSlug = product.slug;
  const adminEnabled = isLocalAdminEnabled();

  // Initial feed rows (product-scoped) + overview, both best-effort; run in parallel.
  const [releasesResult, overviewResult] = await Promise.allSettled([
    api.orgReleases(orgSlug, { product: productSlug }),
    api.productOverview(product.id),
  ]);
  const initialReleases: OrgReleasesResponse =
    releasesResult.status === "fulfilled"
      ? releasesResult.value
      : { releases: [], pagination: { nextCursor: null, limit: 20 } };
  const overview: OverviewPageItem | null =
    overviewResult.status === "fulfilled" ? overviewResult.value : null;

  const appEntries = product.sources
    .map((s) => {
      const app = getAppInfo(s);
      return app ? { id: s.id, slug: s.slug, name: s.name, app } : null;
    })
    .filter((e): e is { id: string; slug: string; name: string; app: AppInfo } => e !== null);

  const availableSourceTypes = Array.from(
    new Set(product.sources.map((s) => s.type)),
  ) as SourceType[];

  const sidebarSections = [
    { items: [{ label: "Sources", value: product.sources.length, large: true }] },
    ...taxonomySidebarSections({ category: product.category, tags: product.tags }),
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

  return (
    <div className="min-h-screen">
      <JsonLd data={jsonLd} />
      <Header />
      <div className="max-w-4xl mx-auto px-6">
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

        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">
          {product.name}
        </h1>
        {product.description && (
          <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">{product.description}</p>
        )}
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
        {adminEnabled && (
          <div className="mt-2">
            <ProductAdminMenu orgSlug={orgSlug} productSlug={productSlug} name={product.name} />
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-6">
          <div className="flex-1 min-w-0">
            {overview && <OverviewView page={overview} />}
            <OrgReleaseList
              orgSlug={orgSlug}
              product={productSlug}
              initialReleases={initialReleases.releases}
              initialCursor={initialReleases.pagination.nextCursor}
              multipleSourcesExist={product.sources.length > 1}
              availableSourceTypes={availableSourceTypes}
            />
          </div>
          <Sidebar sections={sidebarSections} formatPath={`/${orgSlug}/product/${productSlug}`} />
        </div>
      </div>
    </div>
  );
}
