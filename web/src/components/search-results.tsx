"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type {
  UnifiedSearchResponse,
  SearchOrgHit,
  SearchProductHit,
  SearchReleaseHit,
  SearchChunkHit,
} from "@/lib/api";

type SearchFilter = "all" | "orgs" | "products" | "releases";

const FILTERS: { value: SearchFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "orgs", label: "Organizations" },
  { value: "products", label: "Products" },
  { value: "releases", label: "Releases" },
];

/**
 * A single item in the interleaved "Releases" section — either a full
 * release row or a CHANGELOG chunk slice. Carries the fusion score so
 * release and chunk hits can be re-merged into one ranked list client-side
 * (the API splits them into two arrays for legacy back-compat).
 */
type RankedHit =
  | { kind: "release"; score: number; hit: SearchReleaseHit }
  | { kind: "changelog_chunk"; score: number; hit: SearchChunkHit };

function interleaveRankedHits(
  releases: SearchReleaseHit[],
  chunks: SearchChunkHit[] | undefined,
): RankedHit[] {
  const merged: RankedHit[] = [];
  for (const r of releases) {
    merged.push({ kind: "release", score: r.score ?? 0, hit: r });
  }
  for (const c of chunks ?? []) {
    merged.push({ kind: "changelog_chunk", score: c.score, hit: c });
  }
  // Stable-ish sort: higher score first. Both halves already arrive in
  // rank order from the API, so ties preserve the original per-kind order.
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

function sourceHref(orgSlug: string | null, sourceSlug: string): string {
  return orgSlug ? `/${orgSlug}/${sourceSlug}` : `/source/${sourceSlug}`;
}

function chunkDeepLink(hit: SearchChunkHit): string {
  // Heading-aware slicer on the server snaps the offset forward to the
  // nearest `##` heading, so this URL lands the user on the correct
  // section even if `offset` points mid-paragraph.
  const base = sourceHref(hit.orgSlug, hit.sourceSlug);
  return `${base}?tab=changelog&offset=${hit.offset}#chunk`;
}

function formatHeading(raw: string | null): string {
  if (!raw) return "Changelog";
  // Headings come from markdown — strip leading `#` chars and whitespace.
  return raw.replace(/^#+\s*/, "").trim() || "Changelog";
}

/** Collapse repeated whitespace so snippets read as one line in the card. */
function compactSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, " ").trim();
}

export function SearchResults({
  query,
  results,
}: {
  query?: string;
  results: UnifiedSearchResponse | null;
}) {
  const [filter, setFilter] = useState<SearchFilter>("all");

  const rankedHits = useMemo(
    () => (results ? interleaveRankedHits(results.releases, results.chunks) : []),
    [results],
  );

  const hasResults =
    results &&
    (results.orgs.length > 0 ||
      results.products.length > 0 ||
      rankedHits.length > 0);

  const showOrgs = filter === "all" || filter === "orgs";
  const showProducts = filter === "all" || filter === "products";
  const showReleases = filter === "all" || filter === "releases";

  const filteredHasResults =
    results &&
    ((showOrgs && results.orgs.length > 0) ||
      (showProducts && results.products.length > 0) ||
      (showReleases && rankedHits.length > 0));

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
                {results.orgs.map((org: SearchOrgHit) => (
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
                {results.products.map((p: SearchProductHit) => {
                  const href = p.kind === "source" && p.sourceSlug
                    ? (p.orgSlug ? `/${p.orgSlug}/${p.sourceSlug}` : `/source/${p.sourceSlug}`)
                    : (p.orgSlug ? `/${p.orgSlug}/product/${p.slug}` : `/product/${p.slug}`);
                  return (
                    <Link
                      key={p.slug}
                      href={href}
                      className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
                    >
                      <span className="font-medium">{p.name}</span>
                      {p.orgName && (
                        <span className="ml-2 text-xs text-stone-400">by {p.orgName}</span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          {/* Releases + CHANGELOG chunks, interleaved by fusion score */}
          {showReleases && rankedHits.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                Releases
              </h2>
              <div className="space-y-4">
                {rankedHits.map((entry, i) => {
                  // Exhaustive discriminator — TS will error here if a new
                  // hit kind is added without being handled.
                  if (entry.kind === "release") {
                    const r = entry.hit;
                    const href = sourceHref(r.orgSlug, r.sourceSlug);
                    return (
                      <div
                        key={`release:${r.id}:${i}`}
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
                                timeZone: "UTC",
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
                  }

                  // Chunk hit — visually distinguished with a CHANGELOG
                  // badge and a deep link into the source's changelog tab
                  // at the chunk's byte offset.
                  const c = entry.hit;
                  const href = chunkDeepLink(c);
                  return (
                    <div
                      key={`chunk:${c.sourceSlug}:${c.offset}:${i}`}
                      className="border-b border-stone-200 dark:border-stone-800 pb-4"
                    >
                      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
                        <div className="flex items-baseline gap-2 min-w-0">
                          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 shrink-0">
                            Changelog
                          </span>
                          <span className="text-sm text-stone-600 dark:text-stone-400 truncate">
                            {formatHeading(c.heading)}
                          </span>
                        </div>
                      </div>
                      <p className="text-[13px] text-stone-500 mt-1 line-clamp-2 font-mono">
                        {compactSnippet(c.snippet)}
                      </p>
                      <Link
                        href={href}
                        className="text-xs text-stone-400 hover:text-stone-600 mt-1 inline-block"
                      >
                        {c.sourceName}
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
