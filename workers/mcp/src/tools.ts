// Parity note: a read-only subset of these tools is also exposed in-browser via
// WebMCP in `web/src/components/webmcp-provider.tsx`. When adding, renaming, or
// changing the signature of a read-only tool here, update that provider in the
// same PR so the remote, local-stdio, and browser surfaces don't drift.
import { eq, desc, inArray, and, isNull, or, lt, lte, gte, sql, asc, type SQL } from "drizzle-orm";
import {
  sources,
  releases,
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
import { toFtsMatchQuery } from "@buildinternet/releases-core/fts";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import { rankEntityCandidates, ENTITY_CANDIDATE_LIMIT } from "@releases/lib/entity-match";
import type { Kind } from "@buildinternet/releases-core/kinds";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { normalizeDomain } from "@buildinternet/releases-core/domain";
import { getEntityType, normalizeReleaseId } from "@buildinternet/releases-core/id";
import { releasePath } from "@buildinternet/releases-core/release-slug";
import {
  buildChangelogResponse,
  formatChangelogSliceLine,
  hasRangeParams,
  resolveChangelogRangeParams,
  selectChangelogFile,
} from "@buildinternet/releases-core/changelog-slice";
import {
  OVERVIEW_STALE_DAYS,
  isOverviewStale,
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
import type { SourceType } from "@buildinternet/releases-core/source-enums";
import {
  buildFeedCursor,
  getCollectionReleasesFeed,
} from "@releases/core-internal/collection-feed";
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
   * UIs (see `workers/mcp/ui/`) read this directly so they don't have to parse
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
 * Correlated EXISTS for "the outer-aliased `o` org has at least one visible
 * release." Used by `listOrganizations` and the unified `search` tool to
 * implement the empty-org filter (#746). Both call sites alias the orgs
 * table as `o`, so the alias is hard-coded inside the fragment.
 */
const ORG_HAS_VISIBLE_RELEASE = sql`EXISTS (
  SELECT 1
  FROM sources_active s2
  JOIN releases_visible r2 ON r2.source_id = s2.id
  WHERE s2.org_id = o.id
)`;

/**
 * Absolute web origin for building `webUrl` fields. Mirrors the API worker's
 * `releaseWebBase` (`workers/api/src/queries/releases.ts`) — `WEB_BASE_URL`
 * is set in prod/staging wrangler config; the fallback keeps the prod origin
 * so a call without the var still emits a well-formed URL.
 */
export function releaseWebBase(env: { WEB_BASE_URL?: string }): string {
  return (env.WEB_BASE_URL ?? "https://releases.sh").replace(/\/+$/, "");
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
    contentPreview: (r.summary || r.content || "").slice(0, 500),
    publishedAt: r.publishedAt,
    url: r.url,
    webUrl: `${webBase}${releasePath({
      id: r.id,
      titleShort: r.titleShort,
      titleGenerated: r.titleGenerated,
      title: r.title,
      version: r.version,
    })}`,
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

async function findOrg(db: D1Db, identifier: string) {
  const id = identifier.trim();
  // Single query: org_ id, slug, domain, name (case-insensitive), domain alias, or account handle.
  // PK lookup on o.id is an indexed fast-path; LIMIT 1 stops evaluation on first match.
  const rows = await db.all<{
    id: string;
    name: string;
    slug: string;
    domain: string | null;
    description: string | null;
    category: string | null;
    metadata: string | null;
  }>(sql`
    SELECT o.id, o.name, o.slug, o.domain, o.description, o.category, o.metadata
    FROM organizations o
    WHERE o.id = ${id} OR o.slug = ${id} OR o.domain = ${id} OR LOWER(o.name) = LOWER(${id})
    UNION
    SELECT o.id, o.name, o.slug, o.domain, o.description, o.category, o.metadata
    FROM organizations o
    JOIN domain_aliases da ON da.org_id = o.id
    WHERE da.domain = ${id}
    UNION
    SELECT o.id, o.name, o.slug, o.domain, o.description, o.category, o.metadata
    FROM organizations o
    JOIN org_accounts oa ON oa.org_id = o.id
    WHERE oa.handle = ${id}
    LIMIT 1
  `);
  return rows.length > 0 ? rows[0] : null;
}

function formatReleaseTitle(r: { title: string; type: ReleaseType }): string {
  return r.type === "rollup" ? `**${r.title}** _(rollup)_` : `**${r.title}**`;
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
  if (getEntityType(id) === "source") {
    const rows = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
    return rows.length > 0 ? rows[0] : null;
  }

  // org/slug coordinate form (e.g. "vercel/next-js")
  const coord = parseOrgSlugCoordinate(id);
  if (coord) {
    const org = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, coord.orgSlug))
      .limit(1);
    if (org.length === 0) return null;
    const rows = await db
      .select()
      .from(sources)
      .where(and(eq(sources.slug, coord.slug), eq(sources.orgId, org[0].id)))
      .limit(1);
    return rows.length > 0 ? rows[0] : null;
  }

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
    .where(eq(sources.slug, id));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].row;
  throw new AmbiguousEntityError("source", id, toAmbiguousCandidates(matches));
}

export async function resolveProduct(db: D1Db, identifier: string) {
  const id = identifier.trim();
  if (getEntityType(id) === "product") {
    const rows = await db.select().from(products).where(eq(products.id, id)).limit(1);
    return rows.length > 0 ? rows[0] : null;
  }

  // org/slug coordinate form (e.g. "vercel/nextjs")
  const coord = parseOrgSlugCoordinate(id);
  if (coord) {
    const org = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, coord.orgSlug))
      .limit(1);
    if (org.length === 0) return null;
    const rows = await db
      .select()
      .from(products)
      .where(and(eq(products.slug, coord.slug), eq(products.orgId, org[0].id)))
      .limit(1);
    return rows.length > 0 ? rows[0] : null;
  }

  // Bare slug fallback — see resolveSource for the per-org ambiguity rationale
  // (#1324). 0 → null, 1 → resolve, >1 → throw with prod_… candidates.
  const matches = await db
    .select({ row: products, orgSlug: organizations.slug })
    .from(products)
    .leftJoin(organizations, eq(products.orgId, organizations.id))
    .where(eq(products.slug, id));
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
  },
  webBase: string,
): Promise<ToolResult> {
  const limit = parseFeedLimit(params.limit ?? 10);
  const window = resolveToolWindow(params);
  if (!window.ok) return text(window.message);
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

  let orgSourceIds: string[] | undefined;
  if (params.organization) {
    const org = await findOrg(db, params.organization);
    if (!org) return text(`No organization found matching "${params.organization}"`);
    const orgSources = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.orgId, org.id));
    orgSourceIds = orgSources.map((s) => s.id);
    if (orgSourceIds.length === 0) return text("No sources found for this organization.");
  }

  // Default filters match the web/API read paths so MCP readers see the same canonical-only feed.
  // releasesVisible already excludes suppressed + coverage rows; use base table only when
  // the caller explicitly opts into coverage.
  const releasesTable = includeCoverage ? releases : releasesVisible;
  // See {@link getOrgReleasesFeed} for the future-dated guardrail rationale.
  const cutoff = nowIso();
  const conditions = [
    sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`,
    sql`(${releasesTable.suppressed} IS NULL OR ${releasesTable.suppressed} = 0)`,
    or(lte(releasesTable.publishedAt, cutoff), isNull(releasesTable.publishedAt)),
  ];
  // Product filter: inArray covers single-source (src_… or one-source product)
  // and multi-source products equally — mirrors the REST `?product=` expansion.
  if (productSourceIds) conditions.push(inArray(releasesTable.sourceId, productSourceIds));
  if (orgSourceIds) conditions.push(inArray(releasesTable.sourceId, orgSourceIds));
  if (params.type) conditions.push(eq(releasesTable.type, params.type));
  // Time window on published_at. `gte`/`lte` against the ISO text column drop
  // NULL-dated rows — an undated release can't be placed in a window.
  if (window.since) conditions.push(gte(releasesTable.publishedAt, window.since));
  if (window.until) conditions.push(lte(releasesTable.publishedAt, window.until));
  // Content surface → resolve kind through source→product inheritance
  // (`COALESCE(source.kind, product.kind)`), the same asymmetry the unified
  // `search` tool and the `/v1/orgs/:slug/releases` feed apply. See AGENTS.md.
  if (params.kind) {
    conditions.push(sql`COALESCE(${sources.kind}, ${products.kind}) = ${params.kind}`);
  }
  // Default excludes prereleases (canaries / alphas / betas / RCs). Matches
  // the web/API read paths and the `get_collection_releases` default.
  if (!params.include_prereleases) {
    conditions.push(sql`(${releasesTable.prerelease} IS NULL OR ${releasesTable.prerelease} = 0)`);
  }

  // Cursor decode: silently ignore unparseable tokens rather than 400. The
  // feed is append-only and stable under cursor inserts, so a stale cursor
  // just gives the caller a fresh head of the feed.
  if (params.cursor) {
    const decoded = decodeReleaseCursor(params.cursor);
    if (decoded) {
      const cursorClause = decoded.lastPublishedAt
        ? // Standard tuple comparison for (publishedAt DESC, id DESC) ordering.
          or(
            lt(releasesTable.publishedAt, decoded.lastPublishedAt),
            and(
              eq(releasesTable.publishedAt, decoded.lastPublishedAt),
              lt(releasesTable.id, decoded.lastId),
            ),
          )
        : // Null-published releases sort to the tail; compare by id alone there.
          lt(releasesTable.id, decoded.lastId);
      if (cursorClause) conditions.push(cursorClause);
    }
  }

  // Fetch limit+1 to detect hasMore without a separate COUNT query — feeds
  // don't carry a totalItems anyway.
  const rows = await db
    .select({
      id: releasesTable.id,
      title: releasesTable.title,
      version: releasesTable.version,
      type: releasesTable.type,
      content: releasesTable.content,
      summary: releasesTable.summary,
      titleGenerated: releasesTable.titleGenerated,
      titleShort: releasesTable.titleShort,
      publishedAt: releasesTable.publishedAt,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      sourceType: sources.type,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      orgAvatarUrl: organizations.avatarUrl,
      orgGithubHandle: sql<string | null>`(
        SELECT handle FROM org_accounts
          WHERE org_id = ${organizations.id} AND platform = 'github'
          ORDER BY created_at, id LIMIT 1
      )`,
      productName: products.name,
      productSlug: products.slug,
      url: releasesTable.url,
      contentChars: releasesTable.contentChars,
      contentTokens: releasesTable.contentTokens,
    })
    .from(releasesTable)
    .innerJoin(sources, eq(releasesTable.sourceId, sources.id))
    // Left-joined for the kind-inheritance COALESCE; a null product_id (the
    // common case) leaves products.kind null and the source's own kind stands.
    .leftJoin(products, eq(sources.productId, products.id))
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .where(and(...conditions))
    .orderBy(desc(releasesTable.publishedAt), desc(releasesTable.id))
    .limit(limit + 1);

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

  // The query/platform combinations diverge only in their FROM/WHERE clauses.
  // Build them once and reuse the fragment for both the paged SELECT and the
  // COUNT(*) so totals stay filter-aware. Filtered arms wrap with DISTINCT o.id
  // because account/alias joins fan a single org into multiple rows; the
  // unfiltered arm skips DISTINCT (it'd add a sort cost on the full table).
  const q = params.query ?? null;
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

  let fromWhere = sql`FROM organizations o`;
  let distinct = false;
  if (q && params.platform) {
    distinct = true;
    fromWhere = sql`
      FROM organizations o
      LEFT JOIN domain_aliases da ON da.org_id = o.id
      JOIN org_accounts oa ON oa.org_id = o.id
      WHERE (${likeContains(sql`o.name`, q)}
        OR ${likeContains(sql`o.slug`, q)}
        OR ${likeContains(sql`o.domain`, q)}
        OR ${likeContains(sql`da.domain`, q)}
        OR ${likeContains(sql`oa.handle`, q)})
        AND oa.platform = ${params.platform}
    `;
  } else if (q) {
    distinct = true;
    // The OR list is wrapped so `AND <empty-org filter>` below binds to the
    // whole match group instead of just the trailing `oa.handle` clause.
    fromWhere = sql`
      FROM organizations o
      LEFT JOIN domain_aliases da ON da.org_id = o.id
      LEFT JOIN org_accounts oa ON oa.org_id = o.id
      WHERE (${likeContains(sql`o.name`, q)}
        OR ${likeContains(sql`o.slug`, q)}
        OR ${likeContains(sql`o.domain`, q)}
        OR ${likeContains(sql`da.domain`, q)}
        OR ${likeContains(sql`oa.handle`, q)})
    `;
  } else if (params.platform) {
    distinct = true;
    fromWhere = sql`
      FROM organizations o
      JOIN org_accounts oa ON oa.org_id = o.id
      WHERE oa.platform = ${params.platform}
    `;
  }

  // The empty-org filter is independent of q/platform — when active it adds
  // a correlated EXISTS check so rows fan-out from account/alias joins still
  // de-duplicate naturally through the outer DISTINCT (or COUNT(DISTINCT)
  // in the count branch). When the base query has no WHERE clause (the
  // un-distinct no-q/no-platform branch), the filter needs to lead with
  // `WHERE` instead of `AND`.
  const havingFrag = includeEmpty ? sql`` : sql`AND ${ORG_HAS_VISIBLE_RELEASE}`;
  // Category filter is independent — appended after the empty-org fragment.
  // The `AND` connector is always correct here because filteredFromWhere always
  // contains a WHERE by the time categoryFrag is appended (either from the
  // q/platform branches above or from the no-distinct arm below). The only
  // exception is the un-distinct+includeEmpty arm where no WHERE exists yet —
  // that arm's filteredFromWhere is built specially below.
  const categoryFrag = category ? sql`AND o.category = ${category}` : sql``;
  let filteredFromWhere: SQL<unknown>;
  if (!distinct && !includeEmpty && category) {
    // No WHERE yet from q/platform, no empty-org filter — category must lead.
    filteredFromWhere = sql`FROM organizations o WHERE ${ORG_HAS_VISIBLE_RELEASE} ${categoryFrag}`;
  } else if (!distinct && !includeEmpty) {
    filteredFromWhere = sql`FROM organizations o WHERE ${ORG_HAS_VISIBLE_RELEASE}`;
  } else if (!distinct && includeEmpty && category) {
    // No WHERE yet from q/platform, empty-org filter off — category must lead.
    filteredFromWhere = sql`FROM organizations o WHERE o.category = ${category}`;
  } else {
    filteredFromWhere = sql`${fromWhere} ${havingFrag} ${categoryFrag}`;
  }

  const distinctKw = distinct ? sql`DISTINCT` : sql``;
  type Row = { name: string; slug: string; domain: string | null };
  const [rows, totalRow] = await Promise.all([
    db.all<Row>(sql`
      SELECT ${distinctKw} o.name, o.slug, o.domain
      ${filteredFromWhere}
      ORDER BY o.name, o.slug
      LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
    `),
    distinct
      ? db.all<{ n: number }>(
          sql`SELECT COUNT(*) as n FROM (SELECT DISTINCT o.id ${filteredFromWhere})`,
        )
      : db.all<{ n: number }>(sql`SELECT COUNT(*) as n ${filteredFromWhere}`),
  ]);

  const totalItems = Number(totalRow[0]?.n ?? 0);
  if (totalItems === 0) return emptyListResult({ message: "No organizations found.", pagination });

  const body = rows
    .map((o) => [`**${o.name}**`, `  Slug: ${o.slug}`, `  Domain: ${o.domain ?? "N/A"}`].join("\n"))
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
  const org = await findOrg(db, params.identifier);
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
        .where(eq(sources.orgId, org.id)),
      db
        .select({
          slug: products.slug,
          name: products.name,
          url: products.url,
          description: products.description,
        })
        .from(products)
        .where(eq(products.orgId, org.id)),
      db
        .select({ domain: domainAliases.domain })
        .from(domainAliases)
        .where(eq(domainAliases.orgId, org.id)),
      db
        .select({
          content: knowledgePages.content,
          generatedAt: knowledgePages.generatedAt,
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
  if (org.description) lines.push(`Description: ${org.description}`);
  const notice = parseNotice(org.metadata);
  if (notice) lines.push(`Notice: ${formatNoticePointer(notice)}`);

  const overview = overviewRow[0];
  if (overview?.content) {
    const stale = isOverviewStale(overview.generatedAt);
    const ageLabel = timeAgo(overview.generatedAt) ?? "unknown";
    lines.push("");
    lines.push(`**Overview** (generated ${ageLabel}, ${overview.releaseCount} releases)`);
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
 * surface as a "not found" message — no on-demand probing for domains.
 */
export async function lookupDomain(db: D1Db, params: { domain: string }): Promise<ToolResult> {
  const domain = normalizeDomain(params.domain);
  if (!domain) {
    return text(
      `"${params.domain}" doesn't look like a valid hostname (need at least \`example.com\`).`,
    );
  }

  const [orgRow] = await db
    .select({
      id: organizationsActive.id,
      slug: organizationsActive.slug,
      name: organizationsActive.name,
      domain: organizationsActive.domain,
      description: organizationsActive.description,
      category: organizationsActive.category,
      matchedVia: sql<
        "primary" | "alias"
      >`CASE WHEN ${organizationsActive.domain} = ${domain} THEN 'primary' ELSE 'alias' END`,
    })
    .from(organizationsActive)
    .leftJoin(domainAliases, eq(domainAliases.orgId, organizationsActive.id))
    .where(or(eq(organizationsActive.domain, domain), eq(domainAliases.domain, domain)))
    .orderBy(asc(organizationsActive.createdAt), asc(organizationsActive.id))
    .limit(1);

  const productRows = await db
    .select({
      id: productsActive.id,
      slug: productsActive.slug,
      name: productsActive.name,
      orgSlug: organizationsActive.slug,
      orgName: organizationsActive.name,
      category: productsActive.category,
    })
    .from(productsActive)
    .innerJoin(domainAliases, eq(domainAliases.productId, productsActive.id))
    .innerJoin(organizationsActive, eq(organizationsActive.id, productsActive.orgId))
    .where(eq(domainAliases.domain, domain))
    .orderBy(asc(productsActive.name), asc(productsActive.id));

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

  const rows = await db
    .select({
      id: releases.id,
      title: releases.title,
      version: releases.version,
      type: releases.type,
      content: releases.content,
      summary: releases.summary,
      titleGenerated: releases.titleGenerated,
      titleShort: releases.titleShort,
      publishedAt: releases.publishedAt,
      url: releases.url,
      suppressed: releases.suppressed,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      sourceType: sources.type,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      orgAvatarUrl: organizations.avatarUrl,
      orgGithubHandle: sql<string | null>`(
        SELECT handle FROM org_accounts
          WHERE org_id = ${organizations.id} AND platform = 'github'
          ORDER BY created_at, id LIMIT 1
      )`,
      productName: products.name,
      productSlug: products.slug,
    })
    .from(releases)
    .leftJoin(sources, eq(releases.sourceId, sources.id))
    .leftJoin(products, eq(sources.productId, products.id))
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .where(eq(releases.id, id))
    .limit(1);

  const r = rows[0];
  if (!r || r.suppressed) return text(`No release found matching "${params.id}"`);

  const body = r.content && r.content.length > 0 ? r.content : (r.summary ?? "");

  const lines: string[] = [];
  const titleLine = formatReleaseTitle(r);
  lines.push(titleLine);
  lines.push(`ID: ${r.id}`);
  if (r.version) lines.push(`Version: ${r.version}`);
  if (r.publishedAt) lines.push(`Published: ${r.publishedAt}`);
  lines.push(`Source: ${r.sourceName ?? "Unknown"}${r.sourceSlug ? ` (${r.sourceSlug})` : ""}`);
  if (r.orgName) {
    lines.push(`Organization: ${r.orgName}${r.orgSlug ? ` (${r.orgSlug})` : ""}`);
  }
  if (r.url) lines.push(`URL: ${r.url}`);
  const webUrl = `${webBase}${releasePath({
    id: r.id,
    titleShort: r.titleShort,
    titleGenerated: r.titleGenerated,
    title: r.title,
    version: r.version,
  })}`;
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
    db
      .select({
        slug: sources.slug,
        name: sources.name,
        type: sources.type,
        url: sources.url,
        lastFetchedAt: sources.lastFetchedAt,
      })
      .from(sources)
      .where(eq(sources.productId, product.id)),
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
    const org = await findOrg(db, params.organization);
    if (!org) return text(`No organization found matching "${params.organization}"`);
    orgId = org.id;
  }

  // Catalog surface → match each row's OWN kind (no source→product
  // inheritance), the list-side of the asymmetry documented in AGENTS.md.
  // Products and standalone sources are two separate queries, so each gets its
  // own WHERE composed from the org scope + the optional kind filter.
  const productConds: SQL[] = [];
  if (orgId) productConds.push(sql`p.org_id = ${orgId}`);
  if (params.kind) productConds.push(sql`p.kind = ${params.kind}`);
  const productWhere = productConds.length
    ? sql`WHERE ${sql.join(productConds, sql` AND `)}`
    : sql``;

  const [productRows, orphanSourceRows] = await Promise.all([
    db.all<{
      slug: string;
      name: string;
      url: string | null;
      description: string | null;
      category: string | null;
      orgSlug: string | null;
      orgName: string | null;
    }>(sql`
      SELECT p.slug, p.name, p.url, p.description, p.category,
             o.slug as orgSlug, o.name as orgName
      FROM products p
      LEFT JOIN organizations o ON o.id = p.org_id
      ${productWhere}
      ORDER BY p.name, p.slug
    `),
    db.all<{
      slug: string;
      name: string;
      type: SourceType;
      url: string | null;
      lastFetchedAt: string | null;
      orgSlug: string | null;
      orgName: string | null;
    }>(sql`
      SELECT s.slug, s.name, s.type, s.url, s.last_fetched_at as lastFetchedAt,
             o.slug as orgSlug, o.name as orgName
      FROM sources s
      LEFT JOIN organizations o ON o.id = s.org_id
      WHERE s.product_id IS NULL
        AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
        ${orgId ? sql`AND s.org_id = ${orgId}` : sql``}
        ${params.kind ? sql`AND s.kind = ${params.kind}` : sql``}
      ORDER BY s.name, s.slug
    `),
  ]);

  const entries: CatalogEntry[] = [
    ...productRows.map(
      (p): CatalogEntry => ({
        slug: p.slug,
        name: p.name,
        orgSlug: p.orgSlug,
        orgName: p.orgName,
        category: p.category,
        description: p.description,
        url: p.url,
        entryType: "product",
      }),
    ),
    ...orphanSourceRows.map(
      (s): CatalogEntry => ({
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
      }),
    ),
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

  let orgScope: Awaited<ReturnType<typeof findOrg>> = null;
  if (params.organization) {
    orgScope = await findOrg(db, params.organization);
    if (!orgScope) {
      return {
        result: text(`No organization found matching "${params.organization}"`),
        counts: empty,
      };
    }
  }
  // `domain` is the normalized-input form of `organization`. It's its own
  // param so callers don't have to feel out which kinds of strings findOrg
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
    const resolved = await findOrg(db, normalized);
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
              ${includeEmpty ? sql`` : sql`AND ${ORG_HAS_VISIBLE_RELEASE}`}
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
  type DirectRow = {
    slug: string;
    name: string;
    description: string | null;
    memberCount: number;
  };
  const memberCountSubquery = sql<number>`(
    SELECT COUNT(*) FROM collection_members cm
    INNER JOIN organizations_public op ON op.id = cm.org_id
    WHERE cm.collection_id = c.id
  )`;
  const collectionsDirectP: Promise<SearchCollectionHit[]> = wanted.has("collections")
    ? (async () => {
        const rows = await db.all<DirectRow>(sql`
          SELECT c.slug, c.name, c.description,
                 ${memberCountSubquery} as memberCount
          FROM collections c
          WHERE ${likeContains(sql`c.name`, q)}
             OR ${likeContains(sql`c.slug`, q)}
             OR ${likeContains(sql`c.description`, q)}
          ORDER BY c.name
          LIMIT ${limit}
        `);
        return rows.map((r) => ({
          slug: r.slug,
          name: r.name,
          description: r.description,
          memberCount: Number(r.memberCount),
          via: "direct" as const,
        }));
      })()
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

        const rows = await db.all<LexicalReleaseRow>(sql`
          SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName,
                 r.version, r.title, r.type,
                 COALESCE(r.summary, SUBSTR(r.content, 1, 300)) as summary,
                 r.title_generated as titleGenerated,
                 r.title_short as titleShort,
                 r.published_at as publishedAt,
                 o.slug as orgSlug,
                 p.slug as productSlug
          FROM releases_fts
          JOIN releases r ON r.rowid = releases_fts.rowid
          JOIN sources s ON s.id = r.source_id
          LEFT JOIN products p ON p.id = s.product_id
          LEFT JOIN organizations o ON o.id = s.org_id
          WHERE releases_fts MATCH ${toFtsMatchQuery(params.query)}
            AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
            AND (r.suppressed IS NULL OR r.suppressed = 0)
            ${includeCoverage ? sql`` : sql`AND r.id IN (SELECT id FROM releases_visible)`}
            ${
              sourceIds
                ? sql`AND r.source_id IN (${sql.join(
                    sourceIds.map((id) => sql`${id}`),
                    sql`, `,
                  )})`
                : sql``
            }
            ${params.kind ? sql`AND COALESCE(s.kind, p.kind) = ${params.kind}` : sql``}
            ${since ? sql`AND r.published_at >= ${since}` : sql``}
            ${until ? sql`AND r.published_at <= ${until}` : sql``}
          ORDER BY rank LIMIT ${limit}
        `);
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
  let memberRollups: SearchCollectionHit[] = [];
  if (wanted.has("collections") && matchedOrgs.length > 0) {
    type RawRow = {
      slug: string;
      name: string;
      description: string | null;
      memberCount: number;
      matchedOrgSlug: string;
    };
    const orgSlugList = matchedOrgs.map((o) => o.slug);
    const memberRows = await db.all<RawRow>(sql`
      SELECT c.slug, c.name, c.description,
             (SELECT COUNT(*) FROM collection_members cm2
              INNER JOIN organizations_public op2 ON op2.id = cm2.org_id
              WHERE cm2.collection_id = c.id) as memberCount,
             op.slug as matchedOrgSlug
      FROM collections c
      INNER JOIN collection_members cm ON cm.collection_id = c.id
      INNER JOIN organizations_public op ON op.id = cm.org_id
      WHERE op.slug IN (${sql.join(
        orgSlugList.map((s) => sql`${s}`),
        sql`, `,
      )})
      ORDER BY c.name, op.slug
    `);
    const byCollection = new Map<string, SearchCollectionHit>();
    for (const r of memberRows) {
      const existing = byCollection.get(r.slug);
      if (existing) {
        existing.matchedOrgSlugs!.push(r.matchedOrgSlug);
      } else {
        byCollection.set(r.slug, {
          slug: r.slug,
          name: r.name,
          description: r.description,
          memberCount: Number(r.memberCount),
          via: "member",
          matchedOrgSlugs: [r.matchedOrgSlug],
        });
      }
    }
    memberRollups = [...byCollection.values()].slice(0, limit);
  }

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
        lines.push(
          [
            `- [release] **${r.title}**`,
            `  id: ${r.id}`,
            `  source: ${r.source.name} (${srcCoord}) | ${r.publishedAt ?? "N/A"}`,
            r.productSlug && r.orgSlug ? `  product: ${r.orgSlug}/${r.productSlug}` : null,
            r.version ? `  version: ${r.version}` : null,
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
      lines.push(
        `- [release] ${titleLine}\n  id: ${r.id}\n  source: ${r.sourceName} (${srcCoord}) | ${r.publishedAt ?? "N/A"}${productLine}\n  ${r.summary}`,
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
// Read-only mirrors of the REST endpoints in workers/api/src/routes/collections.ts.
// Membership joins through `organizations_public` so on_demand / soft-deleted
// orgs never leak through a collection — same model as the API, the web feed,
// and the org-overview surfaces.

export async function listCollections(db: D1Db, params: McpPaginationInput): Promise<ToolResult> {
  const pagination = parseMcpPagination(params);

  type Row = {
    slug: string;
    name: string;
    description: string | null;
    memberCount: number;
  };

  // `totalItems` counts every collection row; per-row `memberCount` only
  // counts visible members (joined through organizationsPublic). The two
  // counts measure different things on purpose — the total is for pagination,
  // the per-row count is for display.
  const [totalRow, rows] = await Promise.all([
    db.all<{ n: number }>(sql`SELECT COUNT(*) as n FROM ${collections}`),
    db.all<Row>(sql`
      SELECT c.slug, c.name, c.description,
        (
          (SELECT COUNT(*) FROM ${collectionMembers} cm
            INNER JOIN ${organizationsPublic} op ON op.id = cm.org_id
            WHERE cm.collection_id = c.id)
          +
          (SELECT COUNT(*) FROM ${collectionMembers} cm
            INNER JOIN ${productsActive} pa ON pa.id = cm.product_id
            INNER JOIN ${organizationsPublic} op ON op.id = pa.org_id
            WHERE cm.collection_id = c.id)
        ) AS memberCount
      FROM ${collections} c
      ORDER BY c.name
      LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
    `),
  ]);
  const totalItems = Number(totalRow[0]?.n ?? 0);
  if (totalItems === 0) {
    return emptyListResult({
      message: "No collections yet.",
      pagination,
    });
  }

  const body = rows
    .map((r) => {
      const descLine = r.description ? `\n  ${r.description}` : "";
      const noun = Number(r.memberCount) === 1 ? "member" : "members";
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
  const [collection] = await db
    .select({
      id: collections.id,
      slug: collections.slug,
      name: collections.name,
      description: collections.description,
    })
    .from(collections)
    .where(eq(collections.slug, slug));
  if (!collection) return text(`No collection found with slug "${slug}".`);

  // Match the REST endpoint: org members joined through organizationsPublic
  // and product members through productsActive so hidden / soft-deleted rows
  // don't leak. Both kinds are interleaved by (position, name) for display.
  const [orgs, productMembers] = await Promise.all([
    db
      .select({
        position: collectionMembers.position,
        slug: organizationsPublic.slug,
        name: organizationsPublic.name,
        domain: organizationsPublic.domain,
        description: organizationsPublic.description,
      })
      .from(collectionMembers)
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
      .where(eq(collectionMembers.collectionId, collection.id))
      .orderBy(collectionMembers.position, organizationsPublic.name),
    db
      .select({
        position: collectionMembers.position,
        productSlug: productsActive.slug,
        productName: productsActive.name,
        productDescription: productsActive.description,
        orgSlug: organizationsPublic.slug,
        orgName: organizationsPublic.name,
      })
      .from(collectionMembers)
      .innerJoin(productsActive, eq(productsActive.id, collectionMembers.productId))
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, productsActive.orgId))
      .where(eq(collectionMembers.collectionId, collection.id))
      .orderBy(collectionMembers.position, productsActive.name),
  ]);

  type MemberLine = { position: number; sort: string; line: string; sub?: string };
  const items: MemberLine[] = [];
  for (const o of orgs) {
    const tail = o.domain ? ` — ${o.domain}` : "";
    items.push({
      position: o.position,
      sort: o.name,
      line: `- **${o.name}** (${o.slug})${tail}`,
      sub: o.description ?? undefined,
    });
  }
  for (const p of productMembers) {
    items.push({
      position: p.position,
      sort: p.productName,
      line: `- **${p.productName}** (product · ${p.orgName} / ${p.productSlug})`,
      sub: p.productDescription ?? undefined,
    });
  }
  items.sort((a, b) => a.position - b.position || a.sort.localeCompare(b.sort));

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

  const [collection] = await db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(eq(collections.slug, slug));
  if (!collection) return text(`No collection found with slug "${slug}".`);

  // Visible org + product members only (matches the REST surface).
  const [orgRows, productRows] = await Promise.all([
    db
      .select({ orgId: organizationsPublic.id })
      .from(collectionMembers)
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
      .where(eq(collectionMembers.collectionId, collection.id)),
    db
      .select({ productId: productsActive.id })
      .from(collectionMembers)
      .innerJoin(productsActive, eq(productsActive.id, collectionMembers.productId))
      .where(eq(collectionMembers.collectionId, collection.id)),
  ]);
  const orgIds = orgRows.map((m) => m.orgId);
  const productIds = productRows.map((m) => m.productId);

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
