import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Generic site-level key/value store. Worker-local schema island (sibling of
 * schema-follows.ts / schema-digest-prefs.ts), deliberately NOT in the
 * published `@buildinternet/releases-core` schema — operator-only config the
 * OSS CLI has no business with. Queried via explicit `.select().from(siteSettings)`
 * on a `createDb(...)` handle.
 *
 * One row per key; the only key today is `site_notice`. `updated_at` is the
 * last-write time in epoch ms (mode "timestamp_ms" → Date in JS).
 *
 * Paired migration: 20260611000000_add_site_settings.sql.
 */
export const siteSettings = sqliteTable("site_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SiteSetting = typeof siteSettings.$inferSelect;
