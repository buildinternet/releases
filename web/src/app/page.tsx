import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiSetupError, type CollectionListItem } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { graphqlRequest } from "@/lib/graphql/client";
import { HomepageTickerDocument } from "@/lib/graphql/__generated__/graphql";
import type { HomepageTickerQuery } from "@/lib/graphql/__generated__/graphql";
import { Header } from "@/components/header";
import { JsonLd } from "@/components/json-ld";
import { SetupMessage } from "@/components/setup-message";
import { OrgTable } from "@/components/org-table";
import { InstallStepsInline, InstallStepsSidebar } from "@/components/install-steps";
import { ShippingNowTicker } from "@/components/shipping-now-ticker";
import { TerminalSession, type TerminalBlock } from "@/components/terminal-session";
import {
  FeaturedCollections,
  FeaturedCollectionsCollapsible,
} from "@/components/featured-collections";

type TickerItem = HomepageTickerQuery["latestReleases"]["items"][number];

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/**
 * Curated `releases` CLI transcript shown in the home-page terminal demo.
 * Faithful to the live CLI: real commands, values, IDs, and AI summaries, so the
 * demo never invents a format the CLI doesn't actually print. Block 1 is a
 * cross-vendor `search` ("who shipped webhooks") whose hits carry a content
 * excerpt; block 2 drills into one of those hits by ID to show its record + AI
 * summary. The Humans view dims the `rel_…` handles the CLI prints; the Agents
 * view appends `--json` and shows the real structured payload (full content
 * included).
 *
 * Reflects the reworked CLI output (buildinternet/releases-cli#215, refined in
 * #222): `search` renders one aligned row per hit — identity (`Org/Source`, or
 * a package-qualified version) · title · relative age · dimmed `rel_…` — with a
 * cleaned one-line excerpt underneath, and `--json` returns the slim release
 * shape (nested `source`/`org`, derived `excerpt`, `contentChars`; storage
 * internals dropped). Block 2 drills into a hit: its `get` card names the owning
 * org, prints a human date, and labels the AI summary. The relative ages
 * ("1y", "3w") are a capture-time snapshot. Re-synced against releases-cli
 * v0.50.0: block 1 shows 3 representative hits from the `search` result set
 * (human + `--json`), trimmed for demo clarity; block 2's `get` matches live
 * stdout, omitting only the trailing "Next steps:" hint (it points at the
 * deprecated top-level `releases release get` alias). Block 3 is `releases get`
 * on an org coordinate — the release rows are space-aligned (the CLI uses tabs
 * which expand past the 83-char demo width) and dates are shortened to
 * YYYY-MM-DD; IDs and values are real. Edit here when refreshing.
 */
const DEMO_SESSION: TerminalBlock[] = [
  {
    command: 'releases search "webhooks" --type releases --limit 3',
    output: `Releases
Axiom/Changelog           Custom webhooks            1y  rel_YqORWhmpDZmlpyarFGtg0
                          Axiom introduces custom webhooks.
Google/API Release Notes  Webhooks Support Launched  3w  rel_vpnvlVinttqFUfgIlDlVZ
                          Event-driven webhooks support is now available in the Ge…
Resend Changelog          New Domain Webhooks        1y  rel_ieyxLxD5eFh5IWDxB-bLp
                          Receive real-time notifications when domains are created…

3 result(s) found.`,
    json: `{
  "query": "webhooks",
  "releases": [
    {
      "id": "rel_YqORWhmpDZmlpyarFGtg0",
      "title": "Custom webhooks",
      "summary": "Axiom introduces custom webhooks.",
      "excerpt": "Axiom introduces custom webhooks.",
      "publishedAt": "2024-07-22T00:00:00.000Z",
      "source": { "slug": "changelog", "name": "Changelog" },
      "org": { "slug": "axiom", "name": "Axiom" },
      "contentChars": 33
    },
    {
      "id": "rel_vpnvlVinttqFUfgIlDlVZ",
      "title": "Webhooks Support Launched",
      "summary": "Event-driven webhooks support is now available in the Gemini API, replacing polling workflows for the Batch API and long-running operations.",
      "excerpt": "Launched event-driven Webhooks support in the Gemini API to replace polling workflows for the Batch API and long-running operations.",
      "publishedAt": "2026-05-04T00:00:00.000Z",
      "source": { "slug": "api-release-notes", "name": "API Release Notes" },
      "org": { "slug": "google", "name": "Google" },
      "contentChars": 132
    },
    {
      "id": "rel_ieyxLxD5eFh5IWDxB-bLp",
      "title": "New Domain Webhooks",
      "summary": "Receive real-time notifications when domains are created, updated, or deleted.",
      "excerpt": "Receive real-time notifications when domains are created, updated, or deleted.",
      "publishedAt": "2024-11-22T00:00:00.000Z",
      "source": { "slug": "resend-changelog", "name": "Resend Changelog" },
      "org": { "slug": "resend", "name": "Resend" },
      "contentChars": 78
    }
  ],
  "mode": "hybrid",
  "degraded": false
}`,
  },
  {
    command: "releases get rel_vpnvlVinttqFUfgIlDlVZ",
    output: `Webhooks Support Launched
  ID:        rel_vpnvlVinttqFUfgIlDlVZ
  Org:       Google (google)
  Source:    API Release Notes (api-release-notes)
  Published: May 4, 2026
  URL:       https://ai.google.dev/gemini-api/docs/changelog#webhooks-support-launched
  Content:   132 chars (~24 tokens)

AI summary
Event-driven webhooks support is now available in the Gemini API, replacing polling workflows for the Batch API and long-running operations.`,
    json: `{
  "id": "rel_vpnvlVinttqFUfgIlDlVZ",
  "title": "Webhooks Support Launched",
  "summary": "Event-driven webhooks support is now available in the Gemini API, replacing polling workflows for the Batch API and long-running operations.",
  "excerpt": "Launched event-driven Webhooks support in the Gemini API to replace polling workflows for the Batch API and long-running operations.",
  "url": "https://ai.google.dev/gemini-api/docs/changelog#webhooks-support-launched",
  "publishedAt": "2026-05-04T00:00:00.000Z",
  "source": { "slug": "api-release-notes", "name": "API Release Notes" },
  "org": { "slug": "google", "name": "Google" },
  "contentChars": 132,
  "contentTokens": 24
}`,
  },
  {
    command: "releases get cursor",
    output: `Cursor (cursor)
  Domain:      cursor.com
  Category:    developer-tools
  Sources:     1 active

Latest 3 releases (most recent first):
rel_AFeJanUKy9UaqZK4BEKbQ  Shared Canvases                     2026-05-20
rel_5XLlX1ezHI4B18Zi7vBBk  Cursor in Jira                      2026-05-19
rel_T9JQ7UI6usAaYrKnI2Z2B  Full-screen Tabs and Compact Chats 2026-05-13`,
    json: `{
  "id": "org_keFBTgO7XcFJzGNl-g0W5",
  "slug": "cursor",
  "name": "Cursor",
  "domain": "cursor.com",
  "category": "developer-tools",
  "sourceCount": 1,
  "releaseCount": 53,
  "releasesLast30Days": 14,
  "releases": [
    {
      "id": "rel_AFeJanUKy9UaqZK4BEKbQ",
      "title": "Shared Canvases",
      "version": null,
      "publishedAt": "2026-05-20T00:00:00.000Z",
      "sourceName": "Cursor Changelog",
      "contentChars": 560
    },
    {
      "id": "rel_5XLlX1ezHI4B18Zi7vBBk",
      "title": "Cursor in Jira",
      "version": null,
      "publishedAt": "2026-05-19T00:00:00.000Z",
      "sourceName": "Cursor Changelog",
      "contentChars": 734
    },
    {
      "id": "rel_T9JQ7UI6usAaYrKnI2Z2B",
      "title": "Full-screen Tabs and Compact Chats",
      "version": null,
      "publishedAt": "2026-05-13T00:00:00.000Z",
      "sourceName": "Cursor Changelog",
      "contentChars": 2638
    }
  ]
}`,
  },
];

/**
 * `?empty=1` opts into orgs that are in the registry but have not produced any
 * indexed releases yet (#746). Default hides them — they're curator stubs from
 * in-flight discovery or broken parsers and look like noise on the catalog.
 * The toggle below the table labels itself with `meta.emptyOrgCount`.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ empty?: string }>;
}) {
  const { empty } = await searchParams;
  const includeEmpty = empty === "1";

  let stats: Awaited<ReturnType<typeof api.stats>> | undefined;
  let orgsResult: Awaited<ReturnType<typeof api.orgs>> | undefined;
  let latest: TickerItem[] = [];
  let featuredCollections: CollectionListItem[] = [];
  try {
    const [tickerResult, fetchedStats, fetchedOrgs, fetchedFeatured] = await Promise.all([
      tryFetch(graphqlRequest(HomepageTickerDocument, { limit: 40, exclude: ["github"] }), {
        route: "/",
        event: "homepage-ticker-fetch-failed",
      }),
      api.stats(),
      api.orgs({ includeEmpty }),
      // Promo block is non-essential — a collections hiccup must never break
      // the homepage, so degrade to an empty (hidden) block on failure.
      api.collections({ featured: true }).catch(() => [] as CollectionListItem[]),
    ]);
    stats = fetchedStats;
    orgsResult = fetchedOrgs;
    latest = tickerResult.data?.latestReleases.items ?? [];
    featuredCollections = fetchedFeatured;
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    throw err;
  }
  const orgs = orgsResult?.items ?? [];
  const emptyOrgCount = orgsResult?.emptyOrgCount ?? 0;

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": "https://releases.sh#website",
        name: "releases.sh",
        url: "https://releases.sh",
        description:
          "An agent-friendly API for product changelogs. A unified registry of product releases, available via CLI, API, or MCP.",
        publisher: { "@id": "https://releases.sh#org" },
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: "https://releases.sh/search?q={search_term_string}",
          },
          "query-input": "required name=search_term_string",
        },
      },
      {
        "@type": "Organization",
        "@id": "https://releases.sh#org",
        name: "releases.sh",
        url: "https://releases.sh",
        description: "An agent-friendly registry of product changelogs and release notes.",
      },
    ],
  };

  return (
    <div className="min-h-screen">
      <JsonLd data={jsonLd} />
      <Header />
      <div className="pt-12 pb-8 text-center px-6">
        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mb-2">
          An agent-friendly API for product changelogs.
        </h1>
        <p className="text-[15px] text-stone-500 dark:text-stone-400 mb-6">
          A unified registry of product releases, available via CLI, API, or MCP.
        </p>
        <div className="flex justify-center gap-8 text-[13px] text-stone-400 dark:text-stone-500">
          <span>
            <strong className="text-stone-600 dark:text-stone-300">{stats?.orgs ?? 0}</strong> orgs
          </span>
          <span>
            <strong className="text-stone-600 dark:text-stone-300">{stats?.sources ?? 0}</strong>{" "}
            sources
          </span>
          <span>
            <strong className="text-stone-600 dark:text-stone-300">
              {(stats?.releases ?? 0).toLocaleString()}
            </strong>{" "}
            releases
          </span>
        </div>
        <div className="mt-8 xl:hidden">
          <InstallStepsInline />
        </div>
      </div>
      {/* Illustrative CLI transcript. `data-nosnippet` keeps its example text and
          JSON out of search-result snippets so it doesn't skew the page's topic;
          the `aria-label` already frames it as an example for assistive tech. */}
      <div data-nosnippet className="max-w-3xl mx-auto px-6 pb-12">
        <TerminalSession
          blocks={DEMO_SESSION}
          maxHeight="20rem"
          animate
          ariaLabel="Example releases CLI session"
        />
      </div>
      {latest.length > 0 && <ShippingNowTicker releases={latest} />}
      <div className="max-w-[1240px] mx-auto px-6 pb-12 xl:grid xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-12">
        <aside className="hidden xl:block xl:order-2 xl:pt-2">
          <InstallStepsSidebar />
          <FeaturedCollections collections={featuredCollections} />
        </aside>
        <div className="xl:order-1 max-w-4xl xl:max-w-none w-full mx-auto">
          <FeaturedCollectionsCollapsible collections={featuredCollections} />
          {orgs.length > 0 && <OrgTable orgs={orgs} />}
          {emptyOrgCount > 0 && (
            <Link
              href={includeEmpty ? "/" : "/?empty=1"}
              className="mt-6 inline-block text-[12px] text-stone-400 dark:text-stone-500 underline decoration-stone-300 dark:decoration-stone-600 underline-offset-2 hover:text-stone-600 dark:hover:text-stone-300"
            >
              {includeEmpty
                ? "Hide empty orgs"
                : `Show ${emptyOrgCount} ${emptyOrgCount === 1 ? "org" : "orgs"} with no indexed releases yet`}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
