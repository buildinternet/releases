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

// releases.sh publishes its own product changelog through its own registry.
// The `releases-sh` org is the canonical home; `/updates` is the branded face
// of it. Keep the slug here in sync with the seeded org (see
// docs/superpowers/specs/2026-06-10-self-published-changelog-design.md).
const ORG_SLUG = "releases-sh";
const TITLE = "What's New";
const DESCRIPTION = "Everything shipped on releases.sh — published through our own registry.";

// The org release feed caps `?limit=` at 100 server-side (REST and GraphQL
// alike); requesting more than that is a no-op clamp, not a bigger page. The
// feed component follows `nextCursor` client-side to load anything beyond
// this first page — see the loading effect in `updates-feed.tsx`.
const FIRST_PAGE_LIMIT = 100;

// ISR: same 15 min window as org pages. Soft-fail GraphQL below so a deploy
// window (web before API / unknown persisted hash) doesn't fail the Next build
// the way a hard throw on a static route would (#2047).
export const revalidate = 900;

export const metadata: Metadata = {
  title: `${TITLE} · releases.sh`,
  description: DESCRIPTION,
  alternates: {
    canonical: "/updates",
    types: {
      "application/atom+xml": [{ url: `/${ORG_SLUG}.atom`, title: "releases.sh changelog" }],
    },
  },
  openGraph: {
    title: `${TITLE} · releases.sh`,
    description: DESCRIPTION,
    url: "/updates",
    type: "website",
  },
  twitter: { title: `${TITLE} · releases.sh`, description: DESCRIPTION },
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
    name: `${TITLE} — releases.sh`,
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
      </div>
    </div>
  );
}
