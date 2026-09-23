import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { etDayKey, etWeekStart } from "@buildinternet/releases-core/dates";
import { api, ApiSetupError, type CollectionDailySummary } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { SetupMessage } from "@/components/setup-message";
import { CollectionTimeline } from "@/components/collection-timeline";
import { CollectionContextRail } from "@/components/collection-context-rail";
import { LatestDigestHero } from "@/components/latest-digest-hero";
import { CollectionAdminMenu } from "@/components/collection-admin-menu";
import { AdminOnly } from "@/components/admin-only";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { buildFeedPageJsonLd } from "@/lib/schema-org";
import { withCollectionReleaseView } from "@/lib/render-release-body";
import { getCollectionPage } from "./_lib/collection-data";
import { getRecentDigests } from "./digest/_lib/digest-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const { detail } = await getCollectionPage(slug);
    return {
      // Tab/SEO title reads "What's new with <Collection> — Releases Index" (the
      // "— Releases Index" suffix comes from the root layout title template).
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

  // One list fetch for header teaser + rail (React `cache`; fails soft to []).
  const recentDigestsPromise = getRecentDigests(slug);
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
  const recentDigests = await recentDigestsPromise;
  const latestDigest = recentDigests[0] ?? null;
  // Fails soft to `null` — a hiccup fetching the full digest body/sections
  // just drops the hero, same fail-soft posture as `getRecentDigests`.
  const latestDigestDetail = latestDigest
    ? await api.collectionWeeklyDigest(slug, latestDigest.weekStart).catch(() => null)
    : null;
  // Empty when none exist (fail-soft, same as the prior REST `.catch` path).
  const summaryByDate = new Map<string, CollectionDailySummary>(summaries.map((s) => [s.date, s]));
  const digestsByWeek = new Map(recentDigests.map((d) => [d.weekStart, d]));
  // Computed once here (not with `new Date()` inside the client component) so
  // the feed's "in progress" week divider agrees between SSR and hydration.
  const currentWeekStart = etWeekStart(etDayKey(new Date()));

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
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 pt-5 text-[13px] text-[var(--fg-3)]"
        >
          <Link href="/" className="transition-colors hover:text-[var(--fg-2)]">
            Home
          </Link>
          <span className="text-[var(--line-2)]" aria-hidden>
            /
          </span>
          <Link href="/collections" className="transition-colors hover:text-[var(--fg-2)]">
            Collections
          </Link>
        </nav>

        <h1 className="mt-4 text-balance text-[34px] font-bold tracking-tight text-[var(--fg)]">
          {detail.name}
        </h1>
        {detail.description && (
          <p className="mt-1 max-w-[65ch] text-pretty text-[15px] text-[var(--fg-2)]">
            {detail.description}
          </p>
        )}
        {latestDigestDetail && (
          <LatestDigestHero
            slug={slug}
            digest={latestDigestDetail}
            earlier={recentDigests.slice(1, 3)}
          />
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
              digestFeed={{
                byWeek: digestsByWeek,
                heroWeekStart: latestDigest?.weekStart ?? null,
                basePath: `/collections/${slug}/digest`,
                currentWeekStart,
              }}
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
