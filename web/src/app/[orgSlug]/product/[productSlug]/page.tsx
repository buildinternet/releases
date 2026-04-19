import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { api, ApiSetupError, type ProductDetail } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { SourceCard } from "@/components/source-card";
import { Sidebar } from "@/components/sidebar";
import { CliCommand } from "@/components/cli-command";
import Link from "next/link";

const getProduct = cache((slug: string) => api.productDetail(slug));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}): Promise<Metadata> {
  const { productSlug } = await params;
  try {
    const product = await getProduct(productSlug);
    return {
      title: product.name,
      description: product.description ?? `${product.name} changelog sources`,
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
  try {
    product = await getProduct(productSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    notFound();
  }

  const sidebarSections = [
    {
      items: [
        { label: "Sources", value: product.sources.length, large: true },
        ...(product.category ? [{ label: "Category", value: product.category }] : []),
      ],
    },
    ...(product.tags.length > 0
      ? [{ items: [{ label: "Tags", value: product.tags.join(", ") }] }]
      : []),
  ];

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <Link href={`/${orgSlug}`} className="hover:text-stone-600 dark:hover:text-stone-300">
            {orgSlug}
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
        <CliCommand identifier={product.slug} />

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
