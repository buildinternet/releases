import { api, ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { SearchBar } from "@/components/search-bar";
import { SetupMessage } from "@/components/setup-message";
import { OrgTable } from "@/components/org-table";
import { InstallTabs } from "@/components/install-tabs";

export default async function HomePage() {
  let stats, orgs;
  try {
    [stats, orgs] = await Promise.all([api.stats(), api.orgs()]);
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
        <SearchBar className="max-w-[480px] mx-auto" />
        <div className="flex justify-center gap-8 mt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <span>
            <strong className="text-stone-600 dark:text-stone-300">{stats.orgs}</strong> orgs
          </span>
          <span>
            <strong className="text-stone-600 dark:text-stone-300">{stats.sources}</strong> sources
          </span>
          <span>
            <strong className="text-stone-600 dark:text-stone-300">
              {stats.releases.toLocaleString()}
            </strong>{" "}
            releases
          </span>
        </div>
        <div className="mt-8">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
            Get Started
          </div>
          <InstallTabs />
        </div>
      </div>
      <div className="max-w-4xl mx-auto px-6 pb-12">
        {orgs.length > 0 && <OrgTable orgs={orgs} />}
      </div>
    </div>
  );
}
