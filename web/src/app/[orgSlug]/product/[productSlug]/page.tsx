import type { Metadata } from "next";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import {
  api,
  ApiSetupError,
  ApiNotFoundError,
  type ProductDetail,
  type OrgReleasesResponse,
  type OverviewPageItem,
} from "@/lib/api";
import type { SourceType } from "@buildinternet/releases-core/source-enums";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { Sidebar } from "@/components/sidebar";
import { CliCommand } from "@/components/cli-command";
import { JsonLd } from "@/components/json-ld";
import { OrgReleaseList } from "@/components/org-release-list";
import { OverviewView } from "@/components/overview-view";
import { taxonomySidebarSections } from "@/components/taxonomy-chips";
import { buildReleaseItemListJsonLd } from "@/lib/schema-org";
import { AppIcon } from "@/components/app-icon";
import { getAppInfo, type AppInfo } from "@/lib/app-source";
import { getOrg } from "../../_lib/org-data";

const getProduct = cache((orgSlug: string, productSlug: string) =>
  api.productDetail({ orgSlug, productSlug }),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug, productSlug } = await params;
  try {
    const product = await getProduct(orgSlug, productSlug);
    return {
      title: `${product.name} Release Notes & Changelog`,
      description:
        product.description ?? `Release notes, changelog, and updates for ${product.name}.`,
      openGraph: { type: "website", url: `/${orgSlug}/product/${productSlug}` },
      alternates: { canonical: `/${orgSlug}/product/${productSlug}` },
    };
  } catch {
    return { title: productSlug };
  }
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}) {
  const { orgSlug, productSlug } = await params;

  let product: ProductDetail;
  let org;
  try {
    [product, org] = await Promise.all([getProduct(orgSlug, productSlug), getOrg(orgSlug)]);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  // Single-product collapse: with ≤1 product the org page is already this
  // product's feed, so the product page would be duplicate content. 301 home.
  if (org.products.length <= 1) {
    permanentRedirect(`/${orgSlug}`);
  }

  const orgName = org.name;

  // Initial feed rows (product-scoped) + overview, both best-effort.
  let initialReleases: OrgReleasesResponse;
  try {
    initialReleases = await api.orgReleases(orgSlug, { product: productSlug });
  } catch {
    initialReleases = { releases: [], pagination: { nextCursor: null, limit: 20 } };
  }
  let overview: OverviewPageItem | null = null;
  try {
    overview = await api.productOverview(product.id);
  } catch {
    overview = null;
  }

  const appEntries = product.sources
    .map((s) => {
      const app = getAppInfo(s);
      return app ? { slug: s.slug, name: s.name, app } : null;
    })
    .filter((e): e is { slug: string; name: string; app: AppInfo } => e !== null);

  const availableSourceTypes = Array.from(
    new Set(product.sources.map((s) => s.type)),
  ) as SourceType[];

  const sidebarSections = [
    { items: [{ label: "Sources", value: product.sources.length, large: true }] },
    ...taxonomySidebarSections({ category: product.category, tags: product.tags }),
  ];

  const productUrl = `https://releases.sh/${orgSlug}/product/${productSlug}`;
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
                href={`/${orgSlug}/${e.slug}`}
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
