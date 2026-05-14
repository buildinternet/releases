"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "@/lib/markdown-plugins";
import { categoryDisplayName } from "@buildinternet/releases-core/categories";
import type {
  UnifiedSearchResponse,
  SearchOrgHit,
  SearchCatalogHit,
  SearchReleaseHit,
  SearchChunkHit,
} from "@/lib/api";
import { collapsedMarkdownComponents } from "./markdown-components";

/**
 * In-body heading overrides for search previews. The feed card already
 * renders the entity's title prominently, so any `#`/`##`/`###` inside
 * the body should render as small emphasized inline text rather than
 * compete with the card title. We layer these on top of
 * `collapsedMarkdownComponents`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const searchPreviewComponents: Record<string, any> = {
  ...collapsedMarkdownComponents,
  h1: (props: any) => (
    <div className="text-[13px] font-semibold text-stone-600 dark:text-stone-300 mt-1">
      {props.children}
    </div>
  ),
  h2: (props: any) => (
    <div className="text-[13px] font-semibold text-stone-600 dark:text-stone-300 mt-1">
      {props.children}
    </div>
  ),
  h3: (props: any) => (
    <div className="text-[13px] font-semibold text-stone-600 dark:text-stone-300 mt-1">
      {props.children}
    </div>
  ),
  h4: (props: any) => (
    <div className="text-[13px] font-semibold text-stone-600 dark:text-stone-300 mt-1">
      {props.children}
    </div>
  ),
};
/* eslint-enable @typescript-eslint/no-explicit-any */
import { SourceTypeIcon } from "./source-type-icon";
import { FallbackImage } from "./fallback-image";
import { LookupRail } from "./lookup-rail";
import { RollupBadge } from "./rollup-badge";
import { Highlight, rehypeHighlightTokens, tokenizeQuery } from "./highlight";
import { formatDate } from "@/lib/formatters";

type SearchFilter = "all" | "orgs" | "products" | "collections" | "releases";

const FILTERS: { value: SearchFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "orgs", label: "Organizations" },
  { value: "products", label: "Products" },
  { value: "collections", label: "Collections" },
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

function releaseHref(hit: SearchReleaseHit): string {
  return `/release/${hit.id}`;
}

function chunkDeepLink(hit: SearchChunkHit): string {
  // Heading-aware slicer on the server snaps the offset forward to the
  // nearest `##` heading, so this URL lands the user on the correct
  // section even if `offset` points mid-paragraph.
  const base = sourceHref(hit.orgSlug, hit.sourceSlug);
  return `${base}/changelog?offset=${hit.offset}#chunk`;
}

function formatHeading(raw: string | null): string {
  if (!raw) return "Changelog";
  // Headings come from markdown — strip leading `#` chars and whitespace.
  return raw.replace(/^#+\s*/, "").trim() || "Changelog";
}

/**
 * Clean the start of a chunk snippet for preview display.
 *
 * Chunks come from `chunkChangelog` in two flavors:
 *   1. First chunk of a file — starts at offset 0 (content head).
 *   2. Subsequent chunks — start at `heading_boundary - overlap_chars`,
 *      i.e. the chunker intentionally backs up ~500 chars into the
 *      previous chunk's tail to create retrieval overlap. That tail
 *      routinely lands mid-word, mid-link, or mid-backtick.
 *
 * For preview, we want the snippet to look like the start of a section,
 * not the back half of someone else's sentence. So:
 *   - If the first line is a markdown heading, strip it (the card title
 *     already shows the heading).
 *   - Otherwise, drop the partial first line entirely and prefix `…` so
 *     the reader knows more context exists above.
 */
function stripLeadingChunkHeading(snippet: string): string {
  const firstNewline = snippet.indexOf("\n");
  if (firstNewline === -1) return snippet;
  const firstLine = snippet.slice(0, firstNewline).trimStart();
  if (/^#{1,6}\s/.test(firstLine)) {
    return snippet.slice(firstNewline + 1).replace(/^\s*\n+/, "");
  }
  // Partial-line overlap remnant — drop it and mark as truncated.
  const rest = snippet.slice(firstNewline + 1).replace(/^\s*\n+/, "");
  return rest ? `… ${rest}` : snippet;
}

/**
 * Strip a leading markdown heading from release content when it merely
 * duplicates the release title. Mirrors the same behavior
 * `ReleaseListItem` uses in the feed so the card body isn't overshadowed
 * by its own title.
 */
function stripLeadingTitle(content: string, title: string | null): string {
  if (!title || !content) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  const firstLine = content
    .slice(0, firstNewline)
    .replace(/^#+\s+/, "")
    .trim();
  if (firstLine.toLowerCase() === title.toLowerCase()) {
    return content.slice(firstNewline + 1).trimStart();
  }
  return content;
}

const resultMarkdownClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13px] leading-relaxed text-stone-500 dark:text-stone-400 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-[13px] [&_h3]:font-semibold [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_p]:my-1 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_strong]:text-stone-500 dark:[&_strong]:text-stone-400";

/**
 * Shared card frame for search hits. Search is relevance-ranked, not
 * chronological, so this layout deliberately avoids the timeline rail
 * used by `<ReleaseListItem>`: no date gutter, no dot, no connecting
 * line. The date (if present) rides along as a small right-aligned
 * annotation in the byline so it doesn't imply ordering.
 */
function ResultCard({
  kindLabel,
  title,
  titleBadge,
  titleHref,
  externalUrl,
  date,
  sourceName,
  sourceSlug,
  orgSlug,
  orgName,
  sourceType,
  children,
  thumbnail,
  tokens,
}: {
  kindLabel?: string;
  title: string;
  titleBadge?: React.ReactNode;
  titleHref: string;
  externalUrl?: string | null;
  date?: string | null;
  sourceName: string;
  sourceSlug: string;
  orgSlug: string | null;
  orgName?: string | null;
  sourceType?: string;
  children: React.ReactNode;
  thumbnail?: { src: string; alt: string } | null;
  tokens: string[];
}) {
  return (
    <div className="group/item border-b border-stone-200 dark:border-stone-800 last:border-b-0 py-4">
      <div className="flex items-baseline gap-2 mb-1 min-w-0">
        {kindLabel && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 shrink-0">
            {kindLabel}
          </span>
        )}
        <Link
          href={titleHref}
          className="font-semibold text-[15px] text-stone-900 dark:text-stone-100 hover:underline min-w-0 truncate"
        >
          <Highlight text={title} tokens={tokens} />
        </Link>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-300 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 text-xs shrink-0"
          >
            ↗
          </a>
        )}
        {titleBadge}
      </div>
      <div className="text-[12px] text-stone-400 dark:text-stone-500 mb-2 flex items-center gap-1 flex-wrap">
        <span>via</span>
        {sourceType && <SourceTypeIcon type={sourceType} size={12} />}
        {orgSlug ? (
          <Link
            href={`/${orgSlug}/${sourceSlug}`}
            className="text-stone-500 dark:text-stone-400 font-medium hover:text-stone-700 dark:hover:text-stone-300"
          >
            <Highlight text={sourceName} tokens={tokens} />
          </Link>
        ) : (
          <span className="text-stone-500 dark:text-stone-400 font-medium">
            <Highlight text={sourceName} tokens={tokens} />
          </span>
        )}
        {/* Org name disambiguates sources with generic names like "Client SDK
            JS" — shown only when we have both an orgName and an orgSlug, and
            hidden when the source name already starts with the org name to
            avoid repetition like "by Slack" on "@slack/web-api". */}
        {orgName && orgSlug && !sourceName.toLowerCase().startsWith(orgName.toLowerCase()) && (
          <>
            <span className="text-stone-300 dark:text-stone-700">·</span>
            <span>by</span>
            <Link
              href={`/${orgSlug}`}
              className="text-stone-500 dark:text-stone-400 font-medium hover:text-stone-700 dark:hover:text-stone-300"
            >
              <Highlight text={orgName} tokens={tokens} />
            </Link>
          </>
        )}
        {date && (
          <>
            <span className="text-stone-300 dark:text-stone-700">·</span>
            <time className="tabular-nums">{date}</time>
          </>
        )}
      </div>
      <div className="flex gap-3">
        <div className="flex-1 min-w-0 max-h-[4.5em] overflow-hidden">{children}</div>
        {thumbnail && (
          <FallbackImage
            src={thumbnail.src}
            alt={thumbnail.alt}
            width={120}
            height={72}
            className="rounded-md object-cover w-[120px] h-[72px] border border-stone-200 dark:border-stone-800 shrink-0"
          />
        )}
      </div>
    </div>
  );
}

function ReleaseResultCard({ hit, tokens }: { hit: SearchReleaseHit; tokens: string[] }) {
  const body = useMemo(
    () => stripLeadingTitle(hit.content ?? hit.summary, hit.title),
    [hit.content, hit.summary, hit.title],
  );
  const thumbnail = useMemo(() => {
    const item = hit.media?.find((m) => m.type === "image" || m.type === "gif");
    if (!item) return null;
    return { src: item.r2Url ?? item.url, alt: item.alt || "" };
  }, [hit.media]);

  // Prefer version as the card heading to match how feed items read;
  // fall back to title when version is absent.
  const heading = hit.version || hit.title;
  const rehypePlugins = useMarkdownHighlight(tokens);

  return (
    <ResultCard
      title={heading}
      titleBadge={<RollupBadge type={hit.type} />}
      titleHref={releaseHref(hit)}
      date={formatDate(hit.publishedAt)}
      sourceName={hit.sourceName}
      sourceSlug={hit.sourceSlug}
      orgSlug={hit.orgSlug}
      orgName={hit.orgName}
      sourceType={hit.sourceType}
      thumbnail={thumbnail}
      tokens={tokens}
    >
      <div className={resultMarkdownClasses}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={searchPreviewComponents}
        >
          {body}
        </ReactMarkdown>
      </div>
    </ResultCard>
  );
}

function ChunkResultCard({ hit, tokens }: { hit: SearchChunkHit; tokens: string[] }) {
  const body = useMemo(() => stripLeadingChunkHeading(hit.snippet), [hit.snippet]);
  const rehypePlugins = useMarkdownHighlight(tokens);
  return (
    <ResultCard
      kindLabel="Changelog"
      title={formatHeading(hit.heading)}
      titleHref={chunkDeepLink(hit)}
      sourceName={hit.sourceName}
      sourceSlug={hit.sourceSlug}
      orgSlug={hit.orgSlug}
      orgName={hit.orgName}
      sourceType="github"
      tokens={tokens}
    >
      <div className={resultMarkdownClasses}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={searchPreviewComponents}
        >
          {body}
        </ReactMarkdown>
      </div>
    </ResultCard>
  );
}

type RehypeHighlightTuple = [typeof rehypeHighlightTokens, { tokens: string[] }];

function useMarkdownHighlight(tokens: string[]) {
  return useMemo<RehypeHighlightTuple[]>(
    () => (tokens.length ? [[rehypeHighlightTokens, { tokens }]] : []),
    [tokens],
  );
}

export function SearchResults({
  query,
  results,
}: {
  query?: string;
  results: UnifiedSearchResponse | null;
}) {
  const [filter, setFilter] = useState<SearchFilter>("all");

  const tokens = useMemo(() => tokenizeQuery(query), [query]);

  const rankedHits = useMemo(
    () => (results ? interleaveRankedHits(results.releases, results.chunks) : []),
    [results],
  );

  const lookup = results?.lookup ?? null;

  // `collections` is optional on the wire (older API deployments mid-rollout
  // omit the field). Treat missing and `[]` identically so the UI doesn't
  // 500 before the feature lands in production.
  const collectionsHits = results?.collections ?? [];

  const hasResults =
    results &&
    (results.orgs.length > 0 ||
      results.catalog.length > 0 ||
      collectionsHits.length > 0 ||
      rankedHits.length > 0 ||
      lookup !== null);

  const showOrgs = filter === "all" || filter === "orgs";
  const showProducts = filter === "all" || filter === "products";
  const showCollections = filter === "all" || filter === "collections";
  const showReleases = filter === "all" || filter === "releases";

  const filteredHasResults =
    results &&
    ((showOrgs && results.orgs.length > 0) ||
      (showProducts && results.catalog.length > 0) ||
      (showCollections && collectionsHits.length > 0) ||
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

      {lookup && query && <LookupRail query={query} payload={lookup} />}

      {results && !hasResults && (
        <p className="mt-8 text-stone-500">No results for &ldquo;{query}&rdquo;</p>
      )}

      {results && hasResults && !filteredHasResults && !lookup && (
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
                    <span className="font-medium">
                      <Highlight text={org.name} tokens={tokens} />
                    </span>
                    {org.category && (
                      <span className="ml-2 text-xs text-stone-400">
                        <Highlight text={categoryDisplayName(org.category)} tokens={tokens} />
                      </span>
                    )}
                    {org.domain && (
                      <span className="ml-2 text-xs text-stone-400">
                        <Highlight text={org.domain} tokens={tokens} />
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Products */}
          {showProducts && results.catalog.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                Products
              </h2>
              <div className="space-y-2">
                {results.catalog.map((p: SearchCatalogHit) => {
                  const href =
                    p.kind === "source" && p.sourceSlug
                      ? p.orgSlug
                        ? `/${p.orgSlug}/${p.sourceSlug}`
                        : `/source/${p.sourceSlug}`
                      : p.orgSlug
                        ? `/${p.orgSlug}/product/${p.slug}`
                        : `/product/${p.slug}`;
                  return (
                    <Link
                      key={p.slug}
                      href={href}
                      className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
                    >
                      <span className="font-medium">
                        <Highlight text={p.name} tokens={tokens} />
                      </span>
                      {p.orgName && (
                        <span className="ml-2 text-xs text-stone-400">
                          by <Highlight text={p.orgName} tokens={tokens} />
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          {/* Collections — direct hits sort ahead of member rollups; member
              rollups carry a list of result-set org slugs that triggered
              the rollup so we can render an "includes X, Y" affordance. */}
          {showCollections && collectionsHits.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                Collections
              </h2>
              <div className="space-y-2">
                {collectionsHits.map((c) => (
                  <Link
                    key={c.slug}
                    href={`/collections/${c.slug}`}
                    className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
                  >
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-medium">
                        <Highlight text={c.name} tokens={tokens} />
                      </span>
                      <span className="text-xs text-stone-400">
                        {c.memberCount === 1 ? "1 member" : `${c.memberCount} members`}
                      </span>
                    </div>
                    {c.description && (
                      <p className="text-xs text-stone-500 dark:text-stone-400 mt-1">
                        <Highlight text={c.description} tokens={tokens} />
                      </p>
                    )}
                    {c.via === "member" && c.matchedOrgSlugs && c.matchedOrgSlugs.length > 0 && (
                      <p className="text-[11px] text-stone-400 mt-1">
                        Includes {c.matchedOrgSlugs.join(", ")}
                      </p>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Releases + CHANGELOG chunks, interleaved by relevance score.
              Search intentionally drops the feed's timeline rail because
              hits are ranked, not chronological — a gutter of dates would
              imply an order that doesn't exist. */}
          {showReleases && rankedHits.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                Releases
              </h2>
              <div>
                {rankedHits.map((entry, i) => {
                  if (entry.kind === "release") {
                    const r = entry.hit;
                    return (
                      <ReleaseResultCard key={`release:${r.id}:${i}`} hit={r} tokens={tokens} />
                    );
                  }
                  const c = entry.hit;
                  return (
                    <ChunkResultCard
                      key={`chunk:${c.sourceSlug}:${c.offset}:${i}`}
                      hit={c}
                      tokens={tokens}
                    />
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
