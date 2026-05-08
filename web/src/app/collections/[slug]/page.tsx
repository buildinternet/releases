import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  api,
  ApiSetupError,
  type CollectionDetail,
  type CollectionReleasesResponse,
} from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { CollectionTimeline } from "@/components/collection-timeline";

const getCollection = cache((slug: string) => api.collectionDetail(slug));
const getCollectionReleases = cache((slug: string) => api.collectionReleases(slug, { limit: 20 }));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const detail = await getCollection(slug);
    return {
      title: detail.name,
      description:
        detail.description ?? `Releases from ${detail.orgs.map((o) => o.name).join(", ")}.`,
      alternates: {
        canonical: `/collections/${slug}`,
        types: {
          "application/atom+xml": [
            { url: `/collections/${slug}.atom`, title: `${detail.name} release notes` },
          ],
        },
      },
    };
  } catch {
    return { title: "Collection" };
  }
}

export default async function CollectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let detail: CollectionDetail;
  let releases: CollectionReleasesResponse;
  try {
    [detail, releases] = await Promise.all([getCollection(slug), getCollectionReleases(slug)]);
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
          <Link href="/collections" className="hover:text-stone-600 dark:hover:text-stone-300">
            Collections
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{detail.name}</span>
        </div>

        <h1 className="text-[34px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">
          {detail.name}
        </h1>
        {detail.description && (
          <p className="text-[15px] text-stone-500 dark:text-stone-400 mt-1">
            {detail.description}
          </p>
        )}

        <div className="mt-7 pb-10">
          <CollectionTimeline
            collectionSlug={slug}
            initialReleases={releases.releases}
            initialCursor={releases.pagination.nextCursor}
            orgs={detail.orgs}
          />
        </div>
      </div>
    </div>
  );
}
