import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ApiSetupError, type CollectionDailySummary } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { SetupMessage } from "@/components/setup-message";
import { CollectionTimeline } from "@/components/collection-timeline";
import { CollectionContextRail } from "@/components/collection-context-rail";
import { CollectionAdminMenu } from "@/components/collection-admin-menu";
import { AdminOnly } from "@/components/admin-only";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { buildFeedPageJsonLd } from "@/lib/schema-org";
import { withCollectionReleaseView } from "@/lib/render-release-body";
import { getCollectionPage } from "./_lib/collection-data";
import { getLatestDigest } from "./digest/_lib/digest-data";

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
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    notFound();
  }

  const { detail, releases, summaries } = page;
  const latestDigest = await getLatestDigest(slug);
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

  const formatPath = `/collections/${slug}`;

  return (
    <div className="org-surface min-h-screen bg-[var(--page)] text-[var(--fg)]">
      <JsonLd data={jsonLd} />
      <div className="mx-auto max-w-[1300px] px-6">
        <div className="flex items-center gap-1.5 pt-5 text-[13px] text-[var(--fg-3)]">
          <Link href="/" className="transition-colors hover:text-[var(--fg-2)]">
            Home
          </Link>
          <span className="text-[var(--line-2)]">/</span>
          <Link href="/collections" className="transition-colors hover:text-[var(--fg-2)]">
            Collections
          </Link>
          <span className="text-[var(--line-2)]">/</span>
          <span className="text-[var(--fg-2)]">{detail.name}</span>
        </div>

        <h1 className="mt-4 text-balance text-[34px] font-bold tracking-tight text-[var(--fg)]">
          {detail.name}
        </h1>
        {detail.description && (
          <p className="mt-1 max-w-[65ch] text-pretty text-[15px] text-[var(--fg-2)]">
            {detail.description}
          </p>
        )}
        {latestDigest && (
          <Link
            href={`/collections/${slug}/digest/${latestDigest.weekStart}`}
            className="mt-2 inline-block text-[13px] text-[var(--fg-3)] transition-colors hover:text-[var(--fg-2)]"
            aria-label={`This week's digest: ${latestDigest.title}`}
          >
            This week: {latestDigest.title} →
          </Link>
        )}
        <AdminOnly devAdmin={isLocalAdminEnabled()}>
          <div className="mt-3">
            <CollectionAdminMenu slug={slug} isFeatured={detail.isFeatured} />
          </div>
        </AdminOnly>

        {/* Main feed + sticky context rail — same shell as the org page
            (`flex-col` → `md:flex-row`) so the rail stacks under the feed on
            mobile and sits sticky-aside on wide screens. */}
        <div className="flex flex-col gap-10 pb-24 pt-7 md:flex-row md:items-start">
          <main className="min-w-0 flex-1">
            <CollectionTimeline
              key={slug}
              fetchEndpoint={`/api/collection-releases/${slug}`}
              initialReleases={withCollectionReleaseView(releases.releases)}
              initialCursor={releases.pagination.nextCursor}
              members={detail.members}
              summaryByDate={summaryByDate}
            />
          </main>
          <CollectionContextRail
            formatPath={formatPath}
            report={{
              kind: "collection",
              name: detail.name,
              slug,
              path: formatPath,
            }}
          />
        </div>
      </div>
    </div>
  );
}
