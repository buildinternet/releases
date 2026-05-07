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
import { OrgAvatar } from "@/components/org-avatar";
import { CollectionReleaseList } from "@/components/collection-release-list";

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
      alternates: { canonical: `/collections/${slug}` },
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
          <span className="text-stone-400 dark:text-stone-500">Collections</span>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{detail.name}</span>
        </div>

        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">
          {detail.name}
        </h1>
        {detail.description && (
          <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">{detail.description}</p>
        )}

        {detail.orgs.length > 0 && (
          <div className="mt-5">
            <div className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 mb-2">
              {detail.orgs.length} {detail.orgs.length === 1 ? "organization" : "organizations"}
            </div>
            <div className="flex flex-wrap gap-2">
              {detail.orgs.map((org) => (
                <Link
                  key={org.slug}
                  href={`/${org.slug}`}
                  className="flex items-center gap-2 pl-1 pr-3 py-1 rounded-full border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 hover:border-stone-300 dark:hover:border-stone-700 transition-colors"
                >
                  <OrgAvatar
                    avatarUrl={org.avatarUrl}
                    githubHandle={null}
                    name={org.name}
                    size={20}
                  />
                  <span className="text-[13px] text-stone-700 dark:text-stone-200 font-medium">
                    {org.name}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8">
          <CollectionReleaseList
            collectionSlug={slug}
            initialReleases={releases.releases}
            initialCursor={releases.pagination.nextCursor}
          />
        </div>
      </div>
    </div>
  );
}
