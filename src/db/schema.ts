import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { newSourceId, newReleaseId, newOrgId, newOrgAccountId, newFetchLogId } from "../lib/id.js";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey().$defaultFn(newOrgId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  domain: text("domain").unique(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
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
  type: text("type", { enum: ["github", "scrape", "feed"] }).notNull(),
  url: text("url").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
  metadata: text("metadata").default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  lastFetchedAt: text("last_fetched_at"),
  lastContentHash: text("last_content_hash"),
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
    publishedAt: text("published_at"),
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
  status: text("status", { enum: ["success", "error", "no_change"] }).notNull(),
  error: text("error"),
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
