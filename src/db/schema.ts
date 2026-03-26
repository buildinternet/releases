import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { newSourceId, newReleaseId } from "../lib/id.js";

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey().$defaultFn(newSourceId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  type: text("type", { enum: ["github", "scrape"] }).notNull(),
  url: text("url").notNull(),
  metadata: text("metadata").default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  lastFetchedAt: text("last_fetched_at"),
  lastContentHash: text("last_content_hash"),
});

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

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Release = typeof releases.$inferSelect;
export type NewRelease = typeof releases.$inferInsert;
export type UsageLog = typeof usageLog.$inferSelect;
export type NewUsageLog = typeof usageLog.$inferInsert;
