"use client";

import { useState } from "react";
import Link from "next/link";
import type { UnifiedSearchResponse } from "@/lib/api";

type SearchFilter = "all" | "orgs" | "products" | "sources" | "releases";

const FILTERS: { value: SearchFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "orgs", label: "Organizations" },
  { value: "products", label: "Products" },
  { value: "sources", label: "Sources" },
  { value: "releases", label: "Releases" },
];

export function SearchResults({
  query,
  results,
}: {
  query?: string;
  results: UnifiedSearchResponse | null;
}) {
  const [filter, setFilter] = useState<SearchFilter>("all");

  const hasResults =
    results &&
    (results.orgs.length > 0 ||
      results.products.length > 0 ||
      results.sources.length > 0 ||
      results.releases.length > 0);

  const showOrgs = filter === "all" || filter === "orgs";
  const showProducts = filter === "all" || filter === "products";
  const showSources = filter === "all" || filter === "sources";
  const showReleases = filter === "all" || filter === "releases";

  const filteredHasResults =
    results &&
    ((showOrgs && results.orgs.length > 0) ||
      (showProducts && results.products.length > 0) ||
      (showSources && results.sources.length > 0) ||
      (showReleases && results.releases.length > 0));

  return (
    <>
      {results && (
        <div className="flex gap-1.5 flex-wrap mt-3">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                filter === f.value
                  ? "bg-stone-800 text-stone-100 dark:bg-stone-200 dark:text-stone-900"
                  : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {results && !hasResults && (
        <p className="mt-8 text-stone-500">No results for &ldquo;{query}&rdquo;</p>
      )}

      {results && hasResults && !filteredHasResults && (
        <p className="mt-8 text-stone-500">
          No {filter} found for &ldquo;{query}&rdquo;
        </p>
      )}

      {results && filteredHasResults && (
        <div className="mt-6 space-y-8">
          {/* Orgs */}
          {showOrgs && results.orgs.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                Organizations
              </h2>
              <div className="space-y-2">
                {results.orgs.map((org: any) => (
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

          {/* Products */}
          {showProducts && results.products.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                Products
              </h2>
              <div className="space-y-2">
                {results.products.map((p: any) => (
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

          {/* Sources */}
          {showSources && results.sources.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                Sources
              </h2>
              <div className="space-y-2">
                {results.sources.map((s: any) => {
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

          {/* Releases */}
          {showReleases && results.releases.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                Releases
              </h2>
              <div className="space-y-4">
                {results.releases.map((r: any, i: number) => {
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
                      <p className="text-[13px] text-stone-500 mt-1 line-clamp-2">{r.summary}</p>
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
    </>
  );
}
