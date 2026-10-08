import type { Metadata } from "next";
import Link from "next/link";
import { ApiSetupError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { SetupMessage } from "@/components/setup-message";
import { FollowButton } from "@/components/follow-button";
import { withReleaseBodyHtml, orgRowVariant } from "@/lib/render-release-body";
import { tryFetch } from "@/lib/ssr-fetch";
import { getOrg, getOrgOverview } from "@/app/[orgSlug]/_lib/org-data";
import { getOrgReleases } from "@/app/[orgSlug]/_lib/org-releases-data";
import { UpdatesBriefing } from "./updates-briefing";
import { UpdatesFeed } from "./updates-feed";
import { api } from "@/lib/api";
import { UPDATES_ORG_SLUG as ORG_SLUG } from "@/lib/updates-org";
import { ORG_FEED_PAGE_LIMIT, buildArchiveMonths, collectOrgFeed } from "./updates-logic";

const TITLE = "What's New";
const DESCRIPTION =
  "Everything shipped on Release Notes Index — published through our own registry.";

// The org release feed caps `?limit=` at 100 server-side (REST and GraphQL
// alike); requesting more than that is a no-op clamp, not a bigger page. The
// feed component follows `nextCursor` client-side to load anything beyond
// this first page — see the loading effect in `updates-feed.tsx`.
const FIRST_PAGE_LIMIT = 100;

// ISR: same window as org pages — regenerated on ingest, 24h backstop. Soft-fail GraphQL below so a deploy
// window (web before API / unknown persisted hash) doesn't fail the Next build
// the way a hard throw on a static route would (#2047).
export const revalidate = 86400;

export const metadata: Metadata = {
  // The root layout's title template appends the site name.
  title: TITLE,
  description: DESCRIPTION,
  alternates: {
    canonical: "/updates",
    types: {
      "application/atom+xml": [
        { url: `/${ORG_SLUG}.atom`, title: "Release Notes Index changelog" },
      ],
    },
  },
  openGraph: {
    title: `${TITLE} · Release Notes Index`,
    description: DESCRIPTION,
    url: "/updates",
    type: "website",
  },
  twitter: { title: `${TITLE} · Release Notes Index`, description: DESCRIPTION },
};

export default async function UpdatesPage() {
  // OrgPage + OrgReleases GraphQL (stable hashes) + thin overview REST.
  // Soft-fail like the homepage so prerender survives a PersistedQueryNotFound
  // deploy race; the page self-heals on the next revalidate.
  const [orgResult, releasesResult, overview] = await Promise.all([
    tryFetch(getOrg(ORG_SLUG), { route: "/updates", event: "updates-org-fetch-failed" }),
    tryFetch(getOrgReleases(ORG_SLUG, FIRST_PAGE_LIMIT), {
      route: "/updates",
      event: "updates-releases-fetch-failed",
    }),
    getOrgOverview(ORG_SLUG),
  ]);
  // Every day in the changelog, for the archive below the feed. Soft-fails to
  // an empty archive; the sitemap walks the same feed.
  const allReleases = await collectOrgFeed((cursor) =>
    api.orgReleases(ORG_SLUG, { limit: ORG_FEED_PAGE_LIMIT, cursor }),
  ).catch(() => []);

  if (orgResult.error instanceof ApiSetupError) {
    return (
      <div className="min-h-screen">
        <SetupMessage message={orgResult.error.message} steps={orgResult.error.setup} />
      </div>
    );
  }

  const org = orgResult.data;
  const initialReleases = releasesResult.data ?? { releases: [], nextCursor: null };

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${TITLE} — Release Notes Index`,
    url: "https://releases.sh/updates",
    description: DESCRIPTION,
  };

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-5xl px-6">
        <JsonLd data={jsonLd} />
        <header className="flex flex-col gap-4 border-b border-stone-200 pb-4 pt-8 sm:flex-row sm:items-end sm:justify-between dark:border-stone-800">
          <div className="min-w-0 flex-1">
            <h1 className="font-pixel text-[28px] text-stone-900 dark:text-stone-100">{TITLE}</h1>
            <p className="mt-1.5 max-w-[60ch] text-sm text-stone-500 dark:text-stone-400">
              {DESCRIPTION}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {org?.id && <FollowButton targetType="org" targetId={org.id} label={org.name} />}
            <Link
              href="/account/notifications"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-stone-300 px-3.5 text-[12.5px] font-medium text-stone-600 transition-colors hover:bg-stone-50 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="h-3.5 w-3.5"
              >
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M3 7l9 6 9-6" />
              </svg>
              Digest
            </Link>
            <a
              href={`/${ORG_SLUG}.atom`}
              title="Atom feed"
              aria-label="Atom feed"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 text-stone-600 transition-colors hover:bg-stone-50 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                aria-hidden
                className="h-[15px] w-[15px]"
              >
                <path d="M4 11a9 9 0 0 1 9 9" />
                <path d="M4 4a16 16 0 0 1 16 16" />
                <circle cx="5" cy="19" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </a>
          </div>
        </header>

        {overview && <UpdatesBriefing page={overview} />}

        <UpdatesFeed
          orgSlug={ORG_SLUG}
          initialReleases={withReleaseBodyHtml(initialReleases.releases, orgRowVariant)}
          initialCursor={initialReleases.nextCursor}
        />

        <UpdatesArchive
          months={buildArchiveMonths(
            allReleases.map((r) => r.publishedAt),
            initialReleases.releases.map((r) => r.publishedAt),
          )}
        />
      </div>
    </div>
  );
}

/**
 * Plain links to every older day page. The feed loads past its first page
 * client-side, so without this list those `/updates/<date>` pages have no
 * crawlable inbound link.
 */
function UpdatesArchive({ months }: { months: ReturnType<typeof buildArchiveMonths> }) {
  if (months.length === 0) return null;
  return (
    <section
      aria-labelledby="updates-archive"
      className="mt-12 border-t border-stone-200 pb-16 pt-6 dark:border-stone-800"
    >
      <h2
        id="updates-archive"
        className="text-[13px] font-medium text-stone-500 dark:text-stone-400"
      >
        Archive
      </h2>
      <div className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        {months.map((month) => (
          <div key={month.key}>
            <h3 className="text-[13px] font-medium text-stone-700 dark:text-stone-300">
              {month.label}
            </h3>
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px]">
              {month.days.map((day) => (
                <li key={day}>
                  <Link
                    href={`/updates/${day}`}
                    className="text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                  >
                    {day.slice(8)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
