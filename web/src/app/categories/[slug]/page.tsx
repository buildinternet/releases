import type { Metadata } from "next";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { categoryDisplayName, isValidCategory } from "@buildinternet/releases-core/categories";
import {
  api,
  ApiSetupError,
  type CategoryDetail,
  type CategoryReleasesResponse,
  type CollectionMemberOrg,
} from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { CollectionTimeline } from "@/components/collection-timeline";
import { TaxonomyList } from "@/components/taxonomy-list";

const getCategory = cache((slug: string) => api.categoryDetail(slug));
const getCategoryReleases = cache((slug: string) => api.categoryReleases(slug, { limit: 20 }));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  let detail: CategoryDetail | null = null;
  try {
    detail = await getCategory(slug);
  } catch {
    detail = null;
  }
  // Aliased URL: metadata sits on the canonical, not on the alias.
  if (!detail || !isValidCategory(detail.slug)) return { title: "Category" };
  const canonicalSlug = detail.slug;
  const title = detail.name ?? categoryDisplayName(canonicalSlug);
  const description =
    detail.description ??
    `Recent releases from organizations and products in the ${title} category.`;
  const url = `/categories/${canonicalSlug}`;
  return {
    title,
    description,
    openGraph: {
      type: "website",
      url,
      title: `${title} — releases.sh`,
      description,
    },
    twitter: {
      title: `${title} — releases.sh`,
      description,
    },
    alternates: {
      canonical: url,
      types: {
        "application/atom+xml": [{ url: `${url}.atom`, title: `${title} release notes` }],
      },
    },
  };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let detail: CategoryDetail;
  let releases: CategoryReleasesResponse;
  try {
    [detail, releases] = await Promise.all([getCategory(slug), getCategoryReleases(slug)]);
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

  // Alias redirect: the API 301s `/v1/categories/<alias>` to its canonical
  // sibling, and fetch() follows transparently — so a mismatch between the
  // path slug and the response slug means the user landed on an alias URL.
  // Bounce the browser to the canonical path so URL bars and shares stay
  // consistent.
  if (detail.slug !== slug) {
    redirect(`/categories/${detail.slug}`);
  }
  if (!isValidCategory(detail.slug)) notFound();

  const title = detail.name ?? categoryDisplayName(detail.slug);
  // The collections feed expects `CollectionMemberOrg` for chip rendering;
  // category detail returns the narrower `TaxonomyOrg` (no githubHandle /
  // description). Shim missing fields to `null` — OrgAvatar falls back to
  // initials when both avatarUrl and githubHandle are absent.
  const memberOrgs: CollectionMemberOrg[] = detail.orgs.map((o) => ({
    slug: o.slug,
    name: o.name,
    domain: o.domain,
    avatarUrl: o.avatarUrl,
    githubHandle: null,
    description: null,
  }));

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <Link href="/categories" className="hover:text-stone-600 dark:hover:text-stone-300">
            Categories
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{title}</span>
        </div>

        <h1 className="text-[34px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">
          {title}
        </h1>
        <p className="text-[15px] text-stone-500 dark:text-stone-400 mt-1">
          {detail.description ?? (
            <>
              Recent releases from organizations and products in the{" "}
              <span className="font-medium">{title}</span> category.
            </>
          )}
        </p>

        <div className="mt-7 pb-10">
          <CollectionTimeline
            key={slug}
            fetchEndpoint={`/api/category-releases/${slug}`}
            formatPath={`/categories/${slug}`}
            initialReleases={releases.releases}
            initialCursor={releases.pagination.nextCursor}
            orgs={memberOrgs}
          />
        </div>

        {(detail.orgs.length > 0 || detail.products.length > 0) && (
          <div className="border-t border-stone-200 dark:border-stone-800 pt-2">
            <TaxonomyList orgs={detail.orgs} products={detail.products} />
          </div>
        )}
      </div>
    </div>
  );
}
