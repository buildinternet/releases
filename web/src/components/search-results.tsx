"use client";

import { useState, useMemo, Fragment } from "react";
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
import { MemberFacepile } from "@/components/member-facepile";

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
import { OrgAvatar } from "./org-avatar";
import { FallbackImage } from "./fallback-image";
import { AppStoreIcon } from "./app-store-icon";
import { PlayBadge } from "./play-badge";
import { appRowInfoFromWire, type AppRowInfo } from "@/lib/app-source";
import { videoRowInfoFromWire, type VideoRowInfo } from "@/lib/video-source";
import { LookupRail } from "./lookup-rail";
import { RollupBadge } from "./rollup-badge";
import { Highlight, rehypeHighlightTokens, tokenizeQuery } from "./highlight";
import { formatDate } from "@/lib/formatters";
import { productPath, sourcePath, sourceOrProductPath } from "@/lib/links";

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

function releaseHref(hit: SearchReleaseHit): string {
  return `/release/${hit.id}`;
}

function chunkDeepLink(hit: SearchChunkHit): string {
  // Heading-aware slicer on the server snaps the offset forward to the
  // nearest `##` heading, so this URL lands the user on the correct
  // section even if `offset` points mid-paragraph.
  const base = sourcePath(hit.orgSlug, hit.sourceSlug);
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
  productSlug,
  orgName,
  sourceType,
  children,
  thumbnail,
  tokens,
  appStore,
  video,
  version,
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
  productSlug?: string | null;
  orgName?: string | null;
  sourceType?: string;
  children: React.ReactNode;
  thumbnail?: { src: string; alt: string } | null;
  tokens: string[];
  // App Store hits render a leading app icon, an inline version suffix, and an
  // "Available for iOS/macOS" descriptor in the byline — the compact treatment
  // matching the feed row and source page. Null for non-app hits. #1206
  appStore?: AppRowInfo | null;
  // Video hits overlay a play badge on the thumbnail and add a "Watch on
  // {provider}" descriptor in the byline, mirroring the feed video row. Null
  // for non-video hits. #1206
  video?: VideoRowInfo | null;
  version?: string | null;
}) {
  return (
    <div className="group/item border-b border-stone-200 dark:border-stone-800 last:border-b-0 py-4">
      <div className="flex items-baseline gap-2 mb-1 min-w-0">
        {kindLabel && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 shrink-0">
            {kindLabel}
          </span>
        )}
        {appStore && (
          <AppStoreIcon
            iconUrl={appStore.iconUrl}
            appName={appStore.appName}
            size={20}
            className="self-center"
          />
        )}
        <Link
          href={titleHref}
          className="font-semibold text-[15px] text-stone-900 dark:text-stone-100 hover:underline min-w-0 truncate"
        >
          <Highlight text={title} tokens={tokens} />
          {appStore && version && (
            <span className="ml-1.5 font-normal text-stone-500 dark:text-stone-400">
              v{version}
            </span>
          )}
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
            href={sourceOrProductPath({ orgSlug, sourceSlug, productSlug })}
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
        {appStore && (
          <>
            <span className="text-stone-300 dark:text-stone-700">·</span>
            <span>Available for {appStore.label}</span>
          </>
        )}
        {video && (
          <>
            <span className="text-stone-300 dark:text-stone-700">·</span>
            <span>Watch on {video.label}</span>
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
          // Video hits overlay a play badge so the still reads as playable,
          // matching the feed video row. The card itself links to the release
          // page (the byline carries "Watch on {provider}"). #1206
          <div className={video ? "group relative shrink-0" : "shrink-0"}>
            <FallbackImage
              src={thumbnail.src}
              alt={thumbnail.alt}
              width={120}
              height={72}
              className="rounded-md object-cover w-[120px] h-[72px] border border-stone-200 dark:border-stone-800"
            />
            {video && <PlayBadge size="sm" />}
          </div>
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

  // App Store hits lead with the app name + an inline version and the
  // "Available for iOS/macOS" descriptor; video hits lead with the (descriptive)
  // video title and carry a "Watch on {provider}" descriptor; other hits lead
  // with the version (falling back to title). This intentionally differs from
  // the chronological feed, which leads with the descriptive title — search
  // reads as a lookup.
  const appStore = appRowInfoFromWire(hit.appStore, hit.sourceName);
  const video = videoRowInfoFromWire(hit.video);
  const heading = appStore ? appStore.appName : video ? hit.title : hit.version || hit.title;
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
      productSlug={hit.productSlug ?? null}
      orgName={hit.orgName}
      sourceType={hit.sourceType}
      thumbnail={thumbnail}
      tokens={tokens}
      appStore={appStore}
      video={video}
      version={hit.version}
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

/**
 * Joins 1–N secondary fragments with a "·" separator, dropping empty parts and
 * returning null when nothing remains (so the row's secondary line collapses
 * entirely rather than rendering an empty span). Shared by the org and product
 * hit rows, which otherwise duplicate the same separator markup and guard.
 */
function joinMeta(parts: React.ReactNode[]): React.ReactNode {
  const shown = parts.filter(Boolean);
  if (shown.length === 0) return null;
  return shown.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <span className="text-stone-300 dark:text-stone-700"> · </span>}
      {part}
    </Fragment>
  ));
}

/** Stacked-layers glyph tile — the visual cue for a collection. */
function CollectionTile({ size = 36 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-400 dark:bg-stone-800 dark:text-stone-500"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg
        width={size * 0.5}
        height={size * 0.5}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2 2 7l10 5 10-5-10-5Z" />
        <path d="m2 17 10 5 10-5" />
        <path d="m2 12 10 5 10-5" />
      </svg>
    </div>
  );
}

/**
 * Shared row for the org / product / collection hit sections. Search used to
 * render each of these as a flat text-only box, which gave the entity sections
 * no leading visual and no hierarchy against the thumbnail-bearing release
 * cards below. This consolidates them into one layout — a leading visual slot
 * (avatar / monogram / glyph), a bold primary name with optional trailing cue,
 * and a muted secondary line — matching how the same entities render in the
 * catalog, org table, and collection rails.
 */
function EntityHitRow({
  href,
  visual,
  name,
  tokens,
  trailing,
  secondary,
  footer,
}: {
  href: string;
  /** Leading visual (avatar / glyph). Omitted for entities with no image of
   *  their own — e.g. products, which carry the org avatar inline instead. */
  visual?: React.ReactNode;
  name: string;
  tokens: string[];
  trailing?: React.ReactNode;
  secondary?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 rounded-lg border border-stone-200 p-3 transition-colors hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"
    >
      {visual && <span className="mt-0.5">{visual}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-900 dark:text-stone-100">
            <Highlight text={name} tokens={tokens} />
          </span>
          {trailing}
        </span>
        {secondary && (
          <span className="mt-0.5 block truncate text-xs text-stone-400 dark:text-stone-500">
            {secondary}
          </span>
        )}
        {footer}
      </span>
    </Link>
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
                  <EntityHitRow
                    key={org.slug}
                    href={`/${org.slug}`}
                    name={org.name}
                    tokens={tokens}
                    visual={
                      <OrgAvatar
                        avatarUrl={org.avatarUrl}
                        githubHandle={null}
                        name={org.name}
                        size={36}
                      />
                    }
                    secondary={joinMeta([
                      org.category && (
                        <Highlight text={categoryDisplayName(org.category)} tokens={tokens} />
                      ),
                      org.domain && <Highlight text={org.domain} tokens={tokens} />,
                    ])}
                  />
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
                    p.entryType === "source" && p.sourceSlug
                      ? sourcePath(p.orgSlug, p.sourceSlug)
                      : productPath(p.orgSlug, p.slug);
                  const category = p.category ? categoryDisplayName(p.category) : null;
                  return (
                    <EntityHitRow
                      key={p.slug}
                      href={href}
                      name={p.name}
                      tokens={tokens}
                      trailing={
                        p.entryType === "source" && p.sourceType ? (
                          <SourceTypeIcon type={p.sourceType} size={14} />
                        ) : undefined
                      }
                      secondary={joinMeta([
                        p.orgName && (
                          <span className="inline-flex items-center gap-1 align-middle">
                            by
                            {p.orgAvatarUrl && (
                              <OrgAvatar
                                avatarUrl={p.orgAvatarUrl}
                                githubHandle={null}
                                name={p.orgName}
                                size={14}
                              />
                            )}
                            <Highlight text={p.orgName} tokens={tokens} />
                          </span>
                        ),
                        category && <Highlight text={category} tokens={tokens} />,
                      ])}
                    />
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
                  <EntityHitRow
                    key={c.slug}
                    href={`/collections/${c.slug}`}
                    name={c.name}
                    tokens={tokens}
                    visual={<CollectionTile size={36} />}
                    trailing={
                      <span className="shrink-0 text-[11px] tabular-nums text-stone-400 dark:text-stone-500">
                        {c.memberCount === 1 ? "1 member" : `${c.memberCount} members`}
                      </span>
                    }
                    secondary={
                      c.description ? <Highlight text={c.description} tokens={tokens} /> : null
                    }
                    footer={
                      <>
                        {c.previewMembers && c.previewMembers.length > 0 && (
                          <MemberFacepile
                            members={c.previewMembers}
                            totalCount={c.memberCount}
                            className="mt-1.5"
                          />
                        )}
                        {c.via === "member" &&
                          c.matchedOrgSlugs &&
                          c.matchedOrgSlugs.length > 0 && (
                            <span className="mt-1 block text-[11px] text-stone-400 dark:text-stone-500">
                              Includes {c.matchedOrgSlugs.join(", ")}
                            </span>
                          )}
                      </>
                    }
                  />
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
