import type { Metadata } from "next";
import Link from "next/link";
import { DEFAULT_PAGE_SIZE } from "@buildinternet/releases-core/cli-contracts";
import { ApiSetupError } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { graphqlRequest } from "@/lib/graphql/client";
import {
  HomepageTickerDocument,
  HomepageOrgsStatsDocument,
  HomepageAllOrgsDocument,
  HomepageCollectionsDocument,
} from "@/lib/graphql/__generated__/graphql";
import type {
  HomepageTickerQuery,
  HomepageOrgsStatsQuery,
  HomepageCollectionsQuery,
} from "@/lib/graphql/__generated__/graphql";
import { ConveyorBackdrop } from "@/components/conveyor-backdrop";
import { SiteNotice } from "@/components/site-notice";
import { JsonLd } from "@/components/json-ld";
import { SetupMessage } from "@/components/setup-message";
import { OrgTable } from "@/components/org-table";
import { InstallStepsInline, InstallStepsSidebar } from "@/components/install-steps";
import { ShippingNowTicker } from "@/components/shipping-now-ticker";
import { TerminalSession, type TerminalTab } from "@/components/terminal-session";
import { SignupCta } from "@/components/signup-cta";
import { AgentUseCases, AgentUseCasesJumpLink } from "@/components/agent-use-cases";
import { formatStars } from "@/lib/format-stars";
import {
  FeaturedCollections,
  FeaturedCollectionsCollapsible,
  type HomeCollectionListItem,
} from "@/components/featured-collections";
import type { OrgListItem } from "@/components/org-table";

type TickerItem = HomepageTickerQuery["latestReleases"]["items"][number];

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { type: "website", url: "/" },
};

/**
 * Curated `releases` CLI transcripts behind the home-page demo's use-case tabs.
 * Tabs are framed as the jobs a team would bring to the registry — questions,
 * not command names. Commands and flags are real (`releases search --since 90d`
 * etc. all exist); outputs are curated demo captures that keep the CLI's shape
 * (aligned columns, result-count footer, dimmed `rel_…` handles) while trimming
 * to the rows and fields that tell the story — the goal is communicating what
 * the registry answers, not reproducing every byte of stdout. The Agents view
 * appends `--json` and shows a slimmed structured payload the same way.
 *
 * "What should we build next?" leads: a cross-vendor trend query is the
 * strongest agent-native story (roadmap input, not a news digest). Then:
 *
 *  - "What shipped this week?" — `releases tail --since 7d`: the firehose,
 *    scoped to a week, teasing `follow`/`feed` as the stack-scoped version.
 *  - "Watch a vendor" — `releases get vercel` (real capture: org → sources →
 *    products → latest) then `releases follow vercel`.
 *  - "Who integrates with us?" — the same search pointed inward: other vendors
 *    shipping integrations *with* your product, mapped from their changelogs.
 *
 * Relative ages are a capture-time snapshot; re-check column alignment when
 * editing rows (space-aligned, ~84-char demo width).
 */
const DEMO_TABS: TerminalTab[] = [
  {
    id: "build-next",
    label: "What should we build next?",
    blocks: [
      {
        command: 'releases search "mcp" --kind tool --since 90d --limit 4',
        output: `Linear             Enterprise MCP access, shareable filtered views  2d
Devin / Cognition  MCP read-only mode for compliance-bound teams    2d
Sentry             MCP server monitoring goes GA                    3w
Figma              Design context over MCP for coding agents        5w

4 of 23 results — 23 tools shipped MCP features in the last 90 days.`,
        json: `{
  "query": "mcp",
  "kind": "tool",
  "since": "90d",
  "total": 23,
  "releases": [
    {
      "org": { "slug": "linear", "name": "Linear" },
      "title": "Enterprise MCP access, shareable filtered views",
      "summary": "Enterprise workspaces get MCP access controls, and any filtered view can now be shared with a link.",
      "publishedAt": "2026-07-07T00:00:00.000Z"
    },
    {
      "org": { "slug": "cognition", "name": "Cognition" },
      "product": { "slug": "devin", "name": "Devin" },
      "title": "MCP read-only mode for compliance-bound teams",
      "summary": "Devin's MCP server adds a read-only mode so compliance-bound teams can expose context without granting write access.",
      "publishedAt": "2026-07-07T00:00:00.000Z"
    },
    {
      "org": { "slug": "sentry", "name": "Sentry" },
      "title": "MCP server monitoring goes GA",
      "summary": "Monitor MCP server health, tool-call latency, and error rates in production.",
      "publishedAt": "2026-06-18T00:00:00.000Z"
    },
    {
      "org": { "slug": "figma", "name": "Figma" },
      "title": "Design context over MCP for coding agents",
      "summary": "Coding agents can pull design context straight from Figma files over MCP.",
      "publishedAt": "2026-06-03T00:00:00.000Z"
    }
  ],
  "mode": "hybrid"
}`,
      },
    ],
  },
  {
    id: "shipped-week",
    label: "What shipped this week?",
    blocks: [
      {
        command: "releases tail --since 7d --limit 4",
        output: `Claude Code / Anthropic  Sonnet 5 session reminders no longer use system role  21h
Workspace / Google       Full Gemini presentations; Drive AI on mobile          1d
Linear                   Initiative properties and enterprise MCP access        2d
Devin / Cognition        Slack thread sync and PR ratio analytics               2d

4 releases across 4 orgs in the last 7 days.`,
        json: `{
  "since": "7d",
  "releases": [
    {
      "org": { "slug": "anthropic", "name": "Anthropic" },
      "source": { "slug": "claude-code", "name": "Claude Code" },
      "title": "Sonnet 5 session reminders no longer use system role",
      "version": "v2.1.201",
      "publishedAt": "2026-07-08T14:00:00.000Z"
    },
    {
      "org": { "slug": "google", "name": "Google" },
      "source": { "slug": "workspace-updates", "name": "Workspace Updates" },
      "title": "Full Gemini presentations; Drive AI on mobile",
      "publishedAt": "2026-07-08T00:00:00.000Z"
    },
    {
      "org": { "slug": "linear", "name": "Linear" },
      "source": { "slug": "linear-changelog", "name": "Linear Changelog" },
      "title": "Initiative properties and enterprise MCP access",
      "publishedAt": "2026-07-07T00:00:00.000Z"
    },
    {
      "org": { "slug": "cognition", "name": "Cognition" },
      "source": { "slug": "devin-release-notes", "name": "Devin Release Notes" },
      "title": "Slack thread sync and PR ratio analytics",
      "publishedAt": "2026-07-07T00:00:00.000Z"
    }
  ]
}`,
      },
    ],
  },
  {
    id: "watch-vendor",
    label: "Watch a vendor",
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
      {
        command: "releases follow vercel",
        output: `Following Vercel (org).`,
        json: `{
  "followed": true,
  "target": {
    "targetType": "org",
    "targetId": "org_qsyZSlC_PRGFDYIGsMfzp",
    "label": "Vercel"
  }
}`,
      },
    ],
  },
  {
    id: "integrations",
    label: "Who integrates with us?",
    blocks: [
      {
        command: 'releases search "linear integration" --since 6m --limit 3',
        output: `Sentry   Two-way Linear issue sync leaves beta     1w
Raycast  Linear extension adds a triage view       4w
PostHog  Send session replays to Linear issues     2m

3 of 11 results — 11 products shipped Linear integrations in the last 6 months.`,
        json: `{
  "query": "linear integration",
  "since": "6m",
  "total": 11,
  "releases": [
    {
      "org": { "slug": "sentry", "name": "Sentry" },
      "title": "Two-way Linear issue sync leaves beta",
      "summary": "Sentry issues and Linear tickets now stay in sync in both directions, including status and assignee.",
      "publishedAt": "2026-07-02T00:00:00.000Z"
    },
    {
      "org": { "slug": "raycast", "name": "Raycast" },
      "title": "Linear extension adds a triage view",
      "summary": "Triage incoming Linear issues from Raycast without opening the app.",
      "publishedAt": "2026-06-11T00:00:00.000Z"
    },
    {
      "org": { "slug": "posthog", "name": "PostHog" },
      "title": "Send session replays to Linear issues",
      "summary": "Attach a session replay to a Linear issue straight from PostHog.",
      "publishedAt": "2026-05-08T00:00:00.000Z"
    }
  ],
  "mode": "hybrid"
}`,
      },
    ],
  },
];

export default async function HomePage() {
  let stats: HomepageOrgsStatsQuery["stats"] | undefined;
  let orgsForTable: OrgListItem[] = [];
  let latest: TickerItem[] = [];
  let featuredCollections: HomeCollectionListItem[] = [];
  try {
    // `orgsAndStats` folds stats + the featured-orgs page into one persisted
    // operation: in the REST version these two calls already shared fate
    // (both were plain `await`s in the same `Promise.all`, no independent
    // `.catch`), so combining them preserves behavior while cutting a round
    // trip. Ticker and collections keep their own operations — ticker
    // degrades via `tryFetch` (empty ticker, page still renders) and
    // collections degrades via `.catch(() => [])` (hidden promo block) —
    // folding either into `orgsAndStats` would make a failure there also
    // fail this now-combined query, breaking that independence.
    const [tickerResult, orgsAndStatsResult, collectionsResult] = await Promise.all([
      tryFetch(graphqlRequest(HomepageTickerDocument, { limit: 40, exclude: ["github"] }), {
        route: "/",
        event: "homepage-ticker-fetch-failed",
      }),
      // Degrades to an empty table + hidden stats banner rather than failing
      // the render: the page is ISR'd (60s), so a transient API failure —
      // including the deploy window where the web build runs before the API
      // worker ships a new persisted query — self-heals on the next
      // revalidate instead of failing the whole build.
      tryFetch(graphqlRequest(HomepageOrgsStatsDocument, { featuredLimit: DEFAULT_PAGE_SIZE }), {
        route: "/",
        event: "homepage-orgs-stats-fetch-failed",
      }),
      // Promo block is non-essential — a collections hiccup must never break
      // the homepage, so degrade to an empty (hidden) block on failure.
      graphqlRequest(HomepageCollectionsDocument, { featured: true }).catch(
        () => ({ collections: [] }) as HomepageCollectionsQuery,
      ),
    ]);
    // A misconfigured API base is a setup problem, not a degradable panel —
    // surface the setup page like every other route.
    if (orgsAndStatsResult.error instanceof ApiSetupError) throw orgsAndStatsResult.error;
    stats = orgsAndStatsResult.data?.stats;
    latest = tickerResult.data?.latestReleases.items ?? [];
    featuredCollections = collectionsResult.collections;

    // Fallback: if no orgs have been editorially featured yet (true on first
    // deploy), fall back to the regular org list so the home page never renders
    // a blank table. Once orgs are curated via PATCH /v1/orgs/:slug { featured:
    // true } this branch will stop executing.
    if (orgsAndStatsResult.data && orgsAndStatsResult.data.featuredOrgs.items.length === 0) {
      const allOrgsResult = await tryFetch(
        graphqlRequest(HomepageAllOrgsDocument, { limit: DEFAULT_PAGE_SIZE }),
        { route: "/", event: "homepage-all-orgs-fetch-failed" },
      );
      orgsForTable = allOrgsResult.data?.orgs.items ?? [];
    } else {
      orgsForTable = orgsAndStatsResult.data?.featuredOrgs.items ?? [];
    }
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
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
          this top hero region — `position: absolute` inside a `relative` wrapper.
          Site Header lives in the root layout (above this page), so the canvas
          only paints behind the hero text. Hero content sits in a `relative z-10`
          layer above the transparent canvas. */}
      <div className="relative">
        <ConveyorBackdrop style={{ position: "absolute" }} />
        <div className="relative z-10">
          <div className="pt-12 pb-8 text-center px-6">
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mb-2 text-balance">
              The latest product releases, indexed for agents
            </h1>
            <p className="text-[15px] text-stone-500 dark:text-stone-400 mb-6 text-pretty">
              Releases is a registry of release notes from across the web, queryable from your
              terminal, code, or MCP client.
            </p>
            {/* Registry vitals as a mono, letter-spaced readout — an index
                status line rather than marketing stats. Sources + releases
                carry the scale, "updated hourly" the freshness promise; the
                org count still lives in the "Browse all N orgs" link below.
                Compact release count (35.6k) — a scale signal, not a ledger. */}
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-1 font-mono text-[11px] tracking-[0.12em] uppercase text-stone-400 dark:text-stone-500">
              <span className="tabular-nums">{stats?.sources ?? 0} sources</span>
              <span className="tabular-nums">{formatStars(stats?.releases ?? 0)} releases</span>
              <span>updated hourly</span>
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
        {/* Chip first, footnote second: the jump chip is the louder of the two
            (button-ish, for first-timers), the signup line stays quiet fine
            print beneath it. */}
        <AgentUseCasesJumpLink />
        <SignupCta />
      </div>
      {latest.length > 0 && <ShippingNowTicker releases={latest} />}
      <div className="max-w-[1240px] mx-auto px-6 pb-12 xl:grid xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-12">
        <aside className="hidden xl:block xl:order-2 xl:pt-2">
          <InstallStepsSidebar />
          <FeaturedCollections collections={featuredCollections} />
        </aside>
        <div className="xl:order-1 max-w-5xl xl:max-w-none w-full mx-auto">
          <FeaturedCollectionsCollapsible collections={featuredCollections} />
          {orgsForTable.length > 0 && (
            <>
              {/* Neutral sibling to the amber "Recent" ticker heading above:
                  same uppercase/bold/tracking treatment, stone tones instead of
                  amber, signalling the table below is a featured subset (the
                  "Browse all N orgs" link spells out the full catalog). */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-stone-400 dark:text-stone-500" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z" />
                  </svg>
                </span>
                <h2 className="text-[11px] font-bold uppercase tracking-wider text-stone-600 dark:text-stone-300">
                  Featured
                </h2>
              </div>
              <OrgTable orgs={orgsForTable} />
            </>
          )}
          <Link
            href="/catalog"
            className="mt-6 inline-block text-[12px] text-stone-400 dark:text-stone-500 underline decoration-stone-300 dark:decoration-stone-600 underline-offset-2 hover:text-stone-600 dark:hover:text-stone-300"
          >
            Browse all {stats?.orgs ?? 0} orgs →
          </Link>
        </div>
      </div>
      {/* Intro material lives below the changing content (ticker + tables):
          returning visitors get fresh releases first; the jump link under the
          demo carries first-timers down here. */}
      <AgentUseCases />
    </div>
  );
}
