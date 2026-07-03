import { sql } from "drizzle-orm";
import {
  sqliteTable,
  sqliteView,
  text,
  integer,
  real,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/sqlite-core";
import {
  newSourceId,
  newReleaseId,
  newOrgId,
  newOrgAccountId,
  newFetchLogId,
  newIgnoredUrlId,
  newBlockedUrlId,
  newSummaryId,
  newMediaAssetId,
  newProductId,
  newTagId,
  newDomainAliasId,
  newKnowledgePageId,
  newKnowledgePageCitationId,
  newSourceChangelogFileId,
  newSourceChangelogChunkId,
  newTelemetryEventId,
  newSearchQueryId,
  newWebhookSubscriptionId,
  newCollectionId,
  newCollectionDailySummaryId,
  newBatchRunId,
  newApiTokenId,
  newFeedbackId,
  newRecommendationId,
  newRawSnapshotId,
} from "./id.js";
import { PRINCIPAL_TYPES } from "./api-token.js";
import { BREAKING_LEVELS, type BreakingLevel } from "./breaking.js";

export const RELEASE_TYPES = ["feature", "rollup"] as const;
export type ReleaseType = (typeof RELEASE_TYPES)[number];

// Breaking-change classification enum lives in its own pure module (#1696) so
// the AI classifier and wire types can read it without importing this
// drizzle-laden schema. Re-exported here for callers that already pull schema.
export { BREAKING_LEVELS, type BreakingLevel };

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey().$defaultFn(newOrgId),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    domain: text("domain").unique(),
    description: text("description"),
    category: text("category"),
    avatarUrl: text("avatar_url"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    metadata: text("metadata").default("{}"),
    embeddedAt: text("embedded_at"),
    discovery: text("discovery", { enum: ["curated", "agent", "on_demand"] })
      .notNull()
      .default("curated"),
    // Per-org opt-in for ingest-time release content generation. When true,
    // the poll-fetch / scrape-agent workflows call Haiku 4.5 to populate
    // title_generated / title_short / summary on newly-inserted releases.
    // Default false — every existing org is opted out; toggle in via SQL
    // for the initial roster.
    autoGenerateContent: integer("auto_generate_content", { mode: "boolean" })
      .notNull()
      .default(false),
    // Per-org ingest pause (#1057). When true, the org's sources are excluded
    // from the poll-fetch and scrape-agent-sweep due-source queries so no new
    // fetches fire. The org and its releases remain fully visible in the public
    // catalog — only ingest stops. Toggle via PATCH /v1/orgs/:slug
    // { fetchPaused: true }. Default false — identical to current behavior for
    // every existing org.
    fetchPaused: integer("fetch_paused", { mode: "boolean" }).notNull().default(false),
    // Per-org "don't feature" flag. When true, the org is excluded from the
    // homepage latest-releases ticker and the main /v1/orgs directory table,
    // but stays fully reachable via its detail page, search, and the sitemap.
    // Distinct from fetchPaused (ingest-only) and deletedAt (soft-delete).
    // Toggle via PATCH /v1/orgs/:slug { isHidden: true }. Default false.
    isHidden: integer("is_hidden", { mode: "boolean" }).notNull().default(false),
    // Editorial "promote on the home page" flag. When true, the org appears in the
    // home page's featured rail; the full A–Z list lives at /catalog regardless.
    // Toggle via PATCH /v1/orgs/:slug { featured: true }. Default false.
    featured: integer("featured", { mode: "boolean" }).notNull().default(false),
    // Soft-delete tombstone (#666). Read paths exclude rows where deleted_at
    // IS NOT NULL via notDeleted helpers in queries/shared.ts. On tombstone,
    // the route handler renames slug + domain to mangled forms (slug + "--" +
    // id) so a re-onboard under the original identifier doesn't collide with
    // the inline UNIQUE constraint.
    deletedAt: text("deleted_at"),
  },
  (table) => [
    // Backs the nightly tombstone sweep cron's "deleted_at < cutoff" candidate
    // collection. Partial form keeps the index trivially small.
    index("idx_organizations_deleted_at")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
);

export const orgAccounts = sqliteTable(
  "org_accounts",
  {
    id: text("id").primaryKey().$defaultFn(newOrgAccountId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_org_accounts_platform_handle").on(table.platform, table.handle),
    // Backs the correlated github-handle subquery (`WHERE org_id = ? AND
    // platform = 'github'`) used across collections, the cross-org latest feed,
    // and collection-feed. The unique (platform, handle) index can't service an
    // org_id-leading lookup, so each call site was an unindexed scan per row
    // (#1800 finding 4).
    index("idx_org_accounts_org_platform").on(table.orgId, table.platform),
  ],
);

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey().$defaultFn(newProductId),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url"),
    description: text("description"),
    category: text("category"),
    kind: text("kind"),
    avatarUrl: text("avatar_url"),
    metadata: text("metadata").default("{}"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    embeddedAt: text("embedded_at"),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("idx_products_org").on(table.orgId),
    // #690 Phase C: per-org uniqueness is the only slug constraint now; the global UNIQUE was dropped via scripts/migrations/690-phase-c-rebuild.sql.
    uniqueIndex("idx_products_org_slug").on(table.orgId, table.slug),
    index("idx_products_deleted_at")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    index("idx_products_kind")
      .on(table.kind)
      .where(sql`${table.kind} IS NOT NULL`),
  ],
);

export const domainAliases = sqliteTable(
  "domain_aliases",
  {
    id: text("id").primaryKey().$defaultFn(newDomainAliasId),
    domain: text("domain").notNull().unique(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => products.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_domain_aliases_org").on(table.orgId),
    index("idx_domain_aliases_product").on(table.productId),
  ],
);

export type DomainAlias = typeof domainAliases.$inferSelect;
export type NewDomainAlias = typeof domainAliases.$inferInsert;

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey().$defaultFn(newTagId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const orgTags = sqliteTable(
  "org_tags",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_org_tags_pk").on(table.orgId, table.tagId),
    index("idx_org_tags_tag").on(table.tagId),
  ],
);

export const productTags = sqliteTable(
  "product_tags",
  {
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_product_tags_pk").on(table.productId, table.tagId),
    index("idx_product_tags_tag").on(table.tagId),
  ],
);

// Collections are curated, named groups of orgs and/or products that drive a
// public "playlist" page (e.g. /collections/frontier-ai-labs). Independent of
// the fixed `category` taxonomy on `organizations` so a collection can mix
// orgs across categories, surface a tighter subset than any single category,
// or pin a single product without dragging in the owning org's other products
// (e.g. Claude Code without the rest of Anthropic). The only read paths today
// are GET /v1/collections, GET /v1/collections/:slug, and GET
// /v1/collections/:slug/releases (interleaved cross-member feed).
export const collections = sqliteTable("collections", {
  id: text("id").primaryKey().$defaultFn(newCollectionId),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  // ISO timestamp of the last successful upsert into ENTITIES_INDEX. NULL when
  // the collection hasn't been embedded yet (e.g. seed rows pre-feature, or a
  // transient embed failure). The backfill script sweeps NULL rows.
  embeddedAt: text("embedded_at"),
  // "Promote on the homepage" flag. When set, the collection appears in the
  // home page's featured-collections sidebar block. Toggle via
  // PATCH /v1/collections/:slug { isFeatured: true }. Default false.
  isFeatured: integer("is_featured", { mode: "boolean" }).notNull().default(false),
  // Per-collection on/off for the nightly daily-summary generation. Default
  // true — collections opt OUT, not in. Toggle via PATCH /v1/collections/:slug.
  dailySummaryEnabled: integer("daily_summary_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
});

// A member is either an org (`org_id` set, `product_id` null) or a single
// product (`product_id` set, `org_id` null). Exactly-one-of is enforced by a
// SQL CHECK so a curator can pin Claude Code without dragging Anthropic's
// other products along. Dedup is via two partial unique indexes — one per
// kind — so org-membership and product-membership don't collide.
export const collectionMembers = sqliteTable(
  "collection_members",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => products.id, { onDelete: "cascade" }),
    // Authoring order — surfaces in the playlist header on the web page. Ties
    // resolve by name in the route handler so equal positions stay stable.
    position: integer("position").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_collection_members_org_pk")
      .on(table.collectionId, table.orgId)
      .where(sql`${table.orgId} IS NOT NULL`),
    uniqueIndex("idx_collection_members_product_pk")
      .on(table.collectionId, table.productId)
      .where(sql`${table.productId} IS NOT NULL`),
    index("idx_collection_members_org")
      .on(table.orgId)
      .where(sql`${table.orgId} IS NOT NULL`),
    index("idx_collection_members_product")
      .on(table.productId)
      .where(sql`${table.productId} IS NOT NULL`),
    check(
      "collection_members_xor_kind",
      sql`(${table.orgId} IS NOT NULL) <> (${table.productId} IS NOT NULL)`,
    ),
  ],
);

// One brief AI rollup per (collection, Eastern calendar day): a headline,
// a one-line summary, and bullet takeaways covering that day's releases
// across the collection's members. Written by the nightly
// collection-summaries cron; read by GET /v1/collections/:slug/daily-summaries
// and rendered as a header on each day group in the collection timeline.
export const collectionDailySummaries = sqliteTable(
  "collection_daily_summaries",
  {
    id: text("id").primaryKey().$defaultFn(newCollectionDailySummaryId),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    // Eastern calendar day being summarized, as YYYY-MM-DD.
    summaryDate: text("summary_date").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    // JSON array of bullet strings.
    takeaways: text("takeaways").notNull().default("[]"),
    releaseCount: integer("release_count").notNull().default(0),
    // `<provider>:<model>` that produced this row.
    modelId: text("model_id"),
    generatedAt: text("generated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_collection_daily_summaries_day").on(table.collectionId, table.summaryDate),
  ],
);

// Optional editable metadata overlay for the fixed `CATEGORIES` taxonomy in
// `@buildinternet/releases-core/categories`. The slug is still the canonical
// reference everywhere (`organizations.category`, `products.category`,
// validation via `isValidCategory`); a row here only exists when an operator
// has customized the byline. `name` overrides the auto-titlecased display
// (e.g. "Developer Tools"); when null the API falls back to
// `categoryDisplayName(slug)`. `description` powers the web byline.
// `aliases` is a JSON array of alternative slugs that redirect to this
// canonical category (e.g. "e-commerce" → "commerce"). Stored as JSON rather
// than a separate table because the alias surface is small and always loaded
// in bulk for cross-category resolution. Uniqueness across rows is enforced
// at the API layer, not in SQL.
export const categories = sqliteTable("categories", {
  slug: text("slug").primaryKey(),
  name: text("name"),
  description: text("description"),
  aliases: text("aliases").notNull().default("[]"),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey().$defaultFn(newSourceId),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    type: text("type", {
      enum: ["github", "scrape", "feed", "agent", "appstore", "video"],
    }).notNull(),
    url: text("url").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    metadata: text("metadata").default("{}"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    lastFetchedAt: text("last_fetched_at"),
    lastContentHash: text("last_content_hash"),
    fetchPriority: text("fetch_priority", { enum: ["normal", "low", "paused"] }).default("normal"),
    consecutiveNoChange: integer("consecutive_no_change").default(0),
    consecutiveErrors: integer("consecutive_errors").default(0),
    nextFetchAfter: text("next_fetch_after"),
    changeDetectedAt: text("change_detected_at"),
    // Drain cooldown marker (#1862): last time the scrape/agent drain successfully
    // dispatched a managed-agent /update covering this source. `queryCandidates`
    // excludes sources drained within DRAIN_COOLDOWN_MS so a permanently-flagged,
    // un-fetchable source doesn't re-drain (and re-bill a no-op Haiku session)
    // every SourceActor poll tick. NULL = never drained through the actor path.
    lastDrainAt: text("last_drain_at"),
    lastPolledAt: text("last_polled_at"),
    // Cadence observability — written by the daily retier job. `medianGapDays`
    // is the median gap (in days) between consecutive publishedAt values over
    // the last 180 days of non-suppressed releases; null when <3 releases of
    // signal. `lastRetieredAt` is the last time the retier evaluated this
    // source (null if the retier has never seen it yet).
    medianGapDays: real("median_gap_days"),
    lastRetieredAt: text("last_retiered_at"),
    isPrimary: integer("is_primary", { mode: "boolean" }).default(false),
    isHidden: integer("is_hidden", { mode: "boolean" }).default(false),
    embeddedAt: text("embedded_at"),
    discovery: text("discovery", { enum: ["curated", "agent", "on_demand"] })
      .notNull()
      .default("curated"),
    kind: text("kind"),
    // GitHub stargazer count, refreshed on each GitHub poll + at on-demand
    // materialization. Null = never fetched. `stars_fetched_at` records the
    // last refresh. Indexed for a future "most-starred" sort.
    stargazersCount: integer("stargazers_count"),
    starsFetchedAt: text("stars_fetched_at"),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("idx_sources_org").on(table.orgId),
    index("idx_sources_org_hidden").on(table.orgId, table.isHidden),
    index("idx_sources_product").on(table.productId),
    // #690 Phase C: per-org uniqueness is the only slug constraint now; the global UNIQUE was dropped via scripts/migrations/690-phase-c-rebuild.sql.
    uniqueIndex("idx_sources_org_slug").on(table.orgId, table.slug),
    // Standalone index for slug-only lookups — Phase C dropped the global
    // UNIQUE(slug) which had been doubling as this index. Composite
    // idx_sources_org_slug can't service `WHERE slug = ?` without an org_id
    // predicate, and we still query that way on org-less paths (the usage-log
    // dual-write resolver, MCP coordinate resolution, etc.).
    index("idx_sources_slug").on(table.slug),
    // Back the /status Sources-tab ORDER BY variants — the admin dashboard
    // sorts by name, last_fetched_at, and median_gap_days.
    index("idx_sources_name").on(table.name),
    index("idx_sources_last_fetched_at").on(table.lastFetchedAt),
    index("idx_sources_median_gap_days").on(table.medianGapDays),
    index("idx_sources_deleted_at")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    index("idx_sources_kind")
      .on(table.kind)
      .where(sql`${table.kind} IS NOT NULL`),
    index("idx_sources_stargazers_count")
      .on(table.stargazersCount)
      .where(sql`${table.stargazersCount} IS NOT NULL`),
  ],
);

export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey().$defaultFn(newReleaseId),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    version: text("version"),
    // Lexicographically sortable representation of `version` — see
    // `computeVersionSort()` in `@buildinternet/releases-core/version-sort`.
    // Lets `MAX()` aggregates pick the semver-highest version even when a
    // backport patch on an older line ships after a newer major release.
    // Null when the version has no numeric content (or is missing).
    versionSort: text("version_sort"),
    type: text("type", { enum: RELEASE_TYPES }).notNull().default("feature"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    summary: text("summary"),
    titleGenerated: text("title_generated"),
    titleShort: text("title_short"),
    // Breaking-change classification + extracted upgrade steps (#1696).
    // `breaking` defaults "unknown" (fail-open); `migration_notes` is null
    // unless the body explicitly describes upgrade/migration steps. Populated
    // live at ingest only for developer-facing source kinds; history stays
    // "unknown" (no backfill).
    breaking: text("breaking", { enum: BREAKING_LEVELS }).notNull().default("unknown"),
    migrationNotes: text("migration_notes"),
    url: text("url"),
    contentHash: text("content_hash"),
    // Cached size of `content` (in raw chars and cl100k_base tokens) so feed
    // surfaces can advertise "this release is ~1.5K tokens" without round-
    // tripping the body for every row. Computed on write via `withContentSize`
    // and recomputed when content changes through the upsert path. Nullable
    // because old rows pre-date the column; the backfill script populates them
    // and the renderers degrade gracefully when null. #958.
    contentChars: integer("content_chars"),
    contentTokens: integer("content_tokens"),
    metadata: text("metadata").default("{}"),
    media: text("media").default("[]"),
    publishedAt: text("published_at"),
    prerelease: integer("prerelease", { mode: "boolean" }).notNull().default(false),
    suppressed: integer("suppressed", { mode: "boolean" }).default(false),
    suppressedReason: text("suppressed_reason"),
    fetchedAt: text("fetched_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    embeddedAt: text("embedded_at"),
  },
  (table) => [
    uniqueIndex("idx_releases_source_url").on(table.sourceId, table.url),
    index("idx_releases_source_published").on(table.sourceId, table.publishedAt),
    index("idx_releases_published").on(table.publishedAt),
    // Covers `(published_at DESC, id DESC)` cursor walks — GraphQL `latestReleases`
    // and REST `/v1/orgs/:slug/releases`. Drizzle's index() helper doesn't emit
    // direction modifiers, so the matching DESC index is hand-authored in the
    // migration file (20260506000000_releases_published_id_index.sql).
    index("idx_releases_published_id").on(table.publishedAt, table.id),
    index("idx_releases_source_suppressed_published").on(
      table.sourceId,
      table.suppressed,
      table.publishedAt,
    ),
    index("idx_releases_fetched_at").on(table.fetchedAt),
    index("idx_releases_source_version_sort").on(table.sourceId, table.versionSort),
  ],
);

export const USAGE_EXTRACTION_MODES = [
  "oneshot",
  "toolloop",
  "toolloop:partial",
  "toolloop:no_sketch",
  "fallback_to_oneshot",
] as const;
export type UsageExtractionMode = (typeof USAGE_EXTRACTION_MODES)[number];

export const USAGE_FALLBACK_REASONS = [
  "max_rounds",
  "tool_error",
  "no_terminal_call",
  "max_tokens",
  "sdk_error",
] as const;
export type UsageFallbackReason = (typeof USAGE_FALLBACK_REASONS)[number];

export const usageLog = sqliteTable("usage_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  operation: text("operation").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  // SET NULL (not CASCADE) — usage_log is historical telemetry. A source
  // delete shouldn't sweep its post-migration rows; the row stays with
  // source_id NULL and contributes to totals + by-operation/by-model rollups.
  sourceId: text("source_id").references(() => sources.id, { onDelete: "set null" }),
  releaseCount: integer("release_count"),
  extractionMode: text("extraction_mode").$type<UsageExtractionMode>(),
  toolRounds: integer("tool_rounds"),
  toolChars: integer("tool_chars"),
  fallbackReason: text("fallback_reason").$type<UsageFallbackReason>(),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const FETCH_LOG_STATUSES = [
  "success",
  "error",
  "no_change",
  "dry_run",
  "blocked",
  "crawl_timeout",
  "skipped",
] as const;
export type FetchLogStatus = (typeof FETCH_LOG_STATUSES)[number];

export const fetchLog = sqliteTable(
  "fetch_log",
  {
    id: text("id").primaryKey().$defaultFn(newFetchLogId),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    releasesFound: integer("releases_found").notNull(),
    releasesInserted: integer("releases_inserted").notNull(),
    durationMs: integer("duration_ms"),
    status: text("status", { enum: FETCH_LOG_STATUSES }).notNull(),
    error: text("error"),
    errorCategory: text("error_category"),
    rawContent: text("raw_content"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_fetch_log_source").on(table.sourceId),
    index("idx_fetch_log_created").on(table.createdAt),
    index("idx_fetch_log_session").on(table.sessionId),
    // Backs the per-source window query in getStuckSources (PARTITION BY
    // source_id ORDER BY created_at DESC) — see migration
    // 20260523000000_add_fetch_log_source_created_idx.sql.
    index("idx_fetch_log_source_created").on(table.sourceId, table.createdAt),
  ],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Release = typeof releases.$inferSelect;
export type NewRelease = typeof releases.$inferInsert;
export type UsageLog = typeof usageLog.$inferSelect;
export type NewUsageLog = typeof usageLog.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrgAccount = typeof orgAccounts.$inferSelect;
export type NewOrgAccount = typeof orgAccounts.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type CollectionMember = typeof collectionMembers.$inferSelect;
export type NewCollectionMember = typeof collectionMembers.$inferInsert;
export type CollectionDailySummary = typeof collectionDailySummaries.$inferSelect;
export type NewCollectionDailySummary = typeof collectionDailySummaries.$inferInsert;
export type FetchLog = typeof fetchLog.$inferSelect;
export type NewFetchLog = typeof fetchLog.$inferInsert;

export const TELEMETRY_CLIENT_KINDS = [
  "external",
  "internal-agent",
  "internal-sandbox",
  "internal-ci",
  "internal-dev",
  "mcp-stdio",
] as const;
export type TelemetryClientKind = (typeof TELEMETRY_CLIENT_KINDS)[number];

export const TELEMETRY_SURFACES = ["cli", "mcp"] as const;
export type TelemetrySurface = (typeof TELEMETRY_SURFACES)[number];

export const telemetryEvents = sqliteTable(
  "telemetry_events",
  {
    id: text("id").primaryKey().$defaultFn(newTelemetryEventId),
    anonId: text("anon_id").notNull(),
    timestamp: integer("timestamp").notNull(),
    surface: text("surface").notNull(),
    clientKind: text("client_kind").notNull().default("external"),
    sessionId: text("session_id"),
    agentName: text("agent_name"),
    model: text("model"),
    command: text("command").notNull(),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    cliVersion: text("cli_version").notNull(),
    os: text("os"),
    arch: text("arch"),
    runtime: text("runtime"),
  },
  (table) => [
    index("idx_telemetry_timestamp").on(table.timestamp),
    index("idx_telemetry_kind_timestamp").on(table.clientKind, table.timestamp),
    index("idx_telemetry_command_timestamp").on(table.command, table.timestamp),
    index("idx_telemetry_anon_timestamp").on(table.anonId, table.timestamp),
    index("idx_telemetry_session").on(table.sessionId),
  ],
);

export type TelemetryEvent = typeof telemetryEvents.$inferSelect;
export type NewTelemetryEvent = typeof telemetryEvents.$inferInsert;

export const FEEDBACK_TYPES = ["bug", "idea", "other", "general"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_STATUSES = ["new", "triaged", "closed"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/**
 * User-submitted CLI feedback. Distinct from `telemetry_events` (which is
 * PII-clean by contract): `feedback` intentionally carries free text and an
 * optional contact. `anon_id` is attached by the CLI only when telemetry is
 * enabled.
 */
export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey().$defaultFn(newFeedbackId),
    createdAt: integer("created_at").notNull(),
    message: text("message").notNull(),
    contact: text("contact"),
    type: text("type").notNull().default("general"),
    status: text("status").notNull().default("new"),
    // Soft-removal flag: hides spam/test/handled rows from the default admin
    // read path without losing the row. Orthogonal to triage `status` — a row
    // can be `closed` and visible, or `new` and archived. Hard delete still
    // exists (DELETE /v1/feedback/:id) for genuine junk.
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    cliVersion: text("cli_version"),
    clientKind: text("client_kind").notNull().default("external"),
    anonId: text("anon_id"),
    os: text("os"),
    arch: text("arch"),
    runtime: text("runtime"),
    surface: text("surface").notNull().default("cli"),
  },
  (table) => [
    index("idx_feedback_created").on(table.createdAt),
    index("idx_feedback_status_created").on(table.status, table.createdAt),
    index("idx_feedback_type_created").on(table.type, table.createdAt),
    index("idx_feedback_anon").on(table.anonId),
  ],
);

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;

export const RECOMMENDATION_TYPES = ["source"] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_STATUSES = ["new", "triaged", "closed"] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/**
 * User-submitted recommendations from the web app. Today the only supported
 * type is `source` (release-note/source URL recommendations), but the resource
 * is intentionally generic so future recommendation types can share triage.
 */
export const recommendations = sqliteTable(
  "recommendations",
  {
    id: text("id").primaryKey().$defaultFn(newRecommendationId),
    createdAt: integer("created_at").notNull(),
    type: text("type").notNull().default("source"),
    url: text("url").notNull(),
    note: text("note"),
    contactEmail: text("contact_email"),
    status: text("status").notNull().default("new"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    surface: text("surface").notNull().default("web"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("idx_recommendations_created").on(table.createdAt),
    index("idx_recommendations_status_created").on(table.status, table.createdAt),
    index("idx_recommendations_type_created").on(table.type, table.createdAt),
    index("idx_recommendations_url").on(table.url),
  ],
);

export type Recommendation = typeof recommendations.$inferSelect;
export type NewRecommendation = typeof recommendations.$inferInsert;

export const notificationCounters = sqliteTable(
  "notification_counters",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_notification_counters_expires_at").on(table.expiresAt)],
);

export type NotificationCounter = typeof notificationCounters.$inferSelect;
export type NewNotificationCounter = typeof notificationCounters.$inferInsert;

export const SEARCH_SURFACES = ["web", "mcp", "api"] as const;
export type SearchSurface = (typeof SEARCH_SURFACES)[number];

export const SEARCH_MODES = ["lexical", "semantic", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/**
 * Records the *content* of search queries — what users typed — separately from
 * `telemetry_events`, which only tracks command names. The shapes diverge on
 * purpose: telemetry is intentionally PII-clean, search-query rows carry free
 * text. Keep the split so the OSS CLI's telemetry contract stays narrow.
 */
export const searchQueries = sqliteTable(
  "search_queries",
  {
    id: text("id").primaryKey().$defaultFn(newSearchQueryId),
    timestamp: integer("timestamp").notNull(),
    surface: text("surface").notNull(),
    clientKind: text("client_kind").notNull().default("external"),
    query: text("query").notNull(),
    mode: text("mode"),
    types: text("types"),
    organization: text("organization"),
    entity: text("entity"),
    orgHits: integer("org_hits"),
    catalogHits: integer("catalog_hits"),
    releaseHits: integer("release_hits"),
    chunkHits: integer("chunk_hits"),
    collectionHits: integer("collection_hits"),
    degraded: integer("degraded", { mode: "boolean" }),
    durationMs: integer("duration_ms"),
    anonId: text("anon_id"),
    sessionId: text("session_id"),
    userAgent: text("user_agent"),
    // Nullable on purpose: NULL = unknown (e.g. transports that never carry
    // an Authorization header, like MCP today), false = explicitly unauthed,
    // true = valid Bearer matched RELEASED_API_KEY at request time.
    authed: integer("authed", { mode: "boolean" }),
  },
  (table) => [
    index("idx_search_queries_timestamp").on(table.timestamp),
    index("idx_search_queries_surface_timestamp").on(table.surface, table.timestamp),
    // (timestamp, query) covers `/admin/search-queries/top`'s
    // `WHERE timestamp > ? GROUP BY query` access pattern; SQLite range-scans
    // on the leading column then aggregates without an extra sort.
    index("idx_search_queries_timestamp_query").on(table.timestamp, table.query),
  ],
);

export type SearchQuery = typeof searchQueries.$inferSelect;
export type NewSearchQuery = typeof searchQueries.$inferInsert;

export const ignoredUrls = sqliteTable(
  "ignored_urls",
  {
    id: text("id").primaryKey().$defaultFn(newIgnoredUrlId),
    url: text("url").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reason: text("reason"),
    ignoredAt: text("ignored_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex("idx_ignored_urls_org_url").on(table.orgId, table.url)],
);

export const blockedUrls = sqliteTable("blocked_urls", {
  id: text("id").primaryKey().$defaultFn(newBlockedUrlId),
  pattern: text("pattern").notNull().unique(),
  type: text("type", { enum: ["exact", "domain"] })
    .notNull()
    .default("exact"),
  reason: text("reason"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type IgnoredUrl = typeof ignoredUrls.$inferSelect;
export type NewIgnoredUrl = typeof ignoredUrls.$inferInsert;
export type BlockedUrl = typeof blockedUrls.$inferSelect;
export type NewBlockedUrl = typeof blockedUrls.$inferInsert;

export const releaseSummaries = sqliteTable(
  "release_summaries",
  {
    id: text("id").primaryKey().$defaultFn(newSummaryId),
    sourceId: text("source_id").references(() => sources.id, { onDelete: "cascade" }),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["rolling", "monthly"] }).notNull(),
    year: integer("year"),
    month: integer("month"),
    windowDays: integer("window_days"),
    summary: text("summary").notNull(),
    releaseCount: integer("release_count").notNull(),
    generatedAt: text("generated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_summaries_unique").on(
      table.sourceId,
      table.orgId,
      table.type,
      table.year,
      table.month,
    ),
    index("idx_summaries_source_type").on(table.sourceId, table.type),
    index("idx_summaries_org_type").on(table.orgId, table.type),
  ],
);

export type ReleaseSummary = typeof releaseSummaries.$inferSelect;
export type NewReleaseSummary = typeof releaseSummaries.$inferInsert;

export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: text("id").primaryKey().$defaultFn(newMediaAssetId),
    r2Key: text("r2_key").notNull().unique(),
    sourceUrl: text("source_url").notNull(),
    sourceFilename: text("source_filename"),
    contentType: text("content_type").notNull(),
    contentHash: text("content_hash").notNull().unique(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    sourceId: text("source_id").references(() => sources.id, { onDelete: "set null" }),
    releaseId: text("release_id").references(() => releases.id, { onDelete: "set null" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_media_assets_source").on(table.sourceId),
    index("idx_media_assets_release").on(table.releaseId),
    index("idx_media_assets_hash").on(table.contentHash),
  ],
);

export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;

export const knowledgePages = sqliteTable(
  "knowledge_pages",
  {
    id: text("id").primaryKey().$defaultFn(newKnowledgePageId),
    scope: text("scope", { enum: ["org", "product", "playbook"] }).notNull(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => products.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    /** Free-form agent notes — stored separately from auto-generated content. */
    notes: text("notes"),
    releaseCount: integer("release_count").notNull().default(0),
    lastContributingReleaseAt: text("last_contributing_release_at"),
    generatedAt: text("generated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_knowledge_pages_scope_org").on(table.scope, table.orgId),
    uniqueIndex("idx_knowledge_pages_scope_product").on(table.scope, table.productId),
    index("idx_knowledge_pages_scope").on(table.scope),
  ],
);

export type KnowledgePage = typeof knowledgePages.$inferSelect;
export type NewKnowledgePage = typeof knowledgePages.$inferInsert;

/**
 * Inline citations attached to a knowledge_pages row. Populated when an org
 * overview is generated via Anthropic search_result blocks (#846); each row
 * maps a character span in `knowledge_pages.content` back to the release post
 * it summarizes. start_index / end_index are inclusive/exclusive offsets into
 * the page body. release_id is best-effort: resolved from source_url at write
 * time, set null on miss.
 */
export const knowledgePageCitations = sqliteTable(
  "knowledge_page_citations",
  {
    id: text("id").primaryKey().$defaultFn(newKnowledgePageCitationId),
    knowledgePageId: text("knowledge_page_id")
      .notNull()
      .references(() => knowledgePages.id, { onDelete: "cascade" }),
    startIndex: integer("start_index").notNull(),
    endIndex: integer("end_index").notNull(),
    sourceUrl: text("source_url").notNull(),
    title: text("title"),
    citedText: text("cited_text").notNull(),
    releaseId: text("release_id").references(() => releases.id, { onDelete: "set null" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("idx_knowledge_page_citations_page").on(table.knowledgePageId)],
);

export type KnowledgePageCitation = typeof knowledgePageCitations.$inferSelect;
export type NewKnowledgePageCitation = typeof knowledgePageCitations.$inferInsert;

export const sourceChangelogFiles = sqliteTable(
  "source_changelog_files",
  {
    id: text("id").primaryKey().$defaultFn(newSourceChangelogFileId),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    filename: text("filename").notNull(),
    url: text("url").notNull(),
    rawUrl: text("raw_url").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    bytes: integer("bytes").notNull(),
    tokens: integer("tokens"),
    fetchedAt: text("fetched_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("scf_source_path_uq").on(table.sourceId, table.path),
    index("idx_scf_source").on(table.sourceId),
  ],
);

export type SourceChangelogFile = typeof sourceChangelogFiles.$inferSelect;
export type NewSourceChangelogFile = typeof sourceChangelogFiles.$inferInsert;

export const sourceRawSnapshots = sqliteTable(
  "source_raw_snapshots",
  {
    id: text("id").primaryKey().$defaultFn(newRawSnapshotId),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    contentHash: text("content_hash").notNull(),
    format: text("format").notNull(), // "markdown" | "html"
    bytes: integer("bytes").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_raw_snapshots_source").on(table.sourceId, table.createdAt),
    uniqueIndex("uq_raw_snapshots_source_hash").on(table.sourceId, table.contentHash),
  ],
);

export type SourceRawSnapshot = typeof sourceRawSnapshots.$inferSelect;

export const sourceChangelogChunks = sqliteTable(
  "source_changelog_chunks",
  {
    id: text("id").primaryKey().$defaultFn(newSourceChangelogChunkId),
    sourceChangelogFileId: text("source_changelog_file_id")
      .notNull()
      .references(() => sourceChangelogFiles.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    offset: integer("offset").notNull(),
    length: integer("length").notNull(),
    tokens: integer("tokens").notNull(),
    contentHash: text("content_hash").notNull(),
    heading: text("heading"),
    vectorId: text("vector_id"),
    embeddedAt: text("embedded_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("scc_file_offset_uq").on(table.sourceChangelogFileId, table.offset),
    index("idx_scc_file").on(table.sourceChangelogFileId),
    index("idx_scc_source").on(table.sourceId),
    index("idx_scc_content_hash").on(table.contentHash),
  ],
);

export type SourceChangelogChunk = typeof sourceChangelogChunks.$inferSelect;
export type NewSourceChangelogChunk = typeof sourceChangelogChunks.$inferInsert;

export const WEBHOOK_SCOPES = ["org", "follows"] as const;
export type WebhookScope = (typeof WEBHOOK_SCOPES)[number];

/** Output format for a webhook delivery. `json` = signed raw event; `slack` = Slack Block Kit. */
export const WEBHOOK_FORMATS = ["json", "slack"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export const webhookSubscriptions = sqliteTable(
  "webhook_subscriptions",
  {
    id: text("id").primaryKey().$defaultFn(newWebhookSubscriptionId),
    /** Set for self-serve `/v1/me/webhooks` rows; null for admin-provisioned subs. */
    userId: text("user_id"),
    /** `org` = single-org filter; `follows` = deliver releases matching user_follows. */
    scope: text("scope", { enum: WEBHOOK_SCOPES }).notNull().default("org"),
    /** Null when `scope = follows`. */
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    sourceId: text("source_id").references(() => sources.id, { onDelete: "cascade" }),
    /** Org-scoped filter: deliver only releases whose source belongs to this product. */
    productId: text("product_id").references(() => products.id, { onDelete: "cascade" }),
    /** Optional filter: deliver only releases of this taxonomy type. */
    releaseType: text("release_type", { enum: RELEASE_TYPES }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    description: text("description"),
    /** Delivery output format. `json` = signed raw event (default); `slack` = Slack Block Kit, unsigned. */
    format: text("format", { enum: WEBHOOK_FORMATS }).notNull().default("json"),
    secretVersion: integer("secret_version").notNull().default(1),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    lastSuccessAt: text("last_success_at"),
    lastErrorAt: text("last_error_at"),
    lastErrorMsg: text("last_error_msg"),
    /** ISO timestamp when the current consecutive-failure streak began; cleared on success. */
    failureStreakStartedAt: text("failure_streak_started_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledReason: text("disabled_reason"),
  },
  (table) => [
    index("idx_webhook_subs_org_enabled").on(table.orgId, table.enabled),
    index("idx_webhook_subs_org_source").on(table.orgId, table.sourceId),
    index("idx_webhook_subs_org_product").on(table.orgId, table.productId),
    index("idx_webhook_subs_user").on(table.userId),
    index("idx_webhook_subs_scope_enabled").on(table.scope, table.enabled),
  ],
);

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;

/**
 * Active-row views (#671). Each view is `SELECT * FROM <table> WHERE deleted_at
 * IS NULL`, exposed to Drizzle via `sqliteView(...).existing()` so the planner
 * inlines the predicate but drizzle-kit doesn't try to emit DDL for it. Read
 * paths import the *Active form; only admin DELETE/restore code and the
 * sweep-tombstones cron should reach the base tables.
 *
 * Column shapes mirror the base tables. Redeclaration is unfortunate but
 * `sqliteView(...).existing()` requires column builders; reusing the table's
 * builder objects would consume them twice.
 */
export const organizationsActive = sqliteView("organizations_active", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  domain: text("domain"),
  description: text("description"),
  category: text("category"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  metadata: text("metadata"),
  embeddedAt: text("embedded_at"),
  discovery: text("discovery", { enum: ["curated", "agent", "on_demand"] }).notNull(),
  autoGenerateContent: integer("auto_generate_content", { mode: "boolean" }).notNull(),
  fetchPaused: integer("fetch_paused", { mode: "boolean" }).notNull(),
  isHidden: integer("is_hidden", { mode: "boolean" }).notNull(),
  deletedAt: text("deleted_at"),
}).existing();

export const productsActive = sqliteView("products_active", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  orgId: text("org_id").notNull(),
  url: text("url"),
  description: text("description"),
  category: text("category"),
  kind: text("kind"),
  avatarUrl: text("avatar_url"),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
  embeddedAt: text("embedded_at"),
  deletedAt: text("deleted_at"),
}).existing();

export const sourcesActive = sqliteView("sources_active", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  type: text("type", {
    enum: ["github", "scrape", "feed", "agent", "appstore", "video"],
  }).notNull(),
  url: text("url").notNull(),
  orgId: text("org_id").notNull(),
  productId: text("product_id"),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
  lastFetchedAt: text("last_fetched_at"),
  lastContentHash: text("last_content_hash"),
  fetchPriority: text("fetch_priority", { enum: ["normal", "low", "paused"] }),
  consecutiveNoChange: integer("consecutive_no_change"),
  consecutiveErrors: integer("consecutive_errors"),
  nextFetchAfter: text("next_fetch_after"),
  changeDetectedAt: text("change_detected_at"),
  // Type-level mirror of the #1862 drain cooldown column — the real view is
  // `SELECT sources.*`, so it exposes it once the view is recreated.
  lastDrainAt: text("last_drain_at"),
  lastPolledAt: text("last_polled_at"),
  medianGapDays: real("median_gap_days"),
  lastRetieredAt: text("last_retiered_at"),
  isPrimary: integer("is_primary", { mode: "boolean" }),
  isHidden: integer("is_hidden", { mode: "boolean" }),
  embeddedAt: text("embedded_at"),
  discovery: text("discovery", { enum: ["curated", "agent", "on_demand"] }).notNull(),
  kind: text("kind"),
  stargazersCount: integer("stargazers_count"),
  starsFetchedAt: text("stars_fetched_at"),
  deletedAt: text("deleted_at"),
}).existing();

/**
 * Public-catalog view (#676). Layers on organizations_active so soft-delete
 * filtering is inherited, and additionally strips on-demand rows (anonymous
 * lookup-materialized orgs that should not appear in the public catalog).
 *
 * Column shape is identical to organizationsActive — both pass through all
 * organizations columns. Public catalog read paths import this view; admin
 * paths that need to see on-demand orgs keep using organizationsActive.
 */
export const organizationsPublic = sqliteView("organizations_public", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  domain: text("domain"),
  description: text("description"),
  category: text("category"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  metadata: text("metadata"),
  embeddedAt: text("embedded_at"),
  discovery: text("discovery", { enum: ["curated", "agent", "on_demand"] }).notNull(),
  autoGenerateContent: integer("auto_generate_content", { mode: "boolean" }).notNull(),
  fetchPaused: integer("fetch_paused", { mode: "boolean" }).notNull(),
  isHidden: integer("is_hidden", { mode: "boolean" }).notNull(),
  deletedAt: text("deleted_at"),
}).existing();

/**
 * Layers on sources_active with `is_hidden = 0`. Use this for public read
 * paths. Admin reads that want hidden rows use sources_active directly.
 */
export const sourcesVisible = sqliteView("sources_visible", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  type: text("type", {
    enum: ["github", "scrape", "feed", "agent", "appstore", "video"],
  }).notNull(),
  url: text("url").notNull(),
  orgId: text("org_id").notNull(),
  productId: text("product_id"),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
  lastFetchedAt: text("last_fetched_at"),
  lastContentHash: text("last_content_hash"),
  fetchPriority: text("fetch_priority", { enum: ["normal", "low", "paused"] }),
  consecutiveNoChange: integer("consecutive_no_change"),
  consecutiveErrors: integer("consecutive_errors"),
  nextFetchAfter: text("next_fetch_after"),
  changeDetectedAt: text("change_detected_at"),
  // Type-level mirror of the #1862 drain cooldown column — the real view is
  // `SELECT sources.*`, so it exposes it once the view is recreated.
  lastDrainAt: text("last_drain_at"),
  lastPolledAt: text("last_polled_at"),
  medianGapDays: real("median_gap_days"),
  lastRetieredAt: text("last_retiered_at"),
  isPrimary: integer("is_primary", { mode: "boolean" }),
  isHidden: integer("is_hidden", { mode: "boolean" }),
  embeddedAt: text("embedded_at"),
  discovery: text("discovery", { enum: ["curated", "agent", "on_demand"] }).notNull(),
  kind: text("kind"),
  stargazersCount: integer("stargazers_count"),
  starsFetchedAt: text("stars_fetched_at"),
  deletedAt: text("deleted_at"),
}).existing();

/**
 * Canonical read view for releases. Excludes both suppressed rows
 * and coverage-side rows (releases that are already covered by another
 * release). Use this for all user-facing read paths. Admin/ingest paths
 * that need to see suppressed or coverage rows use the base table directly.
 * Pass includeCoverage = true at call sites that legitimately want coverage
 * rows — those fall back to the base `releases` table.
 */
export const releasesVisible = sqliteView("releases_visible", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  version: text("version"),
  versionSort: text("version_sort"),
  type: text("type", { enum: RELEASE_TYPES }).notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  summary: text("summary"),
  titleGenerated: text("title_generated"),
  titleShort: text("title_short"),
  // Type-level mirror only (#1710) — the real view is `SELECT releases.*`, so
  // it already exposes the column added by 20260620000000_add_release_breaking.
  breaking: text("breaking", { enum: BREAKING_LEVELS }).notNull(),
  url: text("url"),
  contentHash: text("content_hash"),
  contentChars: integer("content_chars"),
  contentTokens: integer("content_tokens"),
  metadata: text("metadata"),
  media: text("media"),
  publishedAt: text("published_at"),
  prerelease: integer("prerelease", { mode: "boolean" }).notNull(),
  suppressed: integer("suppressed", { mode: "boolean" }),
  suppressedReason: text("suppressed_reason"),
  fetchedAt: text("fetched_at").notNull(),
  embeddedAt: text("embedded_at"),
}).existing();

/**
 * One row per Anthropic Message Batch submission. Written by the
 * generate-release-content script (and future BatchSummarizeWorkflow).
 * Lifecycle: submitted → in_progress → ended | failed.
 * actual_cost_usd is the sum of usage from requests that succeeded; null
 * only when zero requests ran (entire batch expired or canceled before work).
 */
export const batchRuns = sqliteTable(
  "batch_runs",
  {
    id: text("id").primaryKey().$defaultFn(newBatchRunId),
    anthropicBatchId: text("anthropic_batch_id").notNull().unique(),
    /** Who submitted: 'script' | 'workflow' | 'admin' */
    caller: text("caller", { enum: ["script", "workflow", "admin"] }).notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: ["submitted", "in_progress", "ended", "failed"] }).notNull(),
    requestCountTotal: integer("request_count_total").notNull().default(0),
    requestCountSucceeded: integer("request_count_succeeded").notNull().default(0),
    requestCountErrored: integer("request_count_errored").notNull().default(0),
    requestCountExpired: integer("request_count_expired").notNull().default(0),
    requestCountCanceled: integer("request_count_canceled").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    endedAt: text("ended_at"),
    estCostUsd: real("est_cost_usd"),
    actualCostUsd: real("actual_cost_usd"),
    /** JSON — free-form payload (script: { orgs, since_days }; workflow: { instance_id, trigger }) */
    callerContext: text("caller_context"),
    /** JSON — error details when request_count_errored > 0 */
    errorSummary: text("error_summary"),
  },
  (table) => [
    index("idx_batch_runs_created_at").on(table.createdAt),
    index("idx_batch_runs_anthropic_id").on(table.anthropicBatchId),
  ],
);

export type BatchRun = typeof batchRuns.$inferSelect;
export type NewBatchRun = typeof batchRuns.$inferInsert;

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey().$defaultFn(newApiTokenId),
    // Public, non-secret identifier embedded in the token. Indexed; safe to log.
    lookupId: text("lookup_id").notNull(),
    // SHA-256 hex of the secret. Never the plaintext.
    tokenHash: text("token_hash").notNull(),
    name: text("name").notNull(),
    // JSON array of scope strings, e.g. ["read","write"].
    scopes: text("scopes").notNull(),
    // Ownership: whom the token acts as. `internal` for systems/scripts.
    principalType: text("principal_type", { enum: PRINCIPAL_TYPES }).notNull().default("internal"),
    // Typed id of the owning entity when one exists (user_…, agent id). Null for internal.
    principalId: text("principal_id"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    revokedAt: text("revoked_at"),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    // Provenance: who minted it ("static-key", a minting token's id, later a user id).
    createdBy: text("created_by"),
    metadata: text("metadata").default("{}"),
  },
  (table) => [
    uniqueIndex("idx_api_tokens_lookup_id").on(table.lookupId),
    index("idx_api_tokens_principal").on(table.principalType, table.principalId),
    // DB-level guard so non-ORM writes can't slip in an out-of-vocabulary value.
    // Keep in lockstep with PRINCIPAL_TYPES and the matching CHECK in the migration.
    check(
      "api_tokens_principal_type_check",
      sql`${table.principalType} IN ('internal', 'agent', 'user')`,
    ),
  ],
);
