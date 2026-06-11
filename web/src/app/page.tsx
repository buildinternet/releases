import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiSetupError, type CollectionListItem } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { graphqlRequest } from "@/lib/graphql/client";
import { HomepageTickerDocument } from "@/lib/graphql/__generated__/graphql";
import type { HomepageTickerQuery } from "@/lib/graphql/__generated__/graphql";
import { ConveyorBackdrop } from "@/components/conveyor-backdrop";
import { Header } from "@/components/header";
import { SiteNotice } from "@/components/site-notice";
import { JsonLd } from "@/components/json-ld";
import { SetupMessage } from "@/components/setup-message";
import { OrgTable } from "@/components/org-table";
import { InstallStepsInline, InstallStepsSidebar } from "@/components/install-steps";
import { ShippingNowTicker } from "@/components/shipping-now-ticker";
import { TerminalSession, type TerminalTab } from "@/components/terminal-session";
import {
  FeaturedCollections,
  FeaturedCollectionsCollapsible,
} from "@/components/featured-collections";

type TickerItem = HomepageTickerQuery["latestReleases"]["items"][number];

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/**
 * Curated `releases` CLI transcripts behind the home-page demo's use-case tabs.
 * Faithful to the live CLI: real commands, values, IDs, and AI summaries — the
 * demo never invents a format the CLI doesn't actually print. Each tab is a
 * distinct workflow; the Humans view dims the `rel_…` handles, the Agents view
 * appends `--json` and shows the structured payload (slimmed to the essential
 * fields for demo clarity, the way the CLI's own `--json` drops storage
 * internals).
 *
 * Search leads (the default open tab): it shows the richest story — cross-vendor
 * results with AI-summary snippets, then a `get rel_…` drill-in — and the tabs
 * narrow from many vendors, to one company, to one product:
 *
 *  - "Search across vendors" — cross-vendor `search "webhooks"` then a `get
 *    rel_…` drill-in into one hit (record + AI summary). The relative ages
 *    ("1y", "3w") are a capture-time snapshot.
 *  - "Track a company" — `releases get <org>` (Vercel): an org's activity across
 *    its six sources and two products, showing the company-vs-product contrast.
 *  - "Check product updates" — `releases get <product>` (Cursor): one product's
 *    latest releases as descriptive feature titles, not version tags; the full
 *    AI summary + token counts surface in the Agents view. Release rows are
 *    space-aligned and dates shortened to YYYY-MM-DD (the CLI uses tabs that
 *    expand past the 83-char demo width).
 *
 * Re-capture the get-based tabs (company + product) with the `releases` CLI when
 * refreshing so the format never drifts from real stdout.
 */
const DEMO_TABS: TerminalTab[] = [
  {
    id: "search",
    label: "Search across vendors",
    blocks: [
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
    ],
  },
  {
    id: "company",
    label: "Track a company",
    blocks: [
      {
        command: "releases get vercel",
        output: `Vercel (vercel)
  Domain:      vercel.com
  Category:    cloud
  Sources:     6 active
  Products:    Next.js (nextjs), Turborepo (turborepo)

Latest 3 releases (most recent first):
rel_f-_EUoCYDOCIvAdk4u7KR  ai@6.0.193              2026-05-28
rel_34oH4s7v1BkhjJG4Nmb7X  @vercel/python@6.44.0   2026-05-28
rel_sWKjqqfAsQYbLkeAKgDno  @vercel/express@0.1.94  2026-05-28`,
        json: `{
  "id": "org_qsyZSlC_PRGFDYIGsMfzp",
  "slug": "vercel",
  "name": "Vercel",
  "domain": "vercel.com",
  "category": "cloud",
  "sourceCount": 6,
  "releaseCount": 4690,
  "releasesLast30Days": 1898,
  "products": [
    { "slug": "nextjs", "name": "Next.js" },
    { "slug": "turborepo", "name": "Turborepo" }
  ],
  "releases": [
    {
      "id": "rel_f-_EUoCYDOCIvAdk4u7KR",
      "title": "ai@6.0.193",
      "version": "ai@6.0.193",
      "publishedAt": "2026-05-28T23:37:36.000Z",
      "sourceName": "AI SDK"
    },
    {
      "id": "rel_34oH4s7v1BkhjJG4Nmb7X",
      "title": "@vercel/python@6.44.0",
      "version": "@vercel/python@6.44.0",
      "publishedAt": "2026-05-28T23:01:15.000Z",
      "sourceName": "Vercel CLI"
    },
    {
      "id": "rel_sWKjqqfAsQYbLkeAKgDno",
      "title": "@vercel/express@0.1.94",
      "version": "@vercel/express@0.1.94",
      "publishedAt": "2026-05-28T23:00:48.000Z",
      "sourceName": "Vercel CLI"
    }
  ]
}`,
      },
    ],
  },
  {
    id: "product",
    label: "Check product updates",
    blocks: [
      {
        command: "releases get cursor",
        output: `Cursor (cursor)
  Domain:      cursor.com
  Category:    developer-tools
  About:       AI-powered code editor built on VS Code
  Sources:     1 active
  Collections: Coding Agents (coding-agents)

Latest 3 releases (most recent first):
rel_mKKH2T7nzFN0UuOLVYB86  Canvas Design Mode and Context Usage Report  2026-06-04
rel_vBsY33fzVojgOdvcTDPui  Organizations for Cursor Enterprise          2026-06-03
rel_CKUKVIG-gOOnIpjk0uC_x  Auto-review Run Mode                         2026-05-29`,
        json: `{
  "id": "org_keFBTgO7XcFJzGNl-g0W5",
  "slug": "cursor",
  "name": "Cursor",
  "domain": "cursor.com",
  "category": "developer-tools",
  "sourceCount": 1,
  "releaseCount": 56,
  "releasesLast30Days": 12,
  "releases": [
    {
      "id": "rel_mKKH2T7nzFN0UuOLVYB86",
      "title": "Canvas Design Mode and Context Usage Report",
      "summary": "Design Mode is now available in canvases, allowing you to select and annotate UI elements directly to guide Cursor's edits. Cursor can now show your agent's context usage as an interactive report in a canvas, breaking down where tokens go across the system prompt, tool definitions, rules, and skills.",
      "publishedAt": "2026-06-04T00:00:00.000Z",
      "sourceName": "Cursor Changelog",
      "contentTokens": 330
    },
    {
      "id": "rel_vBsY33fzVojgOdvcTDPui",
      "title": "Organizations for Cursor Enterprise",
      "summary": "Enterprise customers can now manage multiple Cursor teams under a single organization, with separate security, governance, budget, and feature controls per team. Organizations provide unified spend and token usage rollup, IDP management at the organization level, and per-team or per-group model access and spend limits. Users can belong to multiple teams with different roles in each, and admins can move users between teams via dashboard, API, or CSV.",
      "publishedAt": "2026-06-03T00:00:00.000Z",
      "sourceName": "Cursor Changelog",
      "contentTokens": 410
    },
    {
      "id": "rel_CKUKVIG-gOOnIpjk0uC_x",
      "title": "Auto-review Run Mode",
      "summary": "Auto-review is a new run mode that applies to Shell, MCP, and Fetch tool calls. Allowlisted calls run immediately, sandboxed calls execute in isolation, and remaining actions go to a classifier subagent that decides whether to allow, retry, or ask for approval. Configure it in Settings > Cursor Settings > Agents > Run Mode.",
      "publishedAt": "2026-05-29T00:00:00.000Z",
      "sourceName": "Cursor Changelog",
      "contentTokens": 136
    }
  ]
}`,
      },
    ],
  },
];

export default async function HomePage() {
  let stats: Awaited<ReturnType<typeof api.stats>> | undefined;
  let orgsForTable: Awaited<ReturnType<typeof api.orgs>>["items"] = [];
  let latest: TickerItem[] = [];
  let featuredCollections: CollectionListItem[] = [];
  try {
    const [tickerResult, fetchedStats, featuredOrgsResult, fetchedFeatured] = await Promise.all([
      tryFetch(graphqlRequest(HomepageTickerDocument, { limit: 40, exclude: ["github"] }), {
        route: "/",
        event: "homepage-ticker-fetch-failed",
      }),
      api.stats(),
      api.orgs({ featured: true }),
      // Promo block is non-essential — a collections hiccup must never break
      // the homepage, so degrade to an empty (hidden) block on failure.
      api.collections({ featured: true }).catch(() => [] as CollectionListItem[]),
    ]);
    stats = fetchedStats;
    latest = tickerResult.data?.latestReleases.items ?? [];
    featuredCollections = fetchedFeatured;

    // Fallback: if no orgs have been editorially featured yet (true on first
    // deploy), fall back to the regular org list so the home page never renders
    // a blank table. Once orgs are curated via PATCH /v1/orgs/:slug { featured:
    // true } this branch will stop executing.
    if (featuredOrgsResult.items.length > 0) {
      orgsForTable = featuredOrgsResult.items;
    } else {
      const allOrgsResult = await api.orgs({ includeEmpty: false });
      orgsForTable = allOrgsResult.items;
    }
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

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": "https://releases.sh#website",
        name: "releases.sh",
        url: "https://releases.sh",
        description:
          "The latest product releases, indexed for agents. Releases is a registry of release notes from across the web, queryable from your terminal, code, or MCP client.",
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
        description:
          "A registry of release notes from across the web, indexed for agents and queryable from your terminal, code, or MCP client.",
      },
    ],
  };

  return (
    <div className="min-h-screen">
      <JsonLd data={jsonLd} />
      {/* Masthead band: the animated "advancing blocks" backdrop is confined to
          this top region — `position: absolute` inside a `relative` wrapper, so
          it fills only the nav + hero rather than the whole viewport. The nav and
          hero text sit in a `relative z-10` layer above the (transparent) canvas.
          No `overflow-hidden`: the canvas self-clips to its own box, and clipping
          here would cut off the header's search / mobile-nav dropdowns. */}
      <div className="relative">
        <ConveyorBackdrop style={{ position: "absolute" }} />
        <div className="relative z-10">
          <Header />
          <div className="pt-12 pb-8 text-center px-6">
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mb-2">
              The latest product releases, indexed for agents
            </h1>
            <p className="text-[15px] text-stone-500 dark:text-stone-400 mb-6">
              Releases is a registry of release notes from across the web, queryable from your
              terminal, code, or MCP client.
            </p>
            <div className="flex justify-center gap-8 text-[13px] text-stone-400 dark:text-stone-500">
              <span>
                <strong className="text-stone-600 dark:text-stone-300">{stats?.orgs ?? 0}</strong>{" "}
                orgs
              </span>
              <span>
                <strong className="text-stone-600 dark:text-stone-300">
                  {stats?.sources ?? 0}
                </strong>{" "}
                sources
              </span>
              <span>
                <strong className="text-stone-600 dark:text-stone-300">
                  {(stats?.releases ?? 0).toLocaleString()}
                </strong>{" "}
                releases
              </span>
            </div>
          </div>
        </div>
      </div>
      {/* Home-only site notice (card placement). Renders nothing unless an
          active notice is set to placement "home". */}
      <div className="px-6 pt-6">
        <SiteNotice slot="home" />
      </div>
      {/* "Get Started" install widget — kept below the animated masthead band so
          its faint label and tab text retain full contrast (no blocks behind it).
          On xl the same content renders in the sidebar instead. */}
      <div className="px-6 pb-8 xl:hidden">
        <InstallStepsInline />
      </div>
      {/* Illustrative CLI transcript. `data-nosnippet` keeps its example text and
          JSON out of search-result snippets so it doesn't skew the page's topic;
          the `aria-label` already frames it as an example for assistive tech. */}
      <div data-nosnippet className="max-w-3xl mx-auto px-6 pb-12">
        <TerminalSession
          tabs={DEMO_TABS}
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
          {orgsForTable.length > 0 && <OrgTable orgs={orgsForTable} />}
          <Link
            href="/catalog"
            className="mt-6 inline-block text-[12px] text-stone-400 dark:text-stone-500 underline decoration-stone-300 dark:decoration-stone-600 underline-offset-2 hover:text-stone-600 dark:hover:text-stone-300"
          >
            Browse all {stats?.orgs ?? 0} orgs →
          </Link>
        </div>
      </div>
    </div>
  );
}
