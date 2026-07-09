import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ApiSetupError, type CollectionDailySummary } from "@/lib/api";
import { Header } from "@/components/header";
import { JsonLd } from "@/components/json-ld";
import { SetupMessage } from "@/components/setup-message";
import { CollectionTimeline } from "@/components/collection-timeline";
import { CollectionAdminMenu } from "@/components/collection-admin-menu";
import { AdminOnly } from "@/components/admin-only";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { buildFeedPageJsonLd } from "@/lib/schema-org";
import { withCollectionReleaseView } from "@/lib/render-release-body";
import { getCollectionPage } from "./_lib/collection-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const { detail } = await getCollectionPage(slug);
    return {
      // Tab/SEO title reads "What's new with <Collection> — releases.sh" (the
      // "— releases.sh" suffix comes from the root layout title template).
      title: `What's new with ${detail.name}`,
      description:
        detail.description ?? `Releases from ${detail.members.map((m) => m.name).join(", ")}.`,
      alternates: {
        canonical: `/collections/${slug}`,
        types: {
          "application/atom+xml": [
            { url: `/collections/${slug}.atom`, title: `${detail.name} release notes` },
          ],
        },
      },
      openGraph: { type: "website", url: `/collections/${slug}` },
    };
  } catch {
    return { title: "Collection" };
  }
}

export default async function CollectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let page;
  try {
    page = await getCollectionPage(slug);
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

  const { detail, releases, summaries } = page;
  // Empty when none exist (fail-soft, same as the prior REST `.catch` path).
  const summaryByDate = new Map<string, CollectionDailySummary>(summaries.map((s) => [s.date, s]));

  const collectionUrl = `https://releases.sh/collections/${slug}`;
  const jsonLd = buildFeedPageJsonLd(releases.releases, {
    pageUrl: collectionUrl,
    name: detail.name,
    description:
      detail.description ?? `Releases from ${detail.members.map((m) => m.name).join(", ")}.`,
    section: { name: "Collections", url: "https://releases.sh/collections" },
  });

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
          <Link href="/collections" className="hover:text-stone-600 dark:hover:text-stone-300">
            Collections
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{detail.name}</span>
        </div>

        <h1 className="text-[34px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4 text-balance">
          {detail.name}
        </h1>
        {detail.description && (
          <p className="text-[15px] text-stone-500 dark:text-stone-400 mt-1 text-pretty">
            {detail.description}
          </p>
        )}
        <AdminOnly devAdmin={isLocalAdminEnabled()}>
          <div className="mt-3">
            <CollectionAdminMenu slug={slug} isFeatured={detail.isFeatured} />
          </div>
        </AdminOnly>

        <div className="mt-7 pb-10">
          <CollectionTimeline
            key={slug}
            fetchEndpoint={`/api/collection-releases/${slug}`}
            formatPath={`/collections/${slug}`}
            initialReleases={withCollectionReleaseView(releases.releases)}
            initialCursor={releases.pagination.nextCursor}
            members={detail.members}
            summaryByDate={summaryByDate}
          />
        </div>
      </div>
    </div>
  );
}
