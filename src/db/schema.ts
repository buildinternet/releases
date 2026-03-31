import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { newSourceId, newReleaseId, newOrgId, newOrgAccountId, newFetchLogId, newIgnoredUrlId, newBlockedUrlId, newSummaryId } from "../lib/id.js";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey().$defaultFn(newOrgId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  domain: text("domain").unique(),
  description: text("description"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  metadata: text("metadata").default("{}"),
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

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey().$defaultFn(newSourceId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  type: text("type", { enum: ["github", "scrape", "feed", "agent"] }).notNull(),
  url: text("url").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
  metadata: text("metadata").default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  lastFetchedAt: text("last_fetched_at"),
  lastContentHash: text("last_content_hash"),
  fetchPriority: text("fetch_priority", { enum: ["normal", "low", "paused"] }).default("normal"),
  consecutiveNoChange: integer("consecutive_no_change").default(0),
  consecutiveErrors: integer("consecutive_errors").default(0),
  nextFetchAfter: text("next_fetch_after"),
  isPrimary: integer("is_primary", { mode: "boolean" }).default(false),
}, (table) => [
  index("idx_sources_org").on(table.orgId),
]);

export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey().$defaultFn(newReleaseId),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    version: text("version"),
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
  },
  (table) => [
    uniqueIndex("idx_releases_source_url").on(table.sourceId, table.url),
    uniqueIndex("idx_releases_source_hash").on(table.sourceId, table.contentHash),
    index("idx_releases_source_published").on(table.sourceId, table.publishedAt),
    index("idx_releases_published").on(table.publishedAt),
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
export type FetchLog = typeof fetchLog.$inferSelect;
export type NewFetchLog = typeof fetchLog.$inferInsert;

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
