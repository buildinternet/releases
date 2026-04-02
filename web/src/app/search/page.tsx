import type { Metadata } from "next";
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SearchBar } from "@/components/search-bar";
import Link from "next/link";
import type { UnifiedSearchResponse } from "@shared/api/types";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  let results: UnifiedSearchResponse | null = null;
  if (q && q.trim()) {
    try {
      results = await api.search(q);
    } catch {
      results = { query: q, orgs: [], products: [], sources: [], releases: [] };
    }
  }

  const hasResults =
    results &&
    (results.orgs.length > 0 ||
      results.products.length > 0 ||
      results.sources.length > 0 ||
      results.releases.length > 0);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-2xl mx-auto px-6 pt-12 pb-12">
        <h1 className="text-2xl font-semibold mb-6">Search</h1>
        <SearchBar defaultValue={q} />

        {results && !hasResults && (
          <p className="mt-8 text-stone-500">No results for &ldquo;{q}&rdquo;</p>
        )}

        {results && hasResults && (
          <div className="mt-8 space-y-8">
            {/* ── Orgs ── */}
            {results.orgs.length > 0 && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                  Organizations
                </h2>
                <div className="space-y-2">
                  {results.orgs.map((org) => (
                    <Link
                      key={org.slug}
                      href={`/${org.slug}`}
                      className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
                    >
                      <span className="font-medium">{org.name}</span>
                      {org.category && (
                        <span className="ml-2 text-xs text-stone-400">{org.category}</span>
                      )}
                      {org.domain && (
                        <span className="ml-2 text-xs text-stone-400">{org.domain}</span>
                      )}
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {/* ── Products ── */}
            {results.products.length > 0 && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                  Products
                </h2>
                <div className="space-y-2">
                  {results.products.map((p) => (
                    <Link
                      key={p.slug}
                      href={p.orgSlug ? `/${p.orgSlug}/product/${p.slug}` : `/product/${p.slug}`}
                      className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
                    >
                      <span className="font-medium">{p.name}</span>
                      {p.orgName && (
                        <span className="ml-2 text-xs text-stone-400">by {p.orgName}</span>
                      )}
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {/* ── Sources ── */}
            {results.sources.length > 0 && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                  Sources
                </h2>
                <div className="space-y-2">
                  {results.sources.map((s) => {
                    const href = s.orgSlug ? `/${s.orgSlug}/${s.slug}` : `/source/${s.slug}`;
                    return (
                      <Link
                        key={s.slug}
                        href={href}
                        className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
                      >
                        <span className="font-medium">{s.name}</span>
                        {s.orgName && (
                          <span className="ml-2 text-xs text-stone-400">{s.orgName}</span>
                        )}
                        <span className="ml-2 text-xs text-stone-400">{s.type}</span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Releases ── */}
            {results.releases.length > 0 && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                  Releases
                </h2>
                <div className="space-y-4">
                  {results.releases.map((r, i) => {
                    const href = r.orgSlug
                      ? `/${r.orgSlug}/${r.sourceSlug}`
                      : `/source/${r.sourceSlug}`;
                    return (
                      <div
                        key={i}
                        className="border-b border-stone-200 dark:border-stone-800 pb-4"
                      >
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
                          <div className="flex items-baseline gap-2">
                            {r.version && (
                              <span className="text-sm font-semibold">{r.version}</span>
                            )}
                            <span className="text-sm text-stone-600 dark:text-stone-400">
                              {r.title}
                            </span>
                          </div>
                          {r.publishedAt && (
                            <time className="text-xs text-stone-400 shrink-0">
                              {new Date(r.publishedAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })}
                            </time>
                          )}
                        </div>
                        <p className="text-[13px] text-stone-500 mt-1 line-clamp-2">
                          {r.summary}
                        </p>
                        <Link
                          href={href}
                          className="text-xs text-stone-400 hover:text-stone-600 mt-1 inline-block"
                        >
                          {r.sourceName}
                        </Link>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
