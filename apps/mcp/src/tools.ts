// Parity note: a read-only subset of these tools is also exposed in-browser via
// WebMCP in `apps/web/src/components/webmcp-provider.tsx`. When adding, renaming, or
// changing the signature of a read-only tool here, update that provider in the
// same PR so the remote, local-stdio, and browser surfaces don't drift.
import { eq, desc, and, isNull, or, sql, asc } from "drizzle-orm";
import {
  sources,
  releasesVisible,
  organizations,
  organizationsActive,
  organizationsPublic,
  productsActive,
  orgAccounts,
  tags,
  orgTags,
  products,
  productTags,
  domainAliases,
  sourceChangelogFiles,
  knowledgePages,
  collections,
  collectionMembers,
  type ReleaseType,
  type SearchMode,
} from "@buildinternet/releases-core/schema";
import { nowIso, timeAgo, resolveDateParam } from "@buildinternet/releases-core/dates";
import {
  IMPORTANCE_MIN,
  IMPORTANCE_MAX,
  isImportanceScore,
} from "@buildinternet/releases-core/importance";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import { rankEntityCandidates, ENTITY_CANDIDATE_LIMIT } from "@releases/lib/entity-match";
import { searchReleasesFts } from "@releases/search/releases-fts.js";
import type { Kind } from "@buildinternet/releases-core/kinds";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { normalizeDomain } from "@buildinternet/releases-core/domain";
import { getEntityType, normalizeReleaseId } from "@buildinternet/releases-core/id";
import { releaseWebUrl } from "@buildinternet/releases-core/release-slug";
import {
  buildChangelogResponse,
  formatChangelogSliceLine,
  hasRangeParams,
  resolveChangelogRangeParams,
  selectChangelogFile,
} from "@buildinternet/releases-core/changelog-slice";
import {
  OVERVIEW_STALE_DAYS,
  isOverviewContentStale,
  overviewContentAt,
  overviewPreview,
} from "@buildinternet/releases-core/overview";
import {
  foldSourcesIntoCatalog,
  mergeCollectionHits,
  type SearchCatalogHit,
  type SearchCollectionHit,
  type RawSourceHit,
} from "@buildinternet/releases-api-types";
import { parseNotice, formatNoticePointer } from "@buildinternet/releases-core/notice";
import {
  buildFeedCursor,
  getCollectionReleasesFeed,
} from "@releases/core-internal/collection-feed";
import {
  findProductById,
  findProductForOrgSlug,
  findSourceById,
  findSourceForOrgSlug,
} from "@releases/queries/entities";
import { findOrgByDomain, findProductsByDomain } from "@releases/queries/domain-lookup";
import {
  findOrgByAnyIdentifier,
  type OrgLookupRow,
  listOrgDirectoryPage,
  orgHasVisibleRelease,
} from "@releases/queries/orgs";
import { findVisibleReleaseDetail, listLatestReleases } from "@releases/queries/releases";
import {
  listReleaseLocationRows,
  type ReleaseLocationRow,
} from "@releases/queries/release-locations";
import {
  listCatalogProducts,
  listCatalogStandaloneSources,
  listProductSources,
} from "@releases/queries/catalog";
import {
  countCollections,
  findCollectionBySlug,
  findCollectionsByMemberOrgs,
  getCollectionFullMembers,
  listCollectionMemberIds,
  listCollectionsWhere,
  searchCollectionsDirect,
} from "@releases/queries/collections";
import type { D1Db } from "./db.js";
import {
  buildCursorMeta,
  buildPaginationMeta,
  decodeReleaseCursor,
  encodeReleaseCursor,
  parseFeedLimit,
  parseMcpPagination,
  renderPageFooter,
  slicePage,
  type ListNoun,
  type McpCursorPaginationMeta,
  type McpPagination,
  type McpPaginationInput,
  type McpPaginationMeta,
  type McpSearchMeta,
} from "./lib/pagination.js";

// `_meta` on tool results is supported by the MCP spec for out-of-band
// structured state. List/feed tools attach `_meta.pagination` (page-based on
// catalog-shaped surfaces, cursor-based on append-only feeds — discriminate by
// `"kind" in meta`); search tools attach `_meta.search` instead, since
// ranking-bounded results aren't a slice of a stable list.
export type ToolResult = {
  content: [{ type: "text"; text: string }];
  /**
   * Typed payload paired with the markdown `content[0].text` fallback. MCP App
   * UIs (see `apps/mcp/ui/`) read this directly so they don't have to parse
   * the rendered markdown. Hosts without UI support ignore the field and the
   * model uses the text content as before. Feed tools attach a
   * {@link ReleaseFeedStructured}; `get_release` attaches a
   * {@link ReleaseDetailStructured} for the App's drill-down view.
   */
  structuredContent?: ReleaseFeedStructured | ReleaseDetailStructured;
  _meta?: {
    pagination?: McpPaginationMeta | McpCursorPaginationMeta;
    search?: McpSearchMeta;
  };
  /**
   * Signals a tool-level failure (e.g. insufficient scope) without raising a
   * protocol error — the host surfaces `content[0].text` to the model so it can
   * adapt. Mirrors the MCP SDK's `CallToolResult.isError`.
   */
  isError?: boolean;
};

/**
 * Row shape consumed by the release-feed MCP App UI. Both `getLatestReleases`
 * and `getCollectionReleases` populate this from their respective DB rows so
 * the UI has one stable contract.
 */
export interface ReleaseFeedRow {
  id: string;
  title: string | null;
  titleShort: string | null;
  titleGenerated: string | null;
  version: string | null;
  type: "feature" | "rollup";
  summary: string | null;
  /** AI-scored importance 1–5 (5=landmark, 1=housekeeping); null when unscored. */
  importance: number | null;
  /** First ~500 chars of the release body, ready to display under the title. */
  contentPreview: string;
  publishedAt: string | null;
  url: string | null;
  /**
   * Absolute canonical web URL — the slugged `/release/<id>-<slug>` form
   * (#1906), built from `WEB_BASE_URL`. Distinct from `url` (the upstream
   * source URL). Lets agents cite/link the release detail page directly.
   */
  webUrl: string;
  /** `type` lets the UI branch GitHub (`org/repo` coordinate) vs. display name. */
  source: { name: string; coordinate: string; type: string };
  /**
   * Org identity for the feed's company icon + human-readable label.
   * `avatarUrl` is the stored avatar; `githubHandle` is the avatar fallback
   * (`github.com/{handle}.png`). Null only when a release has no resolvable org.
   */
  org: { name: string; slug: string; avatarUrl: string | null; githubHandle: string | null } | null;
  /** Optional product grouping; lets non-GitHub rows show a product name. */
  product: { name: string; slug: string } | null;
  /**
   * Cached release-body size (`LENGTH(content)` and `countTokensSafe`).
   * `null` for rows that pre-date the columns; the backfill script fills them
   * in. See #958.
   */
  contentChars?: number | null;
  contentTokens?: number | null;
}

// Explicit index signature makes this type structurally compatible with the
// MCP SDK's `structuredContent: { [x: string]: unknown }` constraint while
// keeping the known fields typed.
export interface ReleaseFeedStructured {
  [key: string]: unknown;
  releases: ReleaseFeedRow[];
  pagination: McpCursorPaginationMeta;
  /** Echo of the call's inputs so the UI can re-call with the next cursor. */
  inputs: Record<string, unknown>;
  /** Which tool produced this payload — picked up by the UI to chain calls. */
  toolName: "get_latest_releases" | "get_collection_releases";
  /** Optional collection header used by `get_collection_releases`. */
  context?: { collection?: { slug: string; name: string } };
}

/**
 * Shared mapper for the release-feed UI. Callers normalize their column
 * names to camelCase before calling; the `coordinate` is derived from the
 * `org`/`source` slugs the caller resolves. `webBase` builds the slugged
 * canonical `webUrl` (#1906).
 */
function toReleaseFeedRow(
  r: {
    id: string;
    title: string | null;
    titleShort: string | null;
    titleGenerated: string | null;
    version: string | null;
    type: string;
    summary: string | null;
    importance?: number | null;
    content: string | null;
    publishedAt: string | null;
    url: string | null;
    sourceName: string;
    sourceType: string;
    coordinate: string;
    orgName?: string | null;
    orgSlug?: string | null;
    orgAvatarUrl?: string | null;
    orgGithubHandle?: string | null;
    productName?: string | null;
    productSlug?: string | null;
    contentChars?: number | null;
    contentTokens?: number | null;
  },
  webBase: string,
): ReleaseFeedRow {
  return {
    id: r.id,
    title: r.title,
    titleShort: r.titleShort,
    titleGenerated: r.titleGenerated,
    version: r.version,
    type: r.type as "feature" | "rollup",
    summary: r.summary,
    importance: r.importance ?? null,
    contentPreview: (r.summary || r.content || "").slice(0, 500),
    publishedAt: r.publishedAt,
    url: r.url,
    webUrl: releaseWebUrl(webBase, r),
    source: { name: r.sourceName, coordinate: r.coordinate, type: r.sourceType },
    org: r.orgName
      ? {
          name: r.orgName,
          slug: r.orgSlug ?? "",
          avatarUrl: r.orgAvatarUrl ?? null,
          githubHandle: r.orgGithubHandle ?? null,
        }
      : null,
    product: r.productName ? { name: r.productName, slug: r.productSlug ?? "" } : null,
    contentChars: r.contentChars ?? null,
    contentTokens: r.contentTokens ?? null,
  };
}

/**
 * Per-section hit counts emitted by the search tools so `withSearchLog` in
 * `mcp-agent.ts` can populate `search_queries` rows with the same fields the
 * web/api surface logs (orgHits, catalogHits, releaseHits, chunkHits,
 * degraded). Search-tool functions return this alongside the rendered text
 * — see `SearchToolReturn`.
 */
export type SearchCounts = {
  orgHits?: number;
  catalogHits?: number;
  releaseHits?: number;
  chunkHits?: number;
  collectionHits?: number;
  degraded?: boolean;
  /**
   * Resolved product coordinate (`orgSlug/productSlug`) echoed from the
   * `search` function when a `product` filter was applied and matched. Picked
   * up by `withSearchLog` in `mcp-agent.ts` and embedded on `_meta.search`.
   */
  product?: string;
};

export type SearchToolReturn = { result: ToolResult; counts: SearchCounts };

function text(t: string): ToolResult {
  return { content: [{ type: "text" as const, text: t }] };
}

// Shared rendering for the four list_* tools. `body` is the joined per-row
// markdown (or empty when the page is past the end); `noun` keys the
// "no <noun> on this page" fallback and the footer.
function paginatedText(opts: {
  body: string;
  noun: ListNoun;
  pagination: McpPagination;
  returned: number;
  totalItems: number;
}): ToolResult {
  const footer = renderPageFooter(opts);
  const _meta = { pagination: buildPaginationMeta(opts) };
  const body =
    opts.returned === 0
      ? `No ${opts.noun} on this page.${footer ? `\n\n${footer}` : ""}`
      : footer
        ? `${opts.body}\n\n${footer}`
        : opts.body;
  return { content: [{ type: "text" as const, text: body }], _meta };
}

// Empty-state result for the case where pagination ran but the backing
// query returned zero rows total (so `paginatedText` would print a generic
// "no <noun> on this page" — callers want their own copy here). Carries
// `_meta.pagination` for symmetry with the populated path.
function emptyListResult(opts: { message: string; pagination: McpPagination }): ToolResult {
  return {
    content: [{ type: "text" as const, text: opts.message }],
    _meta: {
      pagination: buildPaginationMeta({
        pagination: opts.pagination,
        returned: 0,
        totalItems: 0,
      }),
    },
  };
}

// ── Shared helpers ───────────────────────────────────────────────────

function formatReleaseTitle(r: { title: string; type: ReleaseType }): string {
  return r.type === "rollup" ? `**${r.title}** _(rollup)_` : `**${r.title}**`;
}

/** One declared release location (#1947) rendered for the stub read surface. */
function formatLocationLine(row: ReleaseLocationRow): string {
  const kind = row.feed
    ? "feed"
    : row.github
      ? "github"
      : row.appstore
        ? "appstore"
        : row.file
          ? "file"
          : "url";
  const target = row.feed ?? row.github ?? row.appstore ?? row.file ?? row.url ?? "";
  const title = row.title ? `${row.title} — ` : "";
  const flags = [`${kind}`, ...(row.canonical ? ["canonical"] : []), `basis: ${row.basis}`].join(
    ", ",
  );
  return `- ${title}${target} (${flags})`;
}

/** Chars of body inlined per release in a feed's model-facing text. */
const FEED_PREVIEW_CHARS = 500;

/** Compact human size for the meta line; tokens preferred, chars as fallback. */
function formatSizeLabel(chars?: number | null, tokens?: number | null): string | null {
  if (tokens != null && tokens > 0) return `~${tokens} tokens`;
  if (chars != null && chars > 0) return `${chars} chars`;
  return null;
}

/** Normalized row for {@link renderFeedReleaseText}. */
interface FeedReleaseTextRow {
  id: string;
  title: string;
  type: ReleaseType;
  version: string | null;
  publishedAt: string | null;
  summary: string | null;
  importance?: number | null;
  content: string | null;
  sourceName: string;
  coordinate: string;
  orgName?: string | null;
  orgSlug?: string | null;
  contentChars?: number | null;
  contentTokens?: number | null;
}

/**
 * Render one release into the model-facing text block shared by
 * `get_latest_releases` and `get_collection_releases`. Each block is
 * self-describing: it always carries the release `id` (the handle for
 * `get_release`), surfaces a content-size signal, and appends a `get_release`
 * hint only when the inlined preview is shorter than the full body — so short,
 * fully-shown releases don't get a wasted "fetch more" nudge.
 */
function renderFeedReleaseText(r: FeedReleaseTextRow): string {
  const previewSource = r.summary || r.content || "";
  const preview = previewSource.slice(0, FEED_PREVIEW_CHARS);

  const metaParts: string[] = [];
  if (r.orgName) metaParts.push(`Org: ${r.orgName}${r.orgSlug ? ` (${r.orgSlug})` : ""}`);
  metaParts.push(`Source: ${r.sourceName} (${r.coordinate})`);
  metaParts.push(`Version: ${r.version ?? "N/A"}`);
  metaParts.push(`Date: ${r.publishedAt ?? "N/A"}`);
  if (r.importance != null) metaParts.push(`Importance: ${r.importance}/5`);
  const sizeLabel = formatSizeLabel(r.contentChars, r.contentTokens);
  if (sizeLabel) metaParts.push(sizeLabel);

  const lines = [formatReleaseTitle(r), `ID: ${r.id}`, metaParts.join(" | "), preview];

  // Fall back to the live body length for legacy rows where contentChars is
  // null — otherwise a long body hidden behind a short summary preview never
  // gets the "fetch more" hint.
  const effectiveContentLen = r.contentChars ?? r.content?.length ?? 0;
  const truncated =
    effectiveContentLen > preview.length || previewSource.length > FEED_PREVIEW_CHARS;
  if (truncated) {
    lines.push(`_Preview truncated — call get_release(id: "${r.id}") for the full release._`);
  }
  return lines.join("\n");
}

/**
 * Returns true when `identifier` looks like a bare slug (no `src_`/`prod_`
 * prefix, no `org/slug` separator). Used by tool handlers to emit a helpful
 * migration hint before the API's bare-path 400 lands (issue #698).
 *
 * Trims input — agents commonly pass copy-pasted identifiers with stray
 * whitespace, and a leading/trailing space would otherwise sneak past the
 * guard and reach the slug fallback path.
 */
export function isBareSlug(identifier: string): boolean {
  const t = identifier.trim();
  return getEntityType(t) === "unknown" && !t.includes("/");
}

/**
 * Build an `IN (...)` value list from a `product`-scope source-ID set, chunked
 * at 90 IDs to stay inside D1's 100-bound limit. Callers guard the empty case
 * before reaching here (an empty product short-circuits to no hits).
 */
function sourceIdInList(sourceIds: string[]) {
  return sql`(${sql.join(
    sourceIds.slice(0, 90).map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

/** Split a `GROUP_CONCAT(domain)` column back into hostnames (commas can't
 * appear inside a hostname, so the default separator is unambiguous). Mirrors
 * the API worker's helper so the entity-match domain ranking sees the same
 * alias set. */
function splitConcat(value: string | null): string[] {
  return value ? value.split(",") : [];
}

/**
 * Parse an `org/slug` coordinate into its two parts.  Returns `null` when
 * the string doesn't contain exactly one `/` separator.
 */
function parseOrgSlugCoordinate(identifier: string): { orgSlug: string; slug: string } | null {
  const parts = identifier.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { orgSlug: parts[0], slug: parts[1] };
}

/** One disambiguation candidate carried by an {@link AmbiguousEntityError}. */
export type AmbiguousCandidate = { orgSlug: string; slug: string; id: string };

/**
 * Thrown by {@link resolveSource} / {@link resolveProduct} when a bare slug is
 * owned by more than one org. Source/product slugs are unique per-org but not
 * globally (#690), so a bare slug like "blog" can match several orgs. Rather
 * than silently `.limit(1)`-ing onto an arbitrary row (which could read from —
 * or, for a future mutating caller, write to — the wrong org), the resolver
 * throws this so the caller surfaces the `org/slug` + typed-id escape hatches.
 * The `message` is model-readable and lists every candidate, so it stays
 * useful even if it ever propagates uncaught. Mirrors the CLI's
 * AmbiguousSourceError (releases-cli#267); see #1324.
 */
export class AmbiguousEntityError extends Error {
  readonly entity: "source" | "product";
  readonly slug: string;
  readonly candidates: AmbiguousCandidate[];
  constructor(entity: "source" | "product", slug: string, candidates: AmbiguousCandidate[]) {
    const lines = candidates.map((c) => `  • ${c.orgSlug}/${c.slug}  (${c.id})`);
    super(
      `Bare slug "${slug}" matches ${candidates.length} ${entity}s across orgs — slugs are org-scoped.\n` +
        `Re-run with an org-scoped identifier:\n` +
        lines.join("\n"),
    );
    this.name = "AmbiguousEntityError";
    this.entity = entity;
    this.slug = slug;
    this.candidates = candidates;
  }
}

/**
 * Render an {@link AmbiguousEntityError} as a (non-error) tool result so the
 * model reads the candidate list as guidance and self-corrects, matching how
 * the caller-side `isBareSlug()` guards already respond to bare slugs.
 */
export function ambiguousEntityToolResult(err: AmbiguousEntityError): ToolResult {
  return text(err.message);
}

/**
 * Map slug-matched rows (each `org`-joined in the enumeration query) into
 * sorted {@link AmbiguousCandidate}s for an {@link AmbiguousEntityError}.
 */
function toAmbiguousCandidates(
  matches: { row: { id: string; slug: string }; orgSlug: string | null }[],
): AmbiguousCandidate[] {
  return matches
    .map((m) => ({ orgSlug: m.orgSlug ?? "?", slug: m.row.slug, id: m.row.id }))
    .toSorted((a, b) => `${a.orgSlug}/${a.slug}`.localeCompare(`${b.orgSlug}/${b.slug}`));
}

export async function resolveSource(db: D1Db, identifier: string) {
  const id = identifier.trim();
  // Typed-ID and `org/slug` branches share the API's resolvers
  // (`@releases/queries/entities`), so soft-deleted rows 404 here too.
  if (getEntityType(id) === "source") {
    return findSourceById(db, id);
  }

  // org/slug coordinate form (e.g. "vercel/next-js")
  const coord = parseOrgSlugCoordinate(id);
  if (coord) return findSourceForOrgSlug(db, coord.orgSlug, coord.slug);

  // Bare slug fallback. Source slugs are unique per-org but NOT globally
  // (#690), so enumerate every org's match instead of `.limit(1)`-ing onto an
  // arbitrary one — org-joined so an ambiguous result can echo org/slug + src_…
  // candidates: 0 → null, 1 → resolve, >1 → throw rather than silently
  // resolving the wrong org (#1324, mirroring releases-cli#267). Callers still
  // short-circuit bare slugs with isBareSlug() for a friendlier hint; this is
  // the safety net so correctness no longer depends on every caller remembering
  // that guard.
  const matches = await db
    .select({ row: sources, orgSlug: organizations.slug })
    .from(sources)
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .where(and(eq(sources.slug, id), isNull(sources.deletedAt)));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].row;
  throw new AmbiguousEntityError("source", id, toAmbiguousCandidates(matches));
}

export async function resolveProduct(db: D1Db, identifier: string) {
  const id = identifier.trim();
  if (getEntityType(id) === "product") {
    return findProductById(db, id);
  }

  // org/slug coordinate form (e.g. "vercel/nextjs")
  const coord = parseOrgSlugCoordinate(id);
  if (coord) return findProductForOrgSlug(db, coord.orgSlug, coord.slug);

  // Bare slug fallback — see resolveSource for the per-org ambiguity rationale
  // (#1324). 0 → null, 1 → resolve, >1 → throw with prod_… candidates.
  const matches = await db
    .select({ row: products, orgSlug: organizations.slug })
    .from(products)
    .leftJoin(organizations, eq(products.orgId, organizations.id))
    .where(and(eq(products.slug, id), isNull(products.deletedAt)));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].row;
  throw new AmbiguousEntityError("product", id, toAmbiguousCandidates(matches));
}

/**
 * Resolve a catalog identifier (source `src_` id, product `prod_` id,
 * `org/slug` coordinate, or ambiguous slug) to the set of source IDs to
 * filter on.  Returns `null` when nothing matches so callers can echo the
 * identifier back in the error.
 */
async function resolveEntityToSourceIds(db: D1Db, identifier: string): Promise<string[] | null> {
  const id = identifier.trim();
  const entityType = getEntityType(id);

  if (entityType === "source") {
    const src = await resolveSource(db, id);
    return src ? [src.id] : null;
  }

  if (entityType === "product") {
    const prod = await resolveProduct(db, id);
    if (!prod) return null;
    const rows = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.productId, prod.id));
    return rows.map((r) => r.id);
  }

  // org/slug coordinate — determine whether it resolves to a source or product
  const coord = parseOrgSlugCoordinate(id);
  if (coord) {
    const src = await resolveSource(db, id);
    if (src) return [src.id];
    const prod = await resolveProduct(db, id);
    if (!prod) return null;
    const rows = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.productId, prod.id));
    return rows.map((r) => r.id);
  }

  // Ambiguous slug: one query against sources joined to their optional
  // product — matches either directly (source slug) or transitively
  // (every source under a product with that slug).
  const rows = await db.all<{ id: string }>(sql`
    SELECT s.id as id FROM sources s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.slug = ${id} OR p.slug = ${id}
  `);
  return rows.length > 0 ? rows.map((r) => r.id) : null;
}

/**
 * Resolve optional `since`/`until` tool inputs to canonical ISO bounds on
 * `published_at`. Mirrors the API's `parseTimeWindow` — accepts an ISO
 * date/datetime or relative shorthand (`90d`/`4w`/`6m`/`2y`). On a miss it
 * returns a model-readable error message instead of an HTTP 400.
 */
function resolveToolWindow(params: {
  since?: string;
  until?: string;
}): { ok: true; since?: string; until?: string } | { ok: false; message: string } {
  const hint = "must be an ISO date/datetime or relative shorthand (e.g. 90d, 4w, 6m, 2y)";
  let since: string | undefined;
  let until: string | undefined;
  if (params.since) {
    const resolved = resolveDateParam(params.since);
    if (resolved === null)
      return { ok: false, message: `Invalid \`since\` "${params.since}" — ${hint}.` };
    since = resolved;
  }
  if (params.until) {
    const resolved = resolveDateParam(params.until);
    if (resolved === null)
      return { ok: false, message: `Invalid \`until\` "${params.until}" — ${hint}.` };
    until = resolved;
  }
  if (since !== undefined && until !== undefined && since > until) {
    return { ok: false, message: "`since` must not be after `until`." };
  }
  return { ok: true, since, until };
}

/**
 * Validate an optional `minImportance` tool input against the shared
 * {@link isImportanceScore} range check — mirrors the REST `?minImportance=`
 * validation in `apps/api/src/routes/releases.ts` exactly (integer,
 * `IMPORTANCE_MIN`–`IMPORTANCE_MAX`). Zod already enforces this bound at the
 * MCP-server input-schema layer for real callers (see `mcp-agent.ts`); this
 * is the same check applied defensively for callers of the exported function
 * directly (tests, and any future non-server caller).
 */
function validateMinImportance(
  value: number | undefined,
): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (!isImportanceScore(value)) {
    return {
      ok: false,
      message: `\`minImportance\` must be an integer between ${IMPORTANCE_MIN} and ${IMPORTANCE_MAX}.`,
    };
  }
  return { ok: true, value };
}

// ── get_latest_releases ──────────────────────────────────────────────

export async function getLatestReleases(
  db: D1Db,
  params: {
    product?: string;
    organization?: string;
    type?: ReleaseType;
    kind?: Kind;
    limit?: number;
    cursor?: string;
    include_coverage?: boolean;
    include_prereleases?: boolean;
    since?: string;
    until?: string;
    minImportance?: number;
  },
  webBase: string,
): Promise<ToolResult> {
  const limit = parseFeedLimit(params.limit ?? 10);
  const window = resolveToolWindow(params);
  if (!window.ok) return text(window.message);
  const minImportance = validateMinImportance(params.minImportance);
  if (!minImportance.ok) return text(minImportance.message);
  const includeCoverage = params.include_coverage === true;

  // `product` resolves a product (or source) identifier to one or more source
  // IDs.  `resolveEntityToSourceIds` handles all identifier forms:
  //   • `prod_…` typed ID → all sources under the product
  //   • `src_…` typed ID → single source
  //   • `orgSlug/productSlug` coordinate → product first, then source fallback
  // This mirrors the REST ?product= expansion in `getOrgReleasesFeed` so an
  // MCP caller gets the same cross-source product feed as the web frontend.
  let productSourceIds: string[] | undefined;
  if (params.product) {
    if (isBareSlug(params.product)) {
      return text(
        `Bare slug "${params.product}" is ambiguous — identifiers are org-scoped.\n` +
          `Use an org-scoped identifier instead:\n` +
          `  • Product ID:  prod_<id>\n` +
          `  • Source ID:   src_<id>\n` +
          `  • Coordinate:  <orgSlug>/<productSlug>  (e.g. "vercel/next-js")`,
      );
    }
    const resolved = await resolveEntityToSourceIds(db, params.product);
    if (!resolved || resolved.length === 0)
      return text(`No product or source found matching "${params.product}"`);
    productSourceIds = resolved;
  }

  let orgId: string | undefined;
  if (params.organization) {
    const org = await findOrgByAnyIdentifier(db, params.organization);
    if (!org) return text(`No organization found matching "${params.organization}"`);
    orgId = org.id;
  }

  // Cursor decode: silently ignore unparseable tokens rather than 400. The
  // feed is append-only and stable under cursor inserts, so a stale cursor
  // just gives the caller a fresh head of the feed.
  const after = params.cursor ? decodeReleaseCursor(params.cursor) : null;

  // Shared with the API's visibility rules (`@releases/queries/releases`):
  // hidden/deleted sources, deleted products, and hidden/deleted orgs drop
  // out. Fetch limit+1 to detect hasMore without a COUNT — feeds don't carry
  // a totalItems anyway.
  const rows = await listLatestReleases(db, {
    sourceIds: productSourceIds,
    orgId,
    type: params.type,
    kind: params.kind,
    since: window.since,
    until: window.until,
    minImportance: minImportance.value,
    includeCoverage,
    includePrereleases: params.include_prereleases === true,
    // See {@link getOrgReleasesFeed} for the future-dated guardrail rationale.
    notAfter: nowIso(),
    after,
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeReleaseCursor({
      lastPublishedAt: last.publishedAt ?? null,
      lastId: last.id,
    });
  }

  const cursorMeta = buildCursorMeta({
    returned: pageRows.length,
    limit,
    hasMore,
    nextCursor,
  });

  if (pageRows.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No releases found." }],
      structuredContent: {
        releases: [],
        pagination: cursorMeta,
        inputs: { ...params },
        toolName: "get_latest_releases" as const,
      },
      _meta: { pagination: cursorMeta },
    };
  }

  const structuredRows: ReleaseFeedRow[] = [];
  const textParts: string[] = [];
  for (const r of pageRows) {
    const coordinate = r.orgSlug ? `${r.orgSlug}/${r.sourceSlug}` : r.sourceSlug;
    structuredRows.push(toReleaseFeedRow({ ...r, coordinate }, webBase));
    textParts.push(
      renderFeedReleaseText({
        id: r.id,
        title: r.title,
        type: r.type as ReleaseType,
        version: r.version,
        publishedAt: r.publishedAt,
        summary: r.summary,
        importance: r.importance,
        content: r.content,
        sourceName: r.sourceName,
        coordinate,
        orgName: r.orgName,
        orgSlug: r.orgSlug,
        contentChars: r.contentChars,
        contentTokens: r.contentTokens,
      }),
    );
  }
  const body = textParts.join("\n\n---\n\n");

  // LLM-readable continuation hint, mirroring the page-based footer pattern.
  const footer = hasMore
    ? `\n\n_Showing ${pageRows.length} of more. Pass \`cursor: "${nextCursor}", limit: ${limit}\` to continue._`
    : "";

  return {
    content: [{ type: "text" as const, text: body + footer }],
    structuredContent: {
      releases: structuredRows,
      pagination: cursorMeta,
      inputs: { ...params },
      toolName: "get_latest_releases" as const,
    },
    _meta: { pagination: cursorMeta },
  };
}

// ── list_organizations ───────────────────────────────────────────────

export async function listOrganizations(
  db: D1Db,
  params: {
    query?: string;
    platform?: string;
    include_empty?: boolean;
    category?: string;
  } & McpPaginationInput,
): Promise<ToolResult> {
  const pagination = parseMcpPagination(params);

  // #746: default `false` — orgs with no indexed releases are stubs we hide
  // from the public catalog. Opt in via `include_empty: true` to see them.
  const includeEmpty = params.include_empty === true;
  // Optional category filter. Resolve aliases (e.g. "e-commerce" → "commerce")
  // to their canonical slug via the shared resolver, matching the REST
  // `/v1/orgs?category=` read filter (#1277); unknown values fail open to
  // unfiltered.
  const categoryResolved = params.category
    ? await resolveCategoryInput(db, params.category)
    : undefined;
  const category = categoryResolved?.ok ? categoryResolved.slug : undefined;

  // Hidden and soft-deleted orgs never list, matching the API directory. The
  // broader query match (domain, alias, handle) and `platform` are MCP-only.
  const { rows, total: totalItems } = await listOrgDirectoryPage(db, {
    query: params.query,
    platform: params.platform,
    category,
    includeEmpty,
    limit: pagination.pageSize,
    offset: pagination.offset,
  });
  if (totalItems === 0) return emptyListResult({ message: "No organizations found.", pagination });

  const body = rows
    .map((o) =>
      [
        `**${o.name}**${o.tier === "stub" ? " _(stub)_" : ""}`,
        `  Slug: ${o.slug}`,
        `  Domain: ${o.domain ?? "N/A"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return paginatedText({
    body,
    noun: "organizations",
    pagination,
    returned: rows.length,
    totalItems,
  });
}

// ── get_organization ─────────────────────────────────────────────────

export async function getOrganization(
  db: D1Db,
  params: { identifier: string; include_overview?: boolean },
): Promise<ToolResult> {
  const org = await findOrgByAnyIdentifier(db, params.identifier);
  if (!org) return text(`No organization found matching "${params.identifier}"`);
  const includeOverview = params.include_overview === true;

  const [accounts, tagRows, orgSources, orgProducts, aliases, overviewRow, orgCollections] =
    await Promise.all([
      db
        .select({ platform: orgAccounts.platform, handle: orgAccounts.handle })
        .from(orgAccounts)
        .where(eq(orgAccounts.orgId, org.id)),
      db
        .select({ name: tags.name })
        .from(orgTags)
        .innerJoin(tags, eq(orgTags.tagId, tags.id))
        .where(eq(orgTags.orgId, org.id)),
      db
        .select({
          slug: sources.slug,
          name: sources.name,
          type: sources.type,
          url: sources.url,
          lastFetchedAt: sources.lastFetchedAt,
        })
        .from(sources)
        .where(
          and(
            eq(sources.orgId, org.id),
            isNull(sources.deletedAt),
            or(eq(sources.isHidden, false), isNull(sources.isHidden)),
          ),
        ),
      db
        .select({
          slug: products.slug,
          name: products.name,
          url: products.url,
          description: products.description,
        })
        .from(products)
        .where(
          and(
            eq(products.orgId, org.id),
            sql`EXISTS (
              SELECT 1 FROM sources_visible sv
              WHERE sv.product_id = ${products.id}
            )`,
          ),
        ),
      db
        .select({ domain: domainAliases.domain })
        .from(domainAliases)
        .where(eq(domainAliases.orgId, org.id)),
      db
        .select({
          content: knowledgePages.content,
          generatedAt: knowledgePages.generatedAt,
          updatedAt: knowledgePages.updatedAt,
          releaseCount: knowledgePages.releaseCount,
        })
        .from(knowledgePages)
        .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, org.id)))
        .limit(1),
      getCollectionsForOrg(db, org.id),
    ]);

  const lines: string[] = [];

  lines.push(`**Organization: ${org.name}**`);
  lines.push(
    `Slug: ${org.slug} | Domain: ${org.domain ?? "N/A"} | Category: ${org.category ?? "N/A"}`,
  );
  if (org.tier === "stub") {
    lines.push(
      "Status: stub — not yet processed. Release info is published at the locations listed below.",
    );
  }
  if (org.description) lines.push(`Description: ${org.description}`);
  const notice = parseNotice(org.metadata);
  if (notice) lines.push(`Notice: ${formatNoticePointer(notice)}`);

  const overview = overviewRow[0];
  if (overview?.content) {
    // Prefer updatedAt for age/stale: generatedAt is fixed at first write and
    // stays old after amends (e.g. generated 3mo ago, updated 4d ago).
    const stale = isOverviewContentStale(overview);
    const contentAge = timeAgo(overviewContentAt(overview)) ?? "unknown";
    const generatedAge = timeAgo(overview.generatedAt) ?? "unknown";
    const ageLabel =
      overview.updatedAt && overview.updatedAt !== overview.generatedAt
        ? `updated ${contentAge}, generated ${generatedAge}`
        : `generated ${contentAge}`;
    lines.push("");
    lines.push(`**Overview** (${ageLabel}, ${overview.releaseCount} releases)`);
    if (stale) {
      lines.push(
        `⚠ Overview is older than ${OVERVIEW_STALE_DAYS} days — may not reflect recent releases.`,
      );
    }
    if (includeOverview) {
      lines.push(overview.content);
    } else {
      lines.push(overviewPreview(overview.content));
      lines.push("_Pass `include_overview: true` to read the full overview._");
    }
  }

  lines.push("");

  if (accounts.length > 0) {
    lines.push(`Accounts: ${accounts.map((a) => `${a.platform}/${a.handle}`).join(", ")}`);
  } else {
    lines.push("Accounts: none");
  }

  if (tagRows.length > 0) {
    lines.push(`Tags: ${tagRows.map((t) => t.name).join(", ")}`);
  } else {
    lines.push("Tags: none");
  }

  if (aliases.length > 0) {
    lines.push(`Aliases: ${aliases.map((a) => a.domain).join(", ")}`);
  } else {
    lines.push("Aliases: none");
  }

  if (orgCollections.length > 0) {
    lines.push(`Collections: ${orgCollections.map((c) => `${c.name} (${c.slug})`).join(", ")}`);
  }

  if (orgProducts.length > 0) {
    lines.push("");
    lines.push("Products:");
    for (const p of orgProducts) {
      const urlPart = p.url ? ` — ${p.url}` : "";
      const descPart = p.description ? ` — ${p.description}` : "";
      lines.push(`- ${p.name} (${org.slug}/${p.slug})${urlPart}${descPart}`);
    }
  }

  if (orgSources.length > 0) {
    lines.push("");
    lines.push("Sources:");
    for (const s of orgSources) {
      lines.push(`- **${s.name}** (${org.slug}/${s.slug})`);
      lines.push(`  Type: ${s.type} | URL: ${s.url}`);
      lines.push(`  Last fetched: ${s.lastFetchedAt ?? "Never"}`);
    }
  } else if (org.tier === "stub") {
    // A stub has no sources by design — its declared locations are the answer.
    const locations = await listReleaseLocationRows(db, org.id);
    lines.push("");
    if (locations.length > 0) {
      lines.push("Declared release locations (not yet processed):");
      for (const loc of locations) lines.push(formatLocationLine(loc));
    } else {
      lines.push("Declared release locations: none yet");
    }
  } else {
    lines.push("");
    lines.push("Sources: none");
  }

  return text(lines.join("\n"));
}

// ── lookup_domain ────────────────────────────────────────────────────

/**
 * Pure resolution: normalize the domain, exact-match against
 * `organizations.domain` and `domain_aliases.domain`, and return the
 * matching org (with aliases) plus any products whose alias targets the
 * domain. Mirrors `GET /v1/lookups/by-domain` on the API. Unknown domains
 * surface as a "not found" message unless the API just-in-time materializes
 * a stub from `/.well-known/releases.json` (#2030).
 */
export async function lookupDomain(db: D1Db, params: { domain: string }): Promise<ToolResult> {
  const domain = normalizeDomain(params.domain);
  if (!domain) {
    return text(
      `"${params.domain}" doesn't look like a valid hostname (need at least \`example.com\`).`,
    );
  }

  const [orgRow, productRows] = await Promise.all([
    findOrgByDomain(db, domain),
    findProductsByDomain(db, domain),
  ]);

  if (!orgRow && productRows.length === 0) {
    return text(`No org or product owns the domain \`${domain}\` in this registry.`);
  }

  const lines: string[] = [`**Domain:** \`${domain}\``];

  if (orgRow) {
    lines.push("", `## Organization`);
    lines.push(
      `**${orgRow.name}** \`${orgRow.slug}\` — matched via ${orgRow.matchedVia}` +
        (orgRow.matchedVia === "alias" && orgRow.domain
          ? ` (primary domain: \`${orgRow.domain}\`)`
          : ""),
    );
    if (orgRow.category) lines.push(`Category: ${orgRow.category}`);
    if (orgRow.description) lines.push(orgRow.description);
    if (orgRow.tier === "stub") {
      const locations = await listReleaseLocationRows(db, orgRow.id);
      lines.push(
        "",
        "Status: stub — not yet processed. Release info is published at these locations:",
      );
      if (locations.length > 0) {
        for (const loc of locations) lines.push(formatLocationLine(loc));
      } else {
        lines.push("- (none declared yet)");
      }
    }
  }

  if (productRows.length > 0) {
    lines.push("", `## Products`);
    for (const p of productRows) {
      const cat = p.category ? ` | ${p.category}` : "";
      lines.push(`- **${p.name}** \`${p.orgSlug}/${p.slug}\` (org: ${p.orgName})${cat}`);
    }
  }

  return text(lines.join("\n"));
}

// ── get_release ──────────────────────────────────────────────────────

/**
 * Structured detail payload for the release-feed MCP App's lazy-fetch
 * drill-down. Mirrors {@link ReleaseFeedRow} but carries the full `content`
 * body. Attached alongside the text fallback so non-app hosts and the model
 * are unaffected.
 */
export interface ReleaseDetailStructured {
  [key: string]: unknown;
  id: string;
  title: string | null;
  titleShort: string | null;
  titleGenerated: string | null;
  version: string | null;
  type: "feature" | "rollup";
  content: string;
  summary: string | null;
  /** AI-scored importance 1–5 (5=landmark, 1=housekeeping); null when unscored. */
  importance: number | null;
  publishedAt: string | null;
  url: string | null;
  /** Absolute slugged canonical web URL (#1906); distinct from upstream `url`. */
  webUrl: string;
  source: { name: string; coordinate: string; type: string };
  org: { name: string; slug: string; avatarUrl: string | null; githubHandle: string | null } | null;
  product: { name: string; slug: string } | null;
}

export async function getRelease(
  db: D1Db,
  params: { id: string },
  webBase: string,
): Promise<ToolResult> {
  const id = normalizeReleaseId(params.id);

  // Same read as `GET /v1/releases/:id` (`@releases/queries/releases`):
  // suppressed and coverage-side releases, and releases whose source is
  // missing, hidden, or deleted, are not found. Deleted org/product parents
  // come back with null names.
  const detail = await findVisibleReleaseDetail(db, id);
  if (!detail) return text(`No release found matching "${params.id}"`);
  const { release, ...parents } = detail;
  const r = { ...release, ...parents };

  const body = r.content && r.content.length > 0 ? r.content : (r.summary ?? "");

  const lines: string[] = [];
  const titleLine = formatReleaseTitle(r);
  lines.push(titleLine);
  lines.push(`ID: ${r.id}`);
  if (r.version) lines.push(`Version: ${r.version}`);
  if (r.publishedAt) lines.push(`Published: ${r.publishedAt}`);
  if (r.importance != null) lines.push(`Importance: ${r.importance}/5`);
  lines.push(`Source: ${r.sourceName ?? "Unknown"}${r.sourceSlug ? ` (${r.sourceSlug})` : ""}`);
  if (r.orgName) {
    lines.push(`Organization: ${r.orgName}${r.orgSlug ? ` (${r.orgSlug})` : ""}`);
  }
  if (r.url) lines.push(`URL: ${r.url}`);
  const webUrl = releaseWebUrl(webBase, r);
  lines.push(`Web: ${webUrl}`);
  lines.push("");
  lines.push(body);

  const coordinate = r.orgSlug ? `${r.orgSlug}/${r.sourceSlug}` : (r.sourceSlug ?? "");
  const structuredContent: ReleaseDetailStructured = {
    id: r.id,
    title: r.title,
    titleShort: r.titleShort,
    titleGenerated: r.titleGenerated,
    version: r.version,
    type: r.type as "feature" | "rollup",
    content: body,
    summary: r.summary,
    importance: r.importance ?? null,
    publishedAt: r.publishedAt,
    url: r.url,
    webUrl,
    source: { name: r.sourceName ?? "Unknown", coordinate, type: r.sourceType ?? "" },
    org: r.orgName
      ? {
          name: r.orgName,
          slug: r.orgSlug ?? "",
          avatarUrl: r.orgAvatarUrl ?? null,
          githubHandle: r.orgGithubHandle ?? null,
        }
      : null,
    product: r.productName ? { name: r.productName, slug: r.productSlug ?? "" } : null,
  };

  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent };
}

// ── renderSourceDetail ───────────────────────────────────────────────

/**
 * Options for inlining a CHANGELOG slice in a source-detail response.
 * Any field set flips the renderer from "list files" mode to "embed
 * a slice". `include` is the zero-param embed trigger: it only adds
 * information when the caller passes no path/offset/limit/tokens.
 */
interface ChangelogRenderOptions {
  include?: boolean;
  path?: string;
  offset?: number;
  limit?: number;
  tokens?: number;
}

async function renderSourceDetail(
  db: D1Db,
  src: Awaited<ReturnType<typeof resolveSource>> & object,
  changelog?: ChangelogRenderOptions,
): Promise<ToolResult> {
  const [orgRows, productRows, relCountRows, changelogMeta] = await Promise.all([
    src.orgId
      ? db
          .select({ slug: organizations.slug, name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, src.orgId))
          .limit(1)
      : Promise.resolve([]),
    src.productId
      ? db
          .select({ slug: products.slug, name: products.name })
          .from(products)
          .where(eq(products.id, src.productId))
          .limit(1)
      : Promise.resolve([]),
    db
      .select({ n: sql<number>`count(*)` })
      .from(releasesVisible)
      .where(eq(releasesVisible.sourceId, src.id)),
    // Metadata-only. `content` can be up to 1MB per row on monorepos with
    // many package CHANGELOGs — only pulled when the caller embeds a slice.
    db
      .select({
        id: sourceChangelogFiles.id,
        path: sourceChangelogFiles.path,
        filename: sourceChangelogFiles.filename,
        url: sourceChangelogFiles.url,
        rawUrl: sourceChangelogFiles.rawUrl,
        bytes: sourceChangelogFiles.bytes,
        tokens: sourceChangelogFiles.tokens,
        fetchedAt: sourceChangelogFiles.fetchedAt,
      })
      .from(sourceChangelogFiles)
      .where(eq(sourceChangelogFiles.sourceId, src.id))
      .orderBy(sourceChangelogFiles.path),
  ]);

  const org = orgRows[0] ?? null;
  const product = productRows[0] ?? null;
  const releaseCount = Number(relCountRows[0]?.n ?? 0);

  const srcCoord = org ? `${org.slug}/${src.slug}` : src.slug;
  const lines: string[] = [];
  lines.push(`**Source: ${src.name}**`);
  lines.push(`Slug: ${srcCoord} | Type: ${src.type}`);
  lines.push(`URL: ${src.url}`);
  lines.push(`Organization: ${org ? `${org.name} (${org.slug})` : "none"}`);
  lines.push(`Product: ${product ? `${product.name} (${product.slug})` : "none"}`);
  lines.push(`Release count: ${releaseCount}`);
  lines.push(`Last fetched: ${src.lastFetchedAt ?? "Never"}`);
  const notice = parseNotice(src.metadata);
  if (notice) lines.push(`Notice: ${formatNoticePointer(notice)}`);

  if (changelogMeta.length === 0) {
    lines.push("Changelog files tracked: none");
    return text(lines.join("\n"));
  }

  lines.push("");
  lines.push(`Changelog files tracked (${changelogMeta.length}):`);
  for (const f of changelogMeta) {
    lines.push(`  - ${f.path} (${f.bytes} bytes)`);
  }

  const rangeParams = resolveChangelogRangeParams({
    offset: changelog?.offset,
    limit: changelog?.limit,
    tokens: changelog?.tokens,
  });
  const wantEmbed =
    changelog?.include === true || changelog?.path !== undefined || hasRangeParams(rangeParams);

  if (!wantEmbed) {
    lines.push(
      "Pass `include_changelog: true` to inline the root CHANGELOG. Set `changelog_path` to target a specific file, or `changelog_offset` / `changelog_limit` / `changelog_tokens` to slice.",
    );
    return text(lines.join("\n"));
  }

  const selected = selectChangelogFile(changelogMeta, changelog?.path ?? null);
  if (!selected) {
    lines.push("");
    lines.push(
      `No CHANGELOG file found at path "${changelog?.path}". Use one of the paths listed above.`,
    );
    return text(lines.join("\n"));
  }

  const [contentRow] = await db
    .select({ content: sourceChangelogFiles.content })
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.id, selected.id))
    .limit(1);

  const files = changelogMeta.map((r) => ({
    path: r.path,
    filename: r.filename,
    url: r.url,
    bytes: r.bytes,
    fetchedAt: r.fetchedAt,
  }));

  const response = buildChangelogResponse(
    { ...selected, content: contentRow?.content ?? "" },
    rangeParams,
    files,
  );

  lines.push("");
  lines.push(`**${response.path}**`);
  lines.push(`Source: ${response.url}`);
  lines.push(formatChangelogSliceLine(response));
  if (response.truncated) {
    lines.push(
      `⚠ TRUNCATED: upstream file exceeds 1MB cap, content cut at byte ${response.truncatedAt}. Tail is missing.`,
    );
  }
  lines.push("");
  lines.push(response.content);

  return text(lines.join("\n"));
}

async function renderProductDetail(
  db: D1Db,
  product: Awaited<ReturnType<typeof resolveProduct>> & object,
): Promise<ToolResult> {
  const [orgRows, productSources, tagRows] = await Promise.all([
    db
      .select({ slug: organizations.slug, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, product.orgId))
      .limit(1),
    // Hidden and deleted sources drop out, as in `GET /v1/products/:id`.
    listProductSources(db, product.id),
    db
      .select({ name: tags.name })
      .from(productTags)
      .innerJoin(tags, eq(productTags.tagId, tags.id))
      .where(eq(productTags.productId, product.id)),
  ]);
  const orgRow = orgRows[0] ?? null;

  const lines: string[] = [];
  lines.push(`**Product: ${product.name}**`);
  lines.push(
    `Slug: ${product.slug} | Organization: ${orgRow ? `${orgRow.name} (${orgRow.slug})` : "N/A"} | Category: ${product.category ?? "N/A"}`,
  );
  if (product.url) lines.push(`URL: ${product.url}`);
  if (product.description) lines.push(`Description: ${product.description}`);
  const notice = parseNotice(product.metadata);
  if (notice) lines.push(`Notice: ${formatNoticePointer(notice)}`);

  lines.push("");
  lines.push(tagRows.length > 0 ? `Tags: ${tagRows.map((t) => t.name).join(", ")}` : "Tags: none");

  if (productSources.length > 0) {
    lines.push("");
    lines.push("Sources:");
    for (const s of productSources) {
      const srcCoord = orgRow ? `${orgRow.slug}/${s.slug}` : s.slug;
      lines.push(`- **${s.name}** (${srcCoord})`);
      lines.push(`  Type: ${s.type} | URL: ${s.url}`);
      lines.push(`  Last fetched: ${s.lastFetchedAt ?? "Never"}`);
    }
  } else {
    lines.push("");
    lines.push("Sources: none");
  }

  return text(lines.join("\n"));
}

// ── list_catalog ─────────────────────────────────────────────────────

/**
 * Render-only shape for `list_catalog` — extends the wire `SearchCatalogHit`
 * with fields listCatalog surfaces in its detail view but the web doesn't
 * need (description, url, lastFetchedAt).
 */
type CatalogEntry = SearchCatalogHit & {
  description: string | null;
  url: string | null;
  lastFetchedAt?: string | null;
};

export async function listCatalog(
  db: D1Db,
  params: { organization?: string; kind?: Kind } & McpPaginationInput,
): Promise<ToolResult> {
  const pagination = parseMcpPagination(params);

  let orgId: string | undefined;
  if (params.organization) {
    const org = await findOrgByAnyIdentifier(db, params.organization);
    if (!org) return text(`No organization found matching "${params.organization}"`);
    orgId = org.id;
  }

  // Catalog surface → match each row's OWN kind (no source→product
  // inheritance), the list-side of the asymmetry documented in AGENTS.md.
  // Deleted products, hidden or deleted sources, and children of deleted orgs
  // drop out (`@releases/queries/catalog`), as in `GET /v1/orgs/:slug/catalog`.
  const filter = { orgId, kind: params.kind };
  const [productRows, orphanSourceRows] = await Promise.all([
    listCatalogProducts(db, filter),
    listCatalogStandaloneSources(db, filter),
  ]);

  const entries: CatalogEntry[] = [
    ...productRows.map((p): CatalogEntry => ({
      slug: p.slug,
      name: p.name,
      orgSlug: p.orgSlug,
      orgName: p.orgName,
      category: p.category,
      description: p.description,
      url: p.url,
      entryType: "product",
    })),
    ...orphanSourceRows.map((s): CatalogEntry => ({
      slug: s.slug,
      name: s.name,
      orgSlug: s.orgSlug,
      orgName: s.orgName,
      category: null,
      description: null,
      url: s.url,
      entryType: "source",
      sourceType: s.type,
      lastFetchedAt: s.lastFetchedAt,
    })),
  ];

  // entryType + slug tiebreakers keep page boundaries stable when product and
  // source entries share a name (or two products under different orgs do).
  entries.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.entryType.localeCompare(b.entryType) ||
      a.slug.localeCompare(b.slug),
  );

  // Catalog merge happens in JS because products + standalone sources are two
  // tables with different column shapes; UNION ALL with a uniform projection
  // would obscure the discriminator. Acceptable because the catalog stays
  // small per org (tens of rows in practice).
  const totalItems = entries.length;
  if (totalItems === 0)
    return emptyListResult({ message: "No catalog entries found.", pagination });

  const pageEntries = slicePage(entries, pagination);

  const body = pageEntries
    .map((e) => {
      const coord = e.orgSlug ? `${e.orgSlug}/${e.slug}` : e.slug;
      const parts = [`**${e.name}** _(${e.entryType})_`, `  Slug: ${coord}`];
      if (e.orgSlug) parts.push(`  Organization: ${e.orgName ?? e.orgSlug} (${e.orgSlug})`);
      if (e.category) parts.push(`  Category: ${e.category}`);
      if (e.url) parts.push(`  URL: ${e.url}`);
      if (e.description) parts.push(`  Description: ${e.description}`);
      if (e.entryType === "source") {
        parts.push(`  Source type: ${e.sourceType}`);
        parts.push(`  Last fetched: ${e.lastFetchedAt ?? "Never"}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");

  return paginatedText({
    body,
    noun: "catalog entries",
    pagination,
    returned: pageEntries.length,
    totalItems,
  });
}

// ── get_catalog_entry ────────────────────────────────────────────────

export async function getCatalogEntry(
  db: D1Db,
  params: {
    identifier: string;
    include_changelog?: boolean;
    changelog_path?: string;
    changelog_offset?: number;
    changelog_limit?: number;
    changelog_tokens?: number;
  },
): Promise<ToolResult> {
  const changelog: ChangelogRenderOptions = {
    include: params.include_changelog,
    path: params.changelog_path,
    offset: params.changelog_offset,
    limit: params.changelog_limit,
    tokens: params.changelog_tokens,
  };
  // When the caller passes any changelog param, products can't satisfy the
  // request — flip the ambiguous-slug preference so sources win the tie.
  const changelogRequested =
    params.include_changelog === true ||
    params.changelog_path !== undefined ||
    params.changelog_offset !== undefined ||
    params.changelog_limit !== undefined ||
    params.changelog_tokens !== undefined;
  const entityType = getEntityType(params.identifier);

  if (entityType === "product") {
    const prod = await resolveProduct(db, params.identifier);
    return prod
      ? renderProductDetail(db, prod)
      : text(`No product found matching "${params.identifier}"`);
  }
  if (entityType === "source") {
    const src = await resolveSource(db, params.identifier);
    return src
      ? renderSourceDetail(db, src, changelog)
      : text(`No source found matching "${params.identifier}"`);
  }

  // Bare slug without org context — product and source slugs are now
  // org-scoped so a bare slug is ambiguous and will break when the API
  // removes its global carve-out (issue #698). Require an org-scoped form.
  if (isBareSlug(params.identifier)) {
    return text(
      `Bare slug "${params.identifier}" is ambiguous — product and source slugs are org-scoped.\n` +
        `Use an org-scoped identifier instead:\n` +
        `  • ID:         src_<id>  or  prod_<id>\n` +
        `  • Coordinate: <orgSlug>/<slug>  (e.g. "vercel/nextjs")`,
    );
  }

  // org/slug coordinate — resolve to product or source
  const [prod, src] = await Promise.all([
    resolveProduct(db, params.identifier),
    resolveSource(db, params.identifier),
  ]);
  if (changelogRequested && src) return renderSourceDetail(db, src, changelog);
  if (prod) return renderProductDetail(db, prod);
  if (src) return renderSourceDetail(db, src, changelog);

  return text(`No catalog entry found matching "${params.identifier}"`);
}

// ── search (unified) ─────────────────────────────────────────────────

export type SearchType = "orgs" | "catalog" | "releases" | "collections";

/**
 * `type` here is the input-filter parameter (which sections to return).
 * Catalog entries in the response carry an `entryType` discriminator
 * (`"product"` | `"source"`) — `type` stays on the input so it doesn't
 * shadow `sources.type`.
 */
export async function search(
  db: D1Db,
  params: {
    query: string;
    type?: SearchType[];
    organization?: string;
    domain?: string;
    entity?: string;
    product?: string;
    limit?: number;
    mode?: SearchMode;
    include_coverage?: boolean;
    include_empty?: boolean;
    kind?: Kind;
    since?: string;
    until?: string;
  },
  searchEnv?: import("./lib/search-hybrid.js").HybridSearchEnv,
  ctx?: ExecutionContext,
): Promise<SearchToolReturn> {
  const wanted = new Set<SearchType>(
    params.type && params.type.length > 0
      ? params.type
      : ["orgs", "catalog", "releases", "collections"],
  );
  const limit = params.limit ?? 20;
  const mode: SearchMode = params.mode ?? "hybrid";
  const includeCoverage = params.include_coverage === true;
  // #746: hide orgs with no indexed releases by default — they're stubs.
  // The `domain`/`organization` short-circuits below resolve a specific org
  // and bypass this gate (the caller named an entity, so we surface it).
  const includeEmpty = params.include_empty === true;
  const q = params.query;
  const empty: SearchCounts = {
    orgHits: 0,
    catalogHits: 0,
    releaseHits: 0,
    chunkHits: 0,
    collectionHits: 0,
  };

  // Optional time window on release hits — only the release section honors it
  // (orgs/catalog/collections are unaffected, mirroring the API).
  const window = resolveToolWindow(params);
  if (!window.ok) return { result: text(window.message), counts: empty };
  const { since, until } = window;

  // Resolve embed config once per request and thread it into every helper
  // that consumes it (collections semantic + hybrid release path). Without
  // this, each helper independently reads the Secrets Store binding.
  // Resolution is lazy: only fired when we'll actually use it.
  let embedConfigP: Promise<
    Awaited<ReturnType<typeof import("@releases/search/embed-config.js").buildEmbedConfig>>
  > | null = null;
  const resolveEmbedConfig = () => {
    if (!searchEnv || mode === "lexical") return Promise.resolve(null);
    if (!embedConfigP) {
      embedConfigP = (async () => {
        const { buildEmbedConfig } = await import("@releases/search/embed-config.js");
        return buildEmbedConfig(searchEnv);
      })();
    }
    return embedConfigP;
  };

  let orgScope: OrgLookupRow | null = null;
  if (params.organization) {
    orgScope = await findOrgByAnyIdentifier(db, params.organization);
    if (!orgScope) {
      return {
        result: text(`No organization found matching "${params.organization}"`),
        counts: empty,
      };
    }
  }
  // `domain` is the normalized-input form of `organization`. It's its own
  // param so callers don't have to feel out which kinds of strings findOrgByAnyIdentifier
  // accepts — pass `https://vercel.com/`, get the same scope as `vercel`.
  // When both are passed, `domain` is additive: it has to agree with the
  // org already resolved, otherwise we treat it as a contradiction.
  if (params.domain) {
    const normalized = normalizeDomain(params.domain);
    if (!normalized) {
      return {
        result: text(
          `"${params.domain}" doesn't look like a valid hostname (need at least \`example.com\`).`,
        ),
        counts: empty,
      };
    }
    const resolved = await findOrgByAnyIdentifier(db, normalized);
    if (!resolved) {
      return {
        result: text(`No organization owns the domain \`${normalized}\` in this registry.`),
        counts: empty,
      };
    }
    if (orgScope && orgScope.id !== resolved.id) {
      return {
        result: text(
          `\`organization\` and \`domain\` resolved to different orgs (` +
            `${orgScope.slug} vs ${resolved.slug}). Pass only one.`,
        ),
        counts: empty,
      };
    }
    orgScope = resolved;
  }

  let entitySourceIds: string[] | null = null;
  if (params.entity) {
    if (isBareSlug(params.entity)) {
      return {
        result: text(
          `Bare slug "${params.entity}" is ambiguous — source and product slugs are org-scoped.\n` +
            `Use an org-scoped identifier instead:\n` +
            `  • ID:         src_<id>  or  prod_<id>\n` +
            `  • Coordinate: <orgSlug>/<slug>  (e.g. "vercel/nextjs")`,
        ),
        counts: empty,
      };
    }
    entitySourceIds = await resolveEntityToSourceIds(db, params.entity);
    if (!entitySourceIds) {
      return { result: text(`No catalog entry found matching "${params.entity}"`), counts: empty };
    }
    if (entitySourceIds.length === 0) {
      return { result: text(`No sources found under "${params.entity}".`), counts: empty };
    }
  }

  // `product` scopes release results to a specific product's sources.
  // Mirrors the REST `?product=` expansion but lives as its own param so
  // callers don't have to use `entity` (which also accepts sources). Bare
  // slugs are rejected; unknown products return a "not found" message.
  // When both `entity` and `product` are supplied, `entity` takes precedence
  // (it's the more general narrowing param — the caller specified it first).
  let productSourceIds: string[] | null = null;
  let productEcho: string | undefined;
  if (params.product && !entitySourceIds) {
    if (isBareSlug(params.product)) {
      return {
        result: text(
          `Bare slug "${params.product}" is ambiguous — product slugs are org-scoped.\n` +
            `Use an org-scoped identifier instead:\n` +
            `  • ID:         prod_<id>\n` +
            `  • Coordinate: <orgSlug>/<productSlug>  (e.g. "vercel/next-js")`,
        ),
        counts: empty,
      };
    }
    const prod = await resolveProduct(db, params.product);
    if (!prod) {
      return {
        result: text(`No product found matching "${params.product}"`),
        counts: empty,
      };
    }
    const srcRows = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.productId, prod.id));
    productSourceIds = srcRows.map((r) => r.id);
    // Resolve org slug for the echo coordinate.
    const [orgRow] = await db
      .select({ slug: organizationsActive.slug })
      .from(organizationsActive)
      .where(eq(organizationsActive.id, prod.orgId))
      .limit(1);
    if (orgRow) productEcho = `${orgRow.slug}/${prod.slug}`;
    if (productSourceIds.length === 0) {
      return {
        result: text(`Product "${params.product}" has no sources yet.`),
        counts: empty,
      };
    }
  }

  // Org-match is needed for member-rollup collections too, so we run it
  // whenever either `orgs` or `collections` is requested. The "orgs" output
  // section still respects `wanted.has("orgs")` — see the rendering block
  // below where matchedOrgs is consumed.
  const needsOrgMatch = wanted.has("orgs") || wanted.has("collections");
  const matchedOrgsP: Promise<
    Array<{ slug: string; name: string; domain: string | null; category: string | null }>
  > = needsOrgMatch
    ? orgScope
      ? Promise.resolve([
          {
            slug: orgScope.slug,
            name: orgScope.name,
            domain: orgScope.domain,
            category: orgScope.category,
          },
        ])
      : // Wide LIKE candidate fetch, then post-filter + rank in TS through
        // `rankEntityCandidates` (shared with the API worker) so "ai" no longer
        // surfaces every `.ai` TLD or mid-word hit, alphabetically. GROUP_CONCAT
        // carries the alias domains through for domain-label ranking.
        (async () => {
          const candidates = await db.all<{
            slug: string;
            name: string;
            domain: string | null;
            category: string | null;
            aliasDomains: string | null;
          }>(sql`
            SELECT o.slug, o.name, o.domain, o.category,
                   GROUP_CONCAT(da.domain) as aliasDomains
            FROM organizations o
            LEFT JOIN domain_aliases da ON da.org_id = o.id
            WHERE (${likeContains(sql`o.name`, q)} OR ${likeContains(sql`o.slug`, q)}
              OR ${likeContains(sql`o.domain`, q)} OR ${likeContains(sql`da.domain`, q)}
              OR ${likeContains(sql`o.category`, q)})
              ${includeEmpty ? sql`` : sql`AND ${orgHasVisibleRelease}`}
            GROUP BY o.id
            ORDER BY o.name LIMIT ${ENTITY_CANDIDATE_LIMIT}
          `);
          return rankEntityCandidates(candidates, q, limit, (c) => ({
            name: c.name,
            slug: c.slug,
            domains: [c.domain, ...splitConcat(c.aliasDomains)],
            categories: [c.category],
          })).map(({ aliasDomains: _drop, ...org }) => org);
        })()
    : Promise.resolve([]);

  const catalogP: Promise<SearchCatalogHit[]> = wanted.has("catalog")
    ? (async () => {
        // When productSourceIds is set (empty or non-empty), short-circuit the
        // catalog query to avoid building invalid `IN ()` SQL fragments.
        if (productSourceIds !== null && productSourceIds.length === 0)
          return foldSourcesIntoCatalog([], []);
        const productScopeClause =
          productSourceIds && productSourceIds.length > 0
            ? sql`AND EXISTS (
                SELECT 1 FROM sources_active sa
                WHERE sa.product_id = p.id
                  AND sa.id IN ${sourceIdInList(productSourceIds)}
              )`
            : sql``;
        const sourceScopeClause =
          productSourceIds && productSourceIds.length > 0
            ? sql`AND s.id IN ${sourceIdInList(productSourceIds)}`
            : sql``;
        // Both arms fetch a wide LIKE candidate window, then post-filter +
        // rank in TS through `rankEntityCandidates` (shared with the API
        // worker). Products rank on name/slug + alias domains (GROUP_CONCAT
        // carries the aliases through); sources rank on name/slug + the raw
        // URL (host labels + path segments, never the TLD).
        const [productRows, sourceRows] = await Promise.all([
          (async () => {
            const candidates = await db.all<SearchCatalogHit & { aliasDomains: string | null }>(sql`
              SELECT p.slug, p.name, o.slug as orgSlug, o.name as orgName,
                     p.category, 'product' as entryType, p.kind,
                     GROUP_CONCAT(da.domain) as aliasDomains
              FROM products_active p
              LEFT JOIN organizations o ON o.id = p.org_id
              LEFT JOIN domain_aliases da ON da.product_id = p.id
              WHERE (${likeContains(sql`p.name`, q)} OR ${likeContains(sql`p.slug`, q)} OR ${likeContains(sql`da.domain`, q)})
                ${orgScope ? sql`AND p.org_id = ${orgScope.id}` : sql``}
                ${params.kind ? sql`AND p.kind = ${params.kind}` : sql``}
                ${productScopeClause}
              GROUP BY p.id
              ORDER BY p.name LIMIT ${ENTITY_CANDIDATE_LIMIT}
            `);
            return rankEntityCandidates(candidates, q, limit, (c) => ({
              name: c.name,
              slug: c.slug,
              domains: splitConcat(c.aliasDomains),
            })).map(({ aliasDomains: _drop, ...hit }) => hit);
          })(),
          (async () => {
            const candidates = await db.all<RawSourceHit & { url: string | null }>(sql`
              SELECT s.slug, s.name, s.type, s.url, o.slug as orgSlug, o.name as orgName,
                     p.slug as productSlug, p.name as productName, p.category as productCategory,
                     s.kind as entityKind
              FROM sources_visible s
              LEFT JOIN products_active p ON p.id = s.product_id
              LEFT JOIN organizations o ON o.id = s.org_id
              WHERE (${likeContains(sql`s.name`, q)} OR ${likeContains(sql`s.slug`, q)} OR ${likeContains(sql`s.url`, q)})
                ${orgScope ? sql`AND s.org_id = ${orgScope.id}` : sql``}
                ${params.kind ? sql`AND s.kind = ${params.kind}` : sql``}
                ${sourceScopeClause}
              ORDER BY s.name LIMIT ${ENTITY_CANDIDATE_LIMIT}
            `);
            return rankEntityCandidates(candidates, q, limit, (c) => ({
              name: c.name,
              slug: c.slug,
              urls: [c.url],
            })).map(({ url: _drop, ...hit }) => hit);
          })(),
        ]);
        return foldSourcesIntoCatalog(productRows, sourceRows);
      })()
    : Promise.resolve([]);

  type LexicalReleaseRow = {
    id: string;
    title: string;
    summary: string;
    titleGenerated: string | null;
    titleShort: string | null;
    version: string | null;
    type: ReleaseType;
    publishedAt: string | null;
    /** AI-scored importance 1–5; null when unscored. */
    importance: number | null;
    sourceSlug: string;
    sourceName: string;
    orgSlug: string | null;
    productSlug: string | null;
  };
  type HybridSection = {
    mode: "hybrid";
    hybrid: Awaited<ReturnType<typeof import("./lib/search-hybrid.js").runHybridSearch>>;
  };
  type ReleaseSection = HybridSection | { mode: "lexical"; rows: LexicalReleaseRow[] } | null;

  // Collection hits — three paths: direct LIKE on name/slug/description
  // (always), member rollup via collection_members (after org slugs are in
  // hand), and direct vector match (hybrid/semantic only). Final assembly
  // uses `mergeCollectionHits` from api-types so the MCP surface and
  // `/v1/search` stay in lockstep.
  const collectionsDirectP: Promise<SearchCollectionHit[]> = wanted.has("collections")
    ? searchCollectionsDirect(db, q, limit)
    : Promise.resolve([]);

  // Vector match shares ENTITIES_INDEX with orgs/products/sources; filtered
  // server-side on `type=collection` so candidates aren't wasted on others.
  // Degrades silently — collection-vector hits are a nice-to-have.
  const collectionsSemanticP: Promise<SearchCollectionHit[]> =
    wanted.has("collections") && mode !== "lexical" && searchEnv?.ENTITIES_INDEX
      ? (async () => {
          try {
            const { runCollectionsSemantic } = await import("./lib/search-hybrid.js");
            const embedConfig = await resolveEmbedConfig();
            const r = await runCollectionsSemantic(
              searchEnv,
              db,
              { query: params.query, limit },
              { ...(ctx ? { waitUntil: ctx.waitUntil.bind(ctx) } : {}), embedConfig },
            );
            if (r.degraded) return [];
            return r.hits.map((h) => ({
              slug: h.slug,
              name: h.name,
              description: h.description,
              memberCount: h.memberCount,
              via: "direct" as const,
              score: h.score,
            }));
          } catch {
            return [];
          }
        })()
      : Promise.resolve([]);

  const releasesP: Promise<ReleaseSection> = wanted.has("releases")
    ? (async () => {
        // Entity filter narrows further than org filter; org filter expands
        // to every source under the org. Product filter sits between: it
        // applies when entity is unset, taking precedence over org when both
        // happen to be present (product is more specific).
        let sourceIds = entitySourceIds ?? productSourceIds ?? undefined;
        if (!sourceIds && orgScope) {
          const rows = await db
            .select({ id: sources.id })
            .from(sources)
            .where(eq(sources.orgId, orgScope.id));
          sourceIds = rows.map((r) => r.id);
        }

        if (mode !== "lexical" && searchEnv) {
          const { runHybridSearch } = await import("./lib/search-hybrid.js");
          const embedConfig = await resolveEmbedConfig();
          const hybrid = await runHybridSearch(
            searchEnv,
            db,
            {
              query: params.query,
              topK: limit,
              mode,
              // Single-source goes through the hybrid helper's narrow
              // `sourceId` path; multi-source uses the list form.
              sourceId: sourceIds?.length === 1 ? sourceIds[0] : undefined,
              orgSourceIds: sourceIds && sourceIds.length > 1 ? sourceIds : undefined,
              includeCoverage,
              kind: params.kind,
              since,
              until,
            },
            { ...(ctx ? { waitUntil: ctx.waitUntil.bind(ctx) } : {}), embedConfig },
          );
          return { mode: "hybrid", hybrid };
        }

        // Shared FTS helper with /v1/search (sources_active, coverage, kind,
        // since/until, product-scope sourceIds). Same closed MATCH ownership.
        const ftsRows = await searchReleasesFts(db, params.query, limit, 0, {
          includeCoverage,
          sourceIds,
          kind: params.kind,
          since,
          until,
        });
        const rows: LexicalReleaseRow[] = ftsRows.map((r) => ({
          id: r.id,
          title: r.title,
          summary: r.summary,
          titleGenerated: r.titleGenerated,
          titleShort: r.titleShort,
          version: r.version,
          type: r.type,
          publishedAt: r.publishedAt,
          importance: r.importance ?? null,
          sourceSlug: r.sourceSlug,
          sourceName: r.sourceName,
          orgSlug: r.orgSlug,
          productSlug: r.productSlug,
        }));
        return { mode: "lexical", rows };
      })()
    : Promise.resolve(null);

  const [matchedOrgs, catalog, releaseResult, collectionsDirect, collectionsSemantic] =
    await Promise.all([
      matchedOrgsP,
      catalogP,
      releasesP,
      collectionsDirectP,
      collectionsSemanticP,
    ]);

  // `orgs` is what the response renders under "## Organizations" — gated by
  // `wanted.has("orgs")`. `matchedOrgs` always carries the match set so the
  // collection rollup below can run even when only "collections" was asked.
  const orgs = wanted.has("orgs") ? matchedOrgs : [];

  // Member rollup runs after the orgs query so we have the slugs in hand.
  // Don't pre-LIMIT the raw rows — one collection can produce many rows (one
  // per matched org), and clipping there would drop valid collections and
  // truncate `matchedOrgSlugs` lists. Dedupe by collection slug first, then
  // apply `limit` to the deduped set.
  const memberRollups: SearchCollectionHit[] = wanted.has("collections")
    ? await findCollectionsByMemberOrgs(
        db,
        matchedOrgs.map((o) => o.slug),
        limit,
      )
    : [];

  const collectionsHits = mergeCollectionHits(
    collectionsDirect,
    collectionsSemantic,
    memberRollups,
    limit,
  );

  const sections: string[] = [];

  if (releaseResult?.mode === "hybrid" && releaseResult.hybrid.degraded) {
    sections.push(
      `⚠ Semantic search unavailable (${releaseResult.hybrid.degradedReason ?? "unknown"}); falling back to lexical.`,
    );
  }

  if (orgs.length > 0) {
    const lines = [
      "## Organizations",
      ...orgs.map((o) => `- **${o.name}** (${o.slug})${o.category ? ` — ${o.category}` : ""}`),
    ];
    sections.push(lines.join("\n"));
  }

  if (catalog.length > 0) {
    const lines = [
      "## Catalog",
      ...catalog.map((e) => {
        const coord = e.orgSlug ? `${e.orgSlug}/${e.slug}` : e.slug;
        const orgLabel = e.orgSlug ? ` — ${e.orgName ?? e.orgSlug}` : "";
        return `- [${e.entryType}] **${e.name}** (${coord})${orgLabel}`;
      }),
    ];
    sections.push(lines.join("\n"));
  }

  if (collectionsHits.length > 0) {
    const lines: string[] = ["## Collections"];
    for (const c of collectionsHits) {
      const count = c.memberCount === 1 ? "1 member" : `${c.memberCount} members`;
      const viaHint =
        c.via === "member" && c.matchedOrgSlugs && c.matchedOrgSlugs.length > 0
          ? ` — includes ${c.matchedOrgSlugs.join(", ")}`
          : "";
      const descLine = c.description ? `\n  ${c.description}` : "";
      lines.push(`- [collection] **${c.name}** (${c.slug}) — ${count}${viaHint}${descLine}`);
    }
    sections.push(lines.join("\n"));
  }

  if (releaseResult?.mode === "hybrid" && releaseResult.hybrid.hits.length > 0) {
    const lines: string[] = ["## Releases"];
    for (const hit of releaseResult.hybrid.hits) {
      if (hit.kind === "release") {
        const r = hit.release;
        const srcCoord = r.orgSlug ? `${r.orgSlug}/${r.source.slug}` : r.source.id;
        // Importance only when scored — same omit-when-null norm as feeds /
        // get_release text (raw 1–5, not the ≥4 flame threshold).
        const importanceLine = r.importance != null ? `  importance: ${r.importance}/5` : null;
        lines.push(
          [
            `- [release] **${r.title}**`,
            `  id: ${r.id}`,
            `  source: ${r.source.name} (${srcCoord}) | ${r.publishedAt ?? "N/A"}`,
            r.productSlug && r.orgSlug ? `  product: ${r.orgSlug}/${r.productSlug}` : null,
            r.version ? `  version: ${r.version}` : null,
            importanceLine,
            `  ${r.summary}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } else {
        const c = hit.chunk;
        lines.push(
          [
            `- [changelog_chunk] ${c.source.name} (${c.source.id})`,
            `  file: ${c.file_path} @ offset=${c.offset} length=${c.length}`,
            c.heading ? `  heading: ${c.heading}` : null,
            `  ${c.snippet}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }
    sections.push(lines.join("\n"));
  } else if (releaseResult?.mode === "lexical" && releaseResult.rows.length > 0) {
    const lines: string[] = ["## Releases"];
    for (const r of releaseResult.rows) {
      const titleLine = formatReleaseTitle(r);
      const srcCoord = r.orgSlug ? `${r.orgSlug}/${r.sourceSlug}` : r.sourceSlug;
      const productLine =
        r.productSlug && r.orgSlug ? `\n  product: ${r.orgSlug}/${r.productSlug}` : "";
      const importanceLine = r.importance != null ? `\n  importance: ${r.importance}/5` : "";
      lines.push(
        `- [release] ${titleLine}\n  id: ${r.id}\n  source: ${r.sourceName} (${srcCoord}) | ${r.publishedAt ?? "N/A"}${productLine}${importanceLine}\n  ${r.summary}`,
      );
    }
    sections.push(lines.join("\n"));
  }

  const hadDegradeNotice =
    releaseResult?.mode === "hybrid" && releaseResult.hybrid.degraded === true;
  if (sections.length === 0 || (sections.length === 1 && hadDegradeNotice)) {
    sections.push("No results found.");
  }

  let releaseHits = 0;
  let chunkHits = 0;
  if (releaseResult?.mode === "hybrid") {
    for (const hit of releaseResult.hybrid.hits) {
      if (hit.kind === "release") releaseHits++;
      else chunkHits++;
    }
  } else if (releaseResult?.mode === "lexical") {
    releaseHits = releaseResult.rows.length;
  }
  const counts: SearchCounts = {
    orgHits: orgs.length,
    catalogHits: catalog.length,
    releaseHits,
    chunkHits,
    collectionHits: collectionsHits.length,
    degraded: hadDegradeNotice,
    ...(productEcho ? { product: productEcho } : {}),
  };

  return { result: text(sections.join("\n\n")), counts };
}

// ── list_collections / get_collection / get_collection_releases ──────
//
// Read-only mirrors of the REST endpoints in apps/api/src/routes/collections.ts.
// Membership joins through `organizations_public` so on_demand / soft-deleted
// orgs never leak through a collection — same model as the API, the web feed,
// and the org-overview surfaces.

export async function listCollections(db: D1Db, params: McpPaginationInput): Promise<ToolResult> {
  const pagination = parseMcpPagination(params);

  // `totalItems` counts every collection row; per-row `memberCount` only
  // counts visible members (joined through organizationsPublic). The two
  // counts measure different things on purpose — the total is for pagination,
  // the per-row count is for display.
  const [totalItems, rows] = await Promise.all([
    countCollections(db),
    listCollectionsWhere(db, undefined, {
      limit: pagination.pageSize,
      offset: pagination.offset,
    }),
  ]);
  if (totalItems === 0) {
    return emptyListResult({
      message: "No collections yet.",
      pagination,
    });
  }

  const body = rows
    .map((r) => {
      const descLine = r.description ? `\n  ${r.description}` : "";
      const noun = r.memberCount === 1 ? "member" : "members";
      return `**${r.name}**\n  Slug: ${r.slug} | ${r.memberCount} ${noun}${descLine}`;
    })
    .join("\n\n");

  return paginatedText({
    body,
    noun: "collections",
    pagination,
    returned: rows.length,
    totalItems,
  });
}

export async function getCollection(db: D1Db, params: { slug: string }): Promise<ToolResult> {
  const slug = params.slug.trim();
  const collection = await findCollectionBySlug(db, slug);
  if (!collection) return text(`No collection found with slug "${slug}".`);

  // Same member list as `GET /v1/collections/:slug`: orgs through
  // organizationsPublic, products through productsActive + a visible parent
  // org, interleaved by (position, name, slug).
  const members = await getCollectionFullMembers(db, collection.id);
  const items = members.map((m) => {
    if (m.kind === "org") {
      const tail = m.domain ? ` — ${m.domain}` : "";
      return { line: `- **${m.name}** (${m.slug})${tail}`, sub: m.description ?? undefined };
    }
    return {
      line: `- **${m.name}** (product · ${m.org.name} / ${m.slug})`,
      sub: m.description ?? undefined,
    };
  });

  const lines: string[] = [];
  lines.push(`**Collection: ${collection.name}**`);
  lines.push(`Slug: ${collection.slug}`);
  if (collection.description) lines.push(`Description: ${collection.description}`);
  lines.push("");
  if (items.length === 0) {
    lines.push("Members: none");
  } else {
    const noun = items.length === 1 ? "member" : "members";
    lines.push(`Members (${items.length} ${noun}):`);
    for (const item of items) {
      lines.push(item.line);
      if (item.sub) lines.push(`  ${item.sub}`);
    }
  }
  return text(lines.join("\n"));
}

export async function getCollectionReleases(
  db: D1Db,
  params: {
    slug: string;
    limit?: number;
    cursor?: string;
    include_prereleases?: boolean;
  },
  webBase: string,
): Promise<ToolResult> {
  const slug = params.slug.trim();
  const limit = parseFeedLimit(params.limit ?? 20);

  const collection = await findCollectionBySlug(db, slug);
  if (!collection) return text(`No collection found with slug "${slug}".`);

  // Visible org + product members only (matches the REST surface).
  const memberIds = await listCollectionMemberIds(db, collection.id);
  const orgIds = memberIds.orgs.map((m) => m.orgId);
  const productIds = memberIds.products.map((m) => m.productId);

  if (orgIds.length === 0 && productIds.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Collection "${collection.name}" has no visible members yet.`,
        },
      ],
      _meta: {
        pagination: buildCursorMeta({ returned: 0, limit, hasMore: false, nextCursor: null }),
      },
    };
  }

  // Shared query + cursor with `GET /v1/collections/:slug/releases` so MCP and
  // REST agree on row ordering and `nextCursor` strings — see
  // @releases/core-internal/collection-feed.
  const results = await getCollectionReleasesFeed(db, orgIds, params.cursor ?? null, limit + 1, {
    includePrereleases: params.include_prereleases ?? false,
    productIds,
  });

  const hasMore = results.length > limit;
  const pageRows = hasMore ? results.slice(0, limit) : results;

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    nextCursor = buildFeedCursor(pageRows[pageRows.length - 1]);
  }

  const cursorMeta = buildCursorMeta({
    returned: pageRows.length,
    limit,
    hasMore,
    nextCursor,
  });

  const collectionContext = { collection: { slug, name: collection.name } };

  if (pageRows.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No releases yet in collection "${collection.name}".`,
        },
      ],
      structuredContent: {
        releases: [],
        pagination: cursorMeta,
        inputs: { ...params },
        toolName: "get_collection_releases" as const,
        context: collectionContext,
      },
      _meta: { pagination: cursorMeta },
    };
  }

  const structuredRows: ReleaseFeedRow[] = [];
  const textParts: string[] = [];
  for (const r of pageRows) {
    const coordinate = `${r.org_slug}/${r.source_slug}`;
    structuredRows.push(
      toReleaseFeedRow(
        {
          id: r.id,
          title: r.title,
          titleShort: r.title_short,
          titleGenerated: r.title_generated,
          version: r.version,
          type: r.type,
          summary: r.summary,
          content: r.content,
          publishedAt: r.published_at,
          url: r.url,
          sourceName: r.source_name,
          sourceType: r.source_type,
          coordinate,
          orgName: r.org_name,
          orgSlug: r.org_slug,
          orgAvatarUrl: r.org_avatar_url,
          orgGithubHandle: r.org_github_handle,
          productName: r.product_name,
          productSlug: r.product_slug,
          contentChars: r.content_chars,
          contentTokens: r.content_tokens,
        },
        webBase,
      ),
    );
    textParts.push(
      renderFeedReleaseText({
        id: r.id,
        title: r.title,
        type: r.type as ReleaseType,
        version: r.version,
        publishedAt: r.published_at,
        summary: r.summary,
        content: r.content,
        sourceName: r.source_name,
        coordinate,
        orgName: r.org_name,
        orgSlug: r.org_slug,
        contentChars: r.content_chars,
        contentTokens: r.content_tokens,
      }),
    );
  }
  const body = textParts.join("\n\n---\n\n");

  const footer = hasMore
    ? `\n\n_Showing ${pageRows.length} of more. Pass \`cursor: "${nextCursor}", limit: ${limit}\` to continue._`
    : "";

  return {
    content: [{ type: "text" as const, text: body + footer }],
    structuredContent: {
      releases: structuredRows,
      pagination: cursorMeta,
      inputs: { ...params },
      toolName: "get_collection_releases" as const,
      context: collectionContext,
    },
    _meta: { pagination: cursorMeta },
  };
}

/**
 * Collections this org is a member of, ordered by collection name. Hidden
 * orgs (e.g. on_demand) never appear in any collection's visible member list,
 * but a curated org may still join multiple collections — list them so callers
 * can see overlap.
 */
export async function getCollectionsForOrg(
  db: D1Db,
  orgId: string,
): Promise<{ slug: string; name: string }[]> {
  return db
    .select({ slug: collections.slug, name: collections.name })
    .from(collectionMembers)
    .innerJoin(collections, eq(collections.id, collectionMembers.collectionId))
    .where(eq(collectionMembers.orgId, orgId))
    .orderBy(collections.name);
}
