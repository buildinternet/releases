import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiSetupError } from "@/lib/api";
import { tryFetch } from "@/lib/ssr-fetch";
import { graphqlRequest } from "@/lib/graphql/client";
import { HomepageTickerDocument } from "@/lib/graphql/__generated__/graphql";
import type { HomepageTickerQuery } from "@/lib/graphql/__generated__/graphql";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { OrgTable } from "@/components/org-table";
import { InstallStepsInline, InstallStepsSidebar } from "@/components/install-steps";
import { ShippingNowTicker } from "@/components/shipping-now-ticker";

type TickerItem = HomepageTickerQuery["latestReleases"]["items"][number];

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

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
  try {
    const [tickerResult, fetchedStats, fetchedOrgs] = await Promise.all([
      tryFetch(graphqlRequest(HomepageTickerDocument, { limit: 40, exclude: ["github"] }), {
        route: "/",
        event: "homepage-ticker-fetch-failed",
      }),
      api.stats(),
      api.orgs({ includeEmpty }),
    ]);
    stats = fetchedStats;
    orgsResult = fetchedOrgs;
    latest = tickerResult.data?.latestReleases.items ?? [];
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
    "@type": "WebSite",
    name: "releases.sh",
    url: "https://releases.sh",
    description:
      "An agent-friendly API for product changelogs. A unified registry of product releases, available via CLI, API, or MCP.",
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: "https://releases.sh/search?q={search_term_string}",
      },
      "query-input": "required name=search_term_string",
    },
  };

  return (
    <div className="min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
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
      {latest.length > 0 && <ShippingNowTicker releases={latest} />}
      <div className="max-w-[1240px] mx-auto px-6 pb-12 xl:grid xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-12">
        <aside className="hidden xl:block xl:order-2 xl:pt-2">
          <InstallStepsSidebar />
        </aside>
        <div className="xl:order-1 max-w-4xl xl:max-w-none w-full mx-auto">
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
