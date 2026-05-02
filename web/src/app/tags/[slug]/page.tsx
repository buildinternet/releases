import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { api, ApiSetupError, type TagDetail } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { TaxonomyList } from "@/components/taxonomy-list";

const getTag = cache((slug: string) => api.tagDetail(slug));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const tag = await getTag(slug);
    return {
      title: tag.name,
      description: `Organizations and products tagged ${tag.name}`,
      alternates: { canonical: `/tags/${slug}` },
    };
  } catch {
    return { title: slug };
  }
}

export default async function TagPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let detail: TagDetail;
  try {
    detail = await getTag(slug);
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

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-400 dark:text-stone-500">Tags</span>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{detail.name}</span>
        </div>

        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">
          {detail.name}
        </h1>
        <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
          Organizations and products tagged <span className="font-medium">{detail.name}</span>.
        </p>

        <TaxonomyList orgs={detail.orgs} products={detail.products} />
      </div>
    </div>
  );
}
