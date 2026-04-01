import { api, ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { SearchBar } from "@/components/search-bar";
import { SourceCard } from "@/components/source-card";
import { SetupMessage } from "@/components/setup-message";
import Link from "next/link";

export default async function HomePage() {
  let stats, orgs, independentSources;
  try {
    [stats, orgs, independentSources] = await Promise.all([
      api.stats(),
      api.orgs(),
      api.sources(true),
    ]);
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
    "name": "Released",
    "url": "https://releases.sh",
    "description": "Changelog index for developers.",
  };

  return (
    <div className="min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Header />
      <div className="pt-12 pb-8 text-center px-6">
        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mb-2">Release notes, indexed</h1>
        <p className="text-[15px] text-stone-500 dark:text-stone-400 mb-6">Track changelogs across the tools and libraries you depend on.</p>
        <SearchBar />
        <div className="flex justify-center gap-8 mt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <span><strong className="text-stone-600 dark:text-stone-300">{stats.orgs}</strong> orgs</span>
          <span><strong className="text-stone-600 dark:text-stone-300">{stats.sources}</strong> sources</span>
          <span><strong className="text-stone-600 dark:text-stone-300">{stats.releases.toLocaleString()}</strong> releases</span>
        </div>
      </div>
      <div className="max-w-4xl mx-auto px-6 pb-12">
        {orgs.length > 0 && (
          <div className="mb-8">
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">Organizations</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {orgs.map((org) => (
                <Link key={org.slug} href={`/${org.slug}`}
                  className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-4 py-3.5 hover:border-stone-300 dark:hover:border-stone-600 transition-colors">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-semibold text-sm text-stone-900 dark:text-stone-100">{org.name}</div>
                      {org.domain && <div className="text-xs text-stone-400 dark:text-stone-500 mt-0.5">{org.domain}</div>}
                    </div>
                    <div className="text-xs text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 px-2 py-0.5 rounded">{org.sourceCount} sources</div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
        {independentSources.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">Independent Projects</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {independentSources.map((source) => (
                <SourceCard key={source.slug} source={source} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
