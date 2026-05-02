import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { api, ApiSetupError, type CategoryDetail } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { TaxonomyList } from "@/components/taxonomy-list";

const getCategory = cache((slug: string) => api.categoryDetail(slug));

function titleFor(slug: string) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const title = titleFor(slug);
  return {
    title,
    description: `Organizations and products in the ${title} category`,
    alternates: { canonical: `/categories/${slug}` },
  };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let detail: CategoryDetail;
  try {
    detail = await getCategory(slug);
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

  const title = titleFor(detail.slug);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-400 dark:text-stone-500">Categories</span>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{title}</span>
        </div>

        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">
          {title}
        </h1>
        <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
          Organizations and products tagged <span className="font-medium">{detail.slug}</span>.
        </p>

        <TaxonomyList orgs={detail.orgs} products={detail.products} />
      </div>
    </div>
  );
}
