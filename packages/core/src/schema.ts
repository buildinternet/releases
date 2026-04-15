import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { newSourceId, newReleaseId, newOrgId, newOrgAccountId, newFetchLogId, newIgnoredUrlId, newBlockedUrlId, newSummaryId, newMediaAssetId, newProductId, newTagId, newDomainAliasId, newKnowledgePageId, newSourceChangelogFileId, newSourceChangelogChunkId, newTelemetryEventId } from "./id.js";

export const RELEASE_TYPES = ["feature", "rollup"] as const;
export type ReleaseType = (typeof RELEASE_TYPES)[number];

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey().$defaultFn(newOrgId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  domain: text("domain").unique(),
  description: text("description"),
  category: text("category"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  metadata: text("metadata").default("{}"),
  embeddedAt: text("embedded_at"),
});

export const orgAccounts = sqliteTable(
  "org_accounts",
  {
    id: text("id").primaryKey().$defaultFn(newOrgAccountId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_org_accounts_platform_handle").on(table.platform, table.handle),
  ],
);

export const products = sqliteTable("products", {
  id: text("id").primaryKey().$defaultFn(newProductId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  url: text("url"),
  description: text("description"),
  category: text("category"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  embeddedAt: text("embedded_at"),
}, (table) => [
  index("idx_products_org").on(table.orgId),
]);

export const domainAliases = sqliteTable(
  "domain_aliases",
  {
    id: text("id").primaryKey().$defaultFn(newDomainAliasId),
    domain: text("domain").notNull().unique(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => products.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
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
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_product_tags_pk").on(table.productId, table.tagId),
    index("idx_product_tags_tag").on(table.tagId),
  ],
);

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey().$defaultFn(newSourceId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  type: text("type", { enum: ["github", "scrape", "feed", "agent"] }).notNull(),
  url: text("url").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
  productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
  metadata: text("metadata").default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  lastFetchedAt: text("last_fetched_at"),
  lastContentHash: text("last_content_hash"),
  fetchPriority: text("fetch_priority", { enum: ["normal", "low", "paused"] }).default("normal"),
  consecutiveNoChange: integer("consecutive_no_change").default(0),
  consecutiveErrors: integer("consecutive_errors").default(0),
  nextFetchAfter: text("next_fetch_after"),
  changeDetectedAt: text("change_detected_at"),
  lastPolledAt: text("last_polled_at"),
  isPrimary: integer("is_primary", { mode: "boolean" }).default(false),
  isHidden: integer("is_hidden", { mode: "boolean" }).default(false),
  embeddedAt: text("embedded_at"),
}, (table) => [
  index("idx_sources_org").on(table.orgId),
  index("idx_sources_org_hidden").on(table.orgId, table.isHidden),
  index("idx_sources_product").on(table.productId),
]);

export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey().$defaultFn(newReleaseId),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    version: text("version"),
    type: text("type", { enum: RELEASE_TYPES }).notNull().default("feature"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentSummary: text("content_summary"),
    url: text("url"),
    contentHash: text("content_hash"),
    metadata: text("metadata").default("{}"),
    media: text("media").default("[]"),
    publishedAt: text("published_at"),
    suppressed: integer("suppressed", { mode: "boolean" }).default(false),
    suppressedReason: text("suppressed_reason"),
    fetchedAt: text("fetched_at").notNull().$defaultFn(() => new Date().toISOString()),
    embeddedAt: text("embedded_at"),
  },
  (table) => [
    uniqueIndex("idx_releases_source_url").on(table.sourceId, table.url),
    index("idx_releases_source_published").on(table.sourceId, table.publishedAt),
    index("idx_releases_published").on(table.publishedAt),
    index("idx_releases_source_suppressed_published").on(
      table.sourceId,
      table.suppressed,
      table.publishedAt,
    ),
    index("idx_releases_fetched_at").on(table.fetchedAt),
  ],
);

export const usageLog = sqliteTable("usage_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  operation: text("operation").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  sourceSlug: text("source_slug"),
  releaseCount: integer("release_count"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const fetchLog = sqliteTable("fetch_log", {
  id: text("id").primaryKey().$defaultFn(newFetchLogId),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  sessionId: text("session_id"),
  releasesFound: integer("releases_found").notNull(),
  releasesInserted: integer("releases_inserted").notNull(),
  durationMs: integer("duration_ms"),
  status: text("status", { enum: ["success", "error", "no_change", "dry_run"] }).notNull(),
  error: text("error"),
  rawContent: text("raw_content"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("idx_fetch_log_source").on(table.sourceId),
  index("idx_fetch_log_created").on(table.createdAt),
  index("idx_fetch_log_session").on(table.sessionId),
]);

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

export const ignoredUrls = sqliteTable("ignored_urls", {
  id: text("id").primaryKey().$defaultFn(newIgnoredUrlId),
  url: text("url").notNull(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  reason: text("reason"),
  ignoredAt: text("ignored_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  uniqueIndex("idx_ignored_urls_org_url").on(table.orgId, table.url),
]);

export const blockedUrls = sqliteTable("blocked_urls", {
  id: text("id").primaryKey().$defaultFn(newBlockedUrlId),
  pattern: text("pattern").notNull().unique(),
  type: text("type", { enum: ["exact", "domain"] }).notNull().default("exact"),
  reason: text("reason"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
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
    generatedAt: text("generated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_summaries_unique").on(table.sourceId, table.orgId, table.type, table.year, table.month),
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
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
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
    generatedAt: text("generated_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_knowledge_pages_scope_org").on(table.scope, table.orgId),
    uniqueIndex("idx_knowledge_pages_scope_product").on(table.scope, table.productId),
    index("idx_knowledge_pages_scope").on(table.scope),
  ],
);

export type KnowledgePage = typeof knowledgePages.$inferSelect;
export type NewKnowledgePage = typeof knowledgePages.$inferInsert;

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
    fetchedAt: text("fetched_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("scf_source_path_uq").on(table.sourceId, table.path),
    index("idx_scf_source").on(table.sourceId),
  ],
);

export type SourceChangelogFile = typeof sourceChangelogFiles.$inferSelect;
export type NewSourceChangelogFile = typeof sourceChangelogFiles.$inferInsert;

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
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
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
