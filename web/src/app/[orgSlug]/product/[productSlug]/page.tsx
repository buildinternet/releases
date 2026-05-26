import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { api, ApiSetupError, ApiNotFoundError, type ProductDetail } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { SourceCard } from "@/components/source-card";
import { Sidebar } from "@/components/sidebar";
import { CliCommand } from "@/components/cli-command";
import { JsonLd } from "@/components/json-ld";
import { taxonomySidebarSections } from "@/components/taxonomy-chips";
import { getOrg } from "../../_lib/org-data";
import Link from "next/link";
import { AppIcon } from "@/components/app-icon";
import { getAppInfo, type AppInfo } from "@/lib/app-source";
import { ProductAdminMenu } from "@/components/product-admin-menu";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

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
      title: product.name,
      description: product.description ?? `Release feed and changelog sources for ${product.name}.`,
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
  const orgName = org.name;
  const adminEnabled = isLocalAdminEnabled();

  const appEntries = product.sources
    .map((s) => {
      const app = getAppInfo(s);
      return app ? { slug: s.slug, name: s.name, app } : null;
    })
    .filter((e): e is { slug: string; name: string; app: AppInfo } => e !== null);

  const sidebarSections = [
    {
      items: [{ label: "Sources", value: product.sources.length, large: true }],
    },
    ...taxonomySidebarSections({ category: product.category, tags: product.tags }),
  ];

  const productUrl = `https://releases.sh/${orgSlug}/product/${productSlug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: product.name,
        url: productUrl,
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
        {adminEnabled && (
          <div className="mt-2">
            <ProductAdminMenu orgSlug={orgSlug} productSlug={productSlug} name={product.name} />
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-6">
          <div className="flex-1 min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
              Sources
            </h2>
            <div className="space-y-2">
              {product.sources.map((source) => (
                <SourceCard
                  key={source.slug}
                  source={{ ...source, releaseCount: 0, latestVersion: null, latestDate: null }}
                  orgSlug={orgSlug}
                />
              ))}
            </div>
          </div>
          <Sidebar sections={sidebarSections} formatPath={`/${orgSlug}/product/${productSlug}`} />
        </div>
      </div>
    </div>
  );
}
