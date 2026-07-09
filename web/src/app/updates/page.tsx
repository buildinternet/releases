import type { Metadata } from "next";
import { ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { JsonLd } from "@/components/json-ld";
import { OverviewView } from "@/components/overview-view";
import { OrgReleaseList } from "@/components/org-release-list";
import { SetupMessage } from "@/components/setup-message";
import { withReleaseBodyHtml, orgRowVariant } from "@/lib/render-release-body";
import { orgAvatarSrc } from "@/components/org-avatar";
import { tryFetch } from "@/lib/ssr-fetch";
import { getOrg, getOrgOverview } from "@/app/[orgSlug]/_lib/org-data";
import { getOrgReleases } from "@/app/[orgSlug]/_lib/org-releases-data";

// releases.sh publishes its own product changelog through its own registry.
// The `releases-sh` org is the canonical home; `/updates` is the branded face
// of it. Keep the slug here in sync with the seeded org (see
// docs/superpowers/specs/2026-06-10-self-published-changelog-design.md).
const ORG_SLUG = "releases-sh";
const TITLE = "What's New";
const DESCRIPTION =
  "Product updates and changelog for releases.sh — new features, fixes, and improvements, rolled up by day.";

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
    tryFetch(getOrgReleases(ORG_SLUG), {
      route: "/updates",
      event: "updates-releases-fetch-failed",
    }),
    getOrgOverview(ORG_SLUG),
  ]);

  if (orgResult.error instanceof ApiSetupError) {
    return (
      <div className="min-h-screen">
        <Header />
        <SetupMessage message={orgResult.error.message} steps={orgResult.error.setup} />
      </div>
    );
  }

  const org = orgResult.data;
  const initialReleases = releasesResult.data ?? { releases: [], nextCursor: null };

  const githubHandle = org?.accounts?.find((a) => a.platform === "github")?.handle ?? null;
  const orgAvatarUrl = org ? orgAvatarSrc(org.avatarUrl, githubHandle, 24) : undefined;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${TITLE} — releases.sh`,
    url: "https://releases.sh/updates",
    description: DESCRIPTION,
  };

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto px-6">
        <JsonLd data={jsonLd} />
        <header className="pt-8 pb-4 border-b border-stone-200 dark:border-stone-800">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
            {TITLE}
          </h1>
          <p className="mt-1.5 max-w-[60ch] text-sm text-stone-500 dark:text-stone-400">
            {DESCRIPTION}
          </p>
        </header>
        {overview && (
          <div className="mt-5">
            <OverviewView page={overview} />
          </div>
        )}
        <div className="mt-5">
          <OrgReleaseList
            orgSlug={ORG_SLUG}
            initialReleases={withReleaseBodyHtml(initialReleases.releases, orgRowVariant)}
            initialCursor={initialReleases.nextCursor}
            multipleSourcesExist={(org?.sources.length ?? 0) > 1}
            hideSourceByline
            availableSourceTypes={Array.from(new Set((org?.sources ?? []).map((s) => s.type)))}
            orgAvatarUrl={orgAvatarUrl}
            showRollupSummary
          />
        </div>
      </div>
    </div>
  );
}
