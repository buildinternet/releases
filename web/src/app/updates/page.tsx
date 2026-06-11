import type { Metadata } from "next";
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { JsonLd } from "@/components/json-ld";
import { OverviewView } from "@/components/overview-view";
import { OrgReleaseList } from "@/components/org-release-list";
import { orgAvatarSrc } from "@/components/org-avatar";

// releases.sh publishes its own product changelog through its own registry.
// The `releases-sh` org is the canonical home; `/updates` is the branded face
// of it. Keep the slug here in sync with the seeded org (see
// docs/superpowers/specs/2026-06-10-self-published-changelog-design.md).
const ORG_SLUG = "releases-sh";
const TITLE = "What's New";
const DESCRIPTION =
  "Product updates and changelog for releases.sh — new features, fixes, and improvements, rolled up by day.";

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
  // The changelog feed itself (OrgReleaseList) is what users come here for, so
  // seed it server-side exactly like the org releases page does. The org
  // overview rides along as a short briefing above the feed.
  const [org, initialReleases] = await Promise.all([
    api.orgDetail(ORG_SLUG),
    api.orgReleases(ORG_SLUG),
  ]);

  const githubHandle = org.accounts?.find((a) => a.platform === "github")?.handle ?? null;
  const orgAvatarUrl = orgAvatarSrc(org.avatarUrl, githubHandle, 24);

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
      <div className="max-w-4xl mx-auto px-6">
        <JsonLd data={jsonLd} />
        <header className="pt-8 pb-4 border-b border-stone-200 dark:border-stone-800">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
            {TITLE}
          </h1>
          <p className="mt-1.5 max-w-[60ch] text-sm text-stone-500 dark:text-stone-400">
            {DESCRIPTION}
          </p>
        </header>
        {org.overview && (
          <div className="mt-5">
            <OverviewView page={org.overview} />
          </div>
        )}
        <div className="mt-5">
          <OrgReleaseList
            orgSlug={ORG_SLUG}
            initialReleases={initialReleases.releases}
            initialCursor={initialReleases.pagination.nextCursor}
            multipleSourcesExist={org.sources.length > 1}
            availableSourceTypes={Array.from(new Set(org.sources.map((s) => s.type)))}
            orgAvatarUrl={orgAvatarUrl}
            showRollupSummary
          />
        </div>
      </div>
    </div>
  );
}
